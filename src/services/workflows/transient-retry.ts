/**
 * 上游瞬时失败（断网 / 连接被掐断 / 上游 5xx）的**有限退避重试**（issue #85）。
 *
 * 报告实测：`GENERATION_PROVIDER_FAILED` 在**四个链路**上出现（定稿后处理 / 细纲 /
 * 审稿 / 起草），而其中**只有细纲那条**有重试——细纲走的是架构工作流，
 * 它的四个步骤各自被 `withTransientRetry` 包住；起草 / 审稿 / 定稿走的是章节工作流，
 * 步骤执行器**没有任何传输重试**。于是同一次网络抖动，细纲能自己扛过去，
 * 起草却在第一步就整章失败（报告里 id=234 是 9 秒失败，那一章因此没写出来）。
 *
 * 为什么重试放在**工作流层**而不是命令内部（`callLLMResult`）：仓库既有分工就是这样，
 * 而且 `arc-outline-retry.test.ts` 明确断言「传输码是工作流层的事，命令层不重试」。
 * 命令层若也重试，架构工作流里那四个已经被包住的步骤会**嵌套重试**（2×2 次），
 * 既放大等待又让日志难以理解。所以这个判据只在这里有一份，两处工作流共用。
 *
 * 判据是**错误码**不是文案：命令层把主进程归类的传输码以 `[CODE]` 追在消息尾部
 * （见 `base-command.callLLMResult` 的 catch），非主进程拥有的运行时统一给
 * `GENERATION_PROVIDER_FAILED`。内容类失败（输出撞顶、合同拒绝）绝不重试——
 * 重发同一个请求只会再撞一次。
 */

/** 纯传输失败的有限重试次数。2 次 + 线性退避最多多等 4.5 秒，不会让作者白等太久。 */
export const TRANSIENT_RETRY_LIMIT = 2
/** 上游 5xx 多为瞬时抖动，重试前线性退避，避免立刻再撞同一个故障。 */
export const TRANSIENT_RETRY_BACKOFF_MS = 1_500

/** 可重试的传输失败码：主进程归类，或命令层为非主进程运行时补的兜底码。 */
const TRANSIENT_CODES = ['NETWORK_ERROR', 'GENERATION_PROVIDER_FAILED'] as const

/** 这条错误是不是「没有产出的传输失败」。只认码，不认自由文案。 */
export function isTransientTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  // 命令层以 `[CODE]` 追加；直接抛出的码（error.code）也认。
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof code === 'string' && (TRANSIENT_CODES as readonly string[]).includes(code)) return true
  return TRANSIENT_CODES.some(candidate => message.includes(`[${candidate}]`))
}

export interface TransientRetryOptions {
  /** 最多重试几次（不含首次）。默认 `TRANSIENT_RETRY_LIMIT`。 */
  limit?: number
  /** 第 n 次重试前的等待毫秒数（线性）。默认 `TRANSIENT_RETRY_BACKOFF_MS * n`。 */
  backoffMs?: (attempt: number) => number
  /** 作者取消后立刻停止重试：取消是意图，不是故障。 */
  isCancelled?: () => boolean
}

/**
 * 跑一次可能遭遇瞬时传输失败的操作，失败时有限退避重试。
 *
 * 非传输失败（内容类 / 合同类）**原样抛出**——重试对它们没有意义。
 */
export async function withTransientRetry<T>(
  run: () => Promise<T>,
  log: (line: string) => void,
  options: TransientRetryOptions = {},
): Promise<T> {
  const limit = options.limit ?? TRANSIENT_RETRY_LIMIT
  const backoff = options.backoffMs ?? (attempt => TRANSIENT_RETRY_BACKOFF_MS * attempt)
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (options.isCancelled?.()) throw error
      if (!isTransientTransportError(error) || attempt >= limit) throw error
      log(`与模型的连接中断（上游瞬时故障），正在重试（第 ${attempt + 1} 次，最多 ${limit} 次）…`)
      await new Promise(resolve => setTimeout(resolve, backoff(attempt + 1)))
    }
  }
}