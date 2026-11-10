import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * 常驻安全文件助手（issue #245）。
 *
 * 原来每个 `fs:*` 操作都新起一次 `powershell.exe -File windows-safe-file-system.ps1`：
 * 实测每次要付 **183ms 进程启动 + 210ms `Add-Type` 现场编译**，干活只占 ~1-4ms。
 * 打开作品两次文件操作就白花 ~1 秒。
 *
 * 这里把同一个 helper 脚本以 `--serve` 常驻起来，stdin/stdout 走 NDJSON：首请求付一次
 * 启动与编译（~465ms），之后每请求 **~1ms**。**安全语义完全不变**——还是同一个
 * `windows-safe-file-system.ps1`、同一段内联 C#、同一套 `OBJ_DONT_REPARSE` 校验，
 * 只去掉了「每次重新起进程 + 重新编译」。
 *
 * 生命周期：
 * - 首个请求时惰性启动；空闲 `idleTimeoutMs` 后自愿退出（避免长期占着进程）。
 * - 进程崩溃/退出时把在途请求全部判失败（**绝不放行**），下次请求重新拉起。
 * - `write` 的两阶段提交（prepare → 提交守卫 → commit）在常驻模式下串行化执行：
 *   prepare 期间整个通道被独占，别的请求排队等提交完成，不会插到准备与提交之间。
 */
export interface PersistentHelperOptions {
  /** 启动命令与参数（生产是 powershell.exe + -File <helper> + --serve）。 */
  spawnHelper: () => { command: string; args: string[] }
  /** 单次请求超时。 */
  timeoutMs: number
  /** 空闲多久后自愿退出；0 表示不主动退出。 */
  idleTimeoutMs?: number
  /** 助手不可用时的错误码，保持与一次性模式一致。 */
  unavailableCode?: string
  timeoutCode?: string
  /** 测试可注入的启动函数。 */
  spawnProcess?: (command: string, args: string[]) => ChildProcessWithoutNullStreams
}

interface PendingRequest {
  resolve: (line: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000
/** 单行响应的上限：与一次性模式的 helper 同量级（正文上限 64MB → base64 + JSON 余量）。 */
const MAX_RESPONSE_LINE_BYTES = 96 * 1024 * 1024

export class PersistentSecureFileHelper {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private buffer = ''
  private queue: PendingRequest[] = []
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** write 的两阶段提交期间，别的请求必须排队。 */
  private exclusive: Promise<void> | null = null
  private generation = 0

  constructor(private readonly options: PersistentHelperOptions) {}

  /** 常驻进程当前是否活着（测试与诊断用）。 */
  get running(): boolean {
    return this.child !== null
  }

  private failAllPending(code: string): void {
    const pending = this.queue.splice(0, this.queue.length)
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(new Error(code))
    }
    this.starting = null
  }

  private failAllWithUnavailable(): void {
    this.failAllPending(this.options.unavailableCode ?? 'SECURE_FS_HELPER_UNAVAILABLE')
  }

  private scheduleIdleExit(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const idle = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    if (idle <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.queue.length > 0) return
      this.shutdown()
    }, idle)
    // 不把空闲计时器变成事件循环的存活理由。
    this.idleTimer.unref?.()
  }

  private shutdown(): void {
    const child = this.child
    this.child = null
    this.starting = null
    this.buffer = ''
    this.generation += 1
    if (!child) return
    try { child.stdin.end() } catch { /* 已经没了 */ }
    try { child.kill() } catch { /* 已经没了 */ }
  }

  /** 主动释放：进程退出/项目关闭时调用。在途请求判失败，不放行。 */
  dispose(): void {
    this.disposed = true
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.failAllWithUnavailable()
    this.shutdown()
  }

  private attach(child: ChildProcessWithoutNullStreams, generation: number): void {
    const onChunk = (chunk: Buffer): void => {
      if (generation !== this.generation) return
      this.buffer += chunk.toString('utf8')
      if (Buffer.byteLength(this.buffer, 'utf8') > MAX_RESPONSE_LINE_BYTES) {
        // 助手回了不合理的超大响应：判整个通道失败，绝不用截断的内容。
        this.failAllWithUnavailable()
        this.shutdown()
        return
      }
      let index: number
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        if (!line) continue
        // `powershell.exe -File` 会在 stdout 顶上打一段 "Windows PowerShell / Copyright"
        // 横幅（一次性模式靠「取最后一行」侥幸绕过了它）。常驻模式必须显式跳过：
        // 只有以 `{` 开头的行才是本助手写的响应。
        if (!line.startsWith('{')) continue
        const waiter = this.queue.shift()
        if (!waiter) continue
        clearTimeout(waiter.timer)
        waiter.resolve(line)
      }
    }
    child.stdout.on('data', onChunk)
    // stderr 故意不外传：可能含主机路径或供应商诊断。排空即可。
    child.stderr.on('data', () => { /* drained */ })
    child.once('error', () => {
      if (generation !== this.generation) return
      this.shutdown()
      this.failAllWithUnavailable()
    })
    child.once('close', () => {
      if (generation !== this.generation) return
      this.shutdown()
      // 进程没了：在途请求一律失败，绝不重放（写操作重放可能重复落盘）。
      this.failAllWithUnavailable()
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return
    if (this.disposed) throw new Error(this.options.unavailableCode ?? 'SECURE_FS_HELPER_UNAVAILABLE')
    if (this.starting) return this.starting
    const generation = this.generation
    this.starting = (async () => {
      const { command, args } = this.options.spawnHelper()
      const spawnProcess = this.options.spawnProcess ?? ((cmd, argv) => spawn(cmd, argv, {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams)
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawnProcess(command, args)
      } catch {
        this.starting = null
        throw new Error(this.options.unavailableCode ?? 'SECURE_FS_HELPER_UNAVAILABLE')
      }
      this.child = child
      this.attach(child, generation)
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  /** 发一个请求并等它的一行响应（服从 timeoutMs）。 */
  private async send(request: unknown): Promise<string> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    await this.ensureStarted()
    const child = this.child
    if (!child) throw new Error(this.options.unavailableCode ?? 'SECURE_FS_HELPER_UNAVAILABLE')
    const line = JSON.stringify(request)
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时不能只丢等待者：那个请求的响应还会晚到，而响应的归属只能靠顺序，
        // 留着进程会让后一个请求错误地领到它。整个通道判故障，下次请求重新拉起。
        reject(new Error(this.options.timeoutCode ?? 'SECURE_FS_HELPER_TIMEOUT'))
        this.failAllWithUnavailable()
        this.shutdown()
      }, this.options.timeoutMs)
      timer.unref?.()
      this.queue.push({ resolve, reject, timer })
      try {
        child.stdin.write(`${line}\n`, 'utf8')
      } catch {
        const index = this.queue.findIndex(item => item.timer === timer)
        if (index >= 0) this.queue.splice(index, 1)
        clearTimeout(timer)
        reject(new Error(this.options.unavailableCode ?? 'SECURE_FS_HELPER_UNAVAILABLE'))
      }
    })
  }

  /** 语法定义的独占段，保证 write 的 prepare 与 commit 之间没有别的请求插进来。 */
  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.exclusive ?? Promise.resolve()
    let release!: () => void
    this.exclusive = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
      this.scheduleIdleExit()
    }
  }

  /** 普通单行请求（read/mkdir/exists/list）。 */
  async request(request: unknown): Promise<string> {
    return this.runExclusive(() => this.send(request))
  }

  /**
   * write 的两阶段提交：`prepare` 先取回一句响应，再执行主进程提交守卫，
   * 然后才把 `commit` 发给同一个进程。守卫抛错则退回 `cancel`。
   *
   * 提交发出之后任何失败都按 `commitState: 'unknown'` 上抛——与一次性模式的
   * `invokeBundledAtomicWrite` 同一口径：**不能把「可能已经落盘」说成没提交**。
   */
  async atomicWrite(
    prepare: unknown,
    onPrepared: () => void | Promise<void>,
  ): Promise<string> {
    return this.runExclusive(async () => {
      const readyLine = await this.send(prepare)
      const ready = parseReadyLine(readyLine)
      if (ready.ok !== true || ready.phase !== 'ready') {
        // 准备阶段就没成功：此时一定还没提交。
        throw atomicFailure(new Error(typeof ready.code === 'string' ? ready.code : 'SECURE_FS_HELPER_FAILED'), 'not_committed')
      }
      let guardError: unknown
      try {
        await onPrepared()
      } catch (error) {
        guardError = error
      }
      if (guardError !== undefined) {
        // 守卫否决：明确发 cancel，确认没有落盘，再把守卫的错误原样上抛。
        try { await this.send({ command: 'cancel' }) } catch { /* 通道故障也不改变「未提交」这一事实 */ }
        throw guardError
      }
      try {
        const finalLine = await this.send({ command: 'commit' })
        const final = parseReadyLine(finalLine)
        if (final.ok !== true) {
          throw atomicFailure(new Error(typeof final.code === 'string' ? final.code : 'SECURE_FS_HELPER_FAILED'), 'not_committed')
        }
        return finalLine
      } catch (error) {
        if (atomicCommitState(error) !== undefined) throw error
        throw atomicFailure(error, 'unknown')
      }
    })
  }
}

interface HelperReplyShape { ok?: unknown; phase?: unknown; code?: unknown }

function parseReadyLine(line: string): HelperReplyShape {
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as HelperReplyShape
  } catch { throw new Error('SECURE_FS_HELPER_INVALID_RESPONSE') }
}

/** 与 windows-safe-file-system 的 atomicWriteFailureCommitState 同构的标记。 */
function atomicFailure(cause: unknown, commitState: 'not_committed' | 'unknown'): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  Object.defineProperty(error, 'commitState', { value: commitState, enumerable: true, configurable: true })
  return error
}

function atomicCommitState(error: unknown): 'not_committed' | 'unknown' | undefined {
  if (!error || typeof error !== 'object' || !('commitState' in error)) return undefined
  const value = (error as { commitState?: unknown }).commitState
  return value === 'not_committed' || value === 'unknown' ? value : undefined
}
