/**
 * 渲染进程崩溃后的处理策略（issue #152）——**纯判定，不碰 Electron**。
 *
 * ## 现场
 *
 * 审稿并定稿第 25 章：审稿撞顶 257 秒 → 触发救援重建 `review-chapter-rebuild` →
 * **重建刚启动，页面崩了**（`Page crashed` / `GPU process exited unexpectedly: exit_code=143`）。
 * 两轮实测（跨版本、跨安装）失败点与错误码完全一致，不是偶发。
 *
 * 崩溃之后的状态是：**主进程里的生成还在跑，界面没了**。作者只能重开应用，
 * 而重开后看不到「刚才那次审稿其实已经跑到重建了」——只能从头再等一次 400 秒。
 *
 * ## 这一层能做什么（这里刻意只做「能断言」的部分）
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 崩溃原因分类、要不要自动恢复、恢复几次、给用户看什么 | **本模块（纯函数）** |
 * | 真正 reload 窗口、弹对话框、记日志 | `main.ts`（薄壳，只转调） |
 * | 「这次生成还要不要继续」 | **不在这一层**：生成属于主进程，崩溃不影响它 |
 *
 * ⚠️ **不自动恢复的两类**：
 * - `oom`（内存不足）：自动重载会立刻再崩一次，把作者困在崩溃循环里；
 * - 连续崩溃达上限：第二次 reload 后还是崩，说明不是一次性故障，再重载就是刷屏。
 *
 * ⚠️ **退出中的崩溃**（`reason === 'killed'` 或应用正在退出）不处理：那时窗口正在销毁，
 * 弹对话框或 reload 会和退出流程打架（本仓已有「退出中不要触发确认框」的先例）。
 */

/** Electron 的 `render-process-gone` 给出的 reason（原样透传）。 */
export type RenderGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | (string & {})

export interface RenderCrashInput {
  reason: RenderGoneReason
  /** Electron 给的退出码（可能为 undefined）。 */
  exitCode?: number
  /** 应用是否正在退出（`app.isQuitting` / before-quit 之后）。 */
  appQuitting: boolean
  /** 这个窗口在本进程内已经自动恢复过几次。 */
  recoveryCount: number
}

export type RenderCrashDecision =
  /** 不做任何事（正常退出、应用正在退、或这个 reason 不该恢复）。 */
  | { action: 'ignore'; why: 'quitting' | 'clean-exit' | 'killed' }
  /** 自动重载渲染进程（一次），并记录一次恢复。 */
  | { action: 'reload'; why: 'transient' }
  /** 不自动重载，改为提示作者重开（附带原因与「下一步能接着做」的信息）。 */
  | { action: 'notify'; why: 'out-of-memory' | 'launch-failed' | 'integrity-failure' | 'recovery-exhausted' }

/**
 * 自动恢复的**次数上限**（同一个窗口同一个进程内）。
 *
 * 取 1：第一次崩多半是**一次性**的（GPU TDR、显卡驱动复位——实测这台机器周期性发生），
 * 重载一次通常就回来了；第二次还崩就说明是可复现的故障，自动重载只会让作者看到
 * 「刚回来又崩了」，比直接告诉他「重开应用」更糟。
 */
export const RENDER_CRASH_RECOVERY_LIMIT = 1

/** 这个 reason 是否是「一次性的、值得重载一次试试」的那一类。 */
function isTransientRenderFailure(reason: RenderGoneReason): boolean {
  // abnormal-exit / crashed：进程被打断或崩掉，但没有明确的资源耗尽/启动失败信号。
  // 实测现场（GPU TDR 之后的 renderer 崩溃）落在这里。
  return reason === 'abnormal-exit' || reason === 'crashed'
}

/**
 * 决定崩溃后怎么办。
 *
 * 顺序有讲究：**先判退出**，再判 reason。退出中的 `crashed` 不该弹框
 * （作者已经点了关闭，弹出来只会挡住退出）。
 */
export function decideRenderCrash(input: RenderCrashInput): RenderCrashDecision {
  if (input.appQuitting) return { action: 'ignore', why: 'quitting' }
  if (input.reason === 'clean-exit' || input.reason === 'killed') {
    return { action: 'ignore', why: input.reason === 'killed' ? 'killed' : 'clean-exit' }
  }
  if (input.reason === 'oom') return { action: 'notify', why: 'out-of-memory' }
  if (input.reason === 'launch-failed') return { action: 'notify', why: 'launch-failed' }
  if (input.reason === 'integrity-failure') return { action: 'notify', why: 'integrity-failure' }
  if (input.recoveryCount >= RENDER_CRASH_RECOVERY_LIMIT) return { action: 'notify', why: 'recovery-exhausted' }
  if (!isTransientRenderFailure(input.reason)) return { action: 'notify', why: 'launch-failed' }
  return { action: 'reload', why: 'transient' }
}

/**
 * 提示文案（中英由调用方选）。**不出现内部错误码之外的技术词**，
 * 并明确写清「生成在主进程，重开后可以去运行侧页接着处理」——
 * 作者在崩溃现场最需要知道的是「我刚才那 400 秒白等了吗」。
 */
export function renderCrashMessage(
  decision: RenderCrashDecision,
  language: 'zh-CN' | 'en-US',
): { title: string, body: string } {
  const en = language === 'en-US'
  if (decision.action !== 'notify') return { title: '', body: '' }
  const reasonLine = en
    ? {
      'out-of-memory': 'The interface ran out of memory.',
      'launch-failed': 'The interface process failed to start again.',
      'integrity-failure': 'The interface files failed an integrity check.',
      'recovery-exhausted': 'The interface crashed again after being restored once.',
    }[decision.why]
    : {
      'out-of-memory': '界面进程内存不足。',
      'launch-failed': '界面进程启动失败。',
      'integrity-failure': '界面文件没有通过完整性校验。',
      'recovery-exhausted': '界面恢复一次之后又崩了。',
    }[decision.why]
  return en
    ? {
      title: 'The window closed unexpectedly',
      body: `${reasonLine} The writing or review you started runs in the background process, so it was not lost — reopen the app and check the run panel to continue from where it stopped.`,
    }
    : {
      title: '窗口意外关闭',
      body: `${reasonLine} 你刚才启动的写作或审稿在后台进程里继续跑，**没有丢**——重开应用后到运行侧页看这一步的结果，从断的地方接着处理。`,
    }
}