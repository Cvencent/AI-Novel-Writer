import { describe, expect, it } from 'vitest'

import {
  activeChapterRunKey,
  diagnosticRunsKey,
  runCapsuleKey,
  type WorkflowRun,
  type WorkflowStep,
} from '../workflow-store'

/**
 * issue #104 ③ 的回归判据。
 *
 * 缺陷形态：生成期间流式文本每 100ms 换一次 `step.result`，而 `updateStepById` 每次都
 * `map` 出**新的 `activeRuns` 数组**。任何 `useWorkflowStore(s => s.activeRuns)` 的订阅者
 * 因此以 10Hz 重渲染——打字面（`use-draft-actions`）与常驻顶栏（`RunCapsule`）都在其中，
 * 用户看到的就是「生成期间切页打字严重卡顿」。
 *
 * 修法：这些订阅者改为 **纯投影选择器**（返回原始值/字符串 Key，按 `Object.is` 比较）。
 * 所以判据是：**只改 `step.result`，这些投影的返回值必须逐字不变**；
 * 而真正该刷新的字段（步骤状态、进度、等待态）变化时必须变。
 *
 * ⚠️ 这些断言在旧实现（直接返回 `s.activeRuns` 数组）上会红：数组每次都是新对象，
 * 引用相等断言失败。用它保证「不重渲染」这条性能语义不会再被写回去。
 */
const NOW = '2026-11-03T00:00:00.000Z'

function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 's1', name: '写这一章', description: '', status: 'running', progress: 40,
    result: '', logs: [], startedAt: NOW, ...overrides,
  }
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1', projectPath: 'F:/proj', projectSession: null,
    writingLanguage: 'zh-CN', uiLocale: 'zh-CN', type: 'chapter_creation',
    title: '写第 5 章', status: 'running', steps: [step()], currentStepIndex: 0,
    createdAt: NOW, resourceKeys: ['chapter:5'],
    ...overrides,
  }
}

/** 模拟一次「流式追加」：只换 `step.result`，其余字段全部保持引用相同。 */
function withStreamedResult(base: WorkflowRun, text: string): WorkflowRun {
  return { ...base, steps: base.steps.map(s => ({ ...s, result: text })) }
}

describe('流式正文不触发订阅者重渲染（issue #104 ③）', () => {
  it('activeChapterRunKey 只随「占用关系」变化，不随 step.result 变化', () => {
    const before = run()
    const after = withStreamedResult(before, '正文'.repeat(200))
    expect(activeChapterRunKey([after], 'F:/proj', 5)).toBe(activeChapterRunKey([before], 'F:/proj', 5))
    // 占用出现/消失时**必须**变（否则「本章忙不忙」会失效）。
    expect(activeChapterRunKey([], 'F:/proj', 5)).toBe('')
    expect(activeChapterRunKey([before], 'F:/proj', 5)).toBe('run-1')
    expect(activeChapterRunKey([before], 'F:/proj', 6)).toBe('')
    expect(activeChapterRunKey([before], 'F:/other', 5)).toBe('')
  })

  it('runCapsuleKey 不随 step.result 变化，但随步骤状态与进度整数百分比变化', () => {
    const before = run()
    const after = withStreamedResult(before, '正文'.repeat(200))
    expect(runCapsuleKey([after], [], 'F:/proj')).toBe(runCapsuleKey([before], [], 'F:/proj'))
    // 进度从 40% → 60%：胶囊要跟着动，投影**不能**把它吞掉。
    const progressed = { ...before, steps: [{ ...step(), progress: 60 }] }
    expect(runCapsuleKey([progressed], [], 'F:/proj')).not.toBe(runCapsuleKey([before], [], 'F:/proj'))
    // 步骤完成同样要变。
    const completed = { ...before, steps: [{ ...step(), status: 'completed' as const }] }
    expect(runCapsuleKey([completed], [], 'F:/proj')).not.toBe(runCapsuleKey([before], [], 'F:/proj'))
    // 等确认态要变。
    expect(runCapsuleKey([{ ...before, status: 'waiting' }], [], 'F:/proj')).not.toBe(runCapsuleKey([before], [], 'F:/proj'))
  })

  it('diagnosticRunsKey 不随 step.result 变化，但随步骤时间/状态变化', () => {
    const before = run()
    const after = withStreamedResult(before, '正文'.repeat(200))
    expect(diagnosticRunsKey([after])).toBe(diagnosticRunsKey([before]))
    expect(diagnosticRunsKey([{ ...before, steps: [{ ...step(), completedAt: NOW }] }]))
      .not.toBe(diagnosticRunsKey([before]))
    expect(diagnosticRunsKey([])).toBe('')
  })

  it('the three projections stay primitive (Object.is comparable) — not arrays/objects', () => {
    // 这条是修法的**核心不变量**：选择器必须返回原始值。返回数组/对象的话
    // 每次 store 更新都会是新引用，`Object.is` 失效 → 订阅者照样 10Hz 重渲染。
    const sample = run()
    for (const value of [
      activeChapterRunKey([sample], 'F:/proj', 5),
      runCapsuleKey([sample], [], 'F:/proj'),
      diagnosticRunsKey([sample]),
    ]) expect(typeof value).toBe('string')
  })
})