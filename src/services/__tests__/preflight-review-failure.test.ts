import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LLMResponse } from '../../shared/ipc-channels'
import { useLLMStore } from '../../stores/llm-store'
import { reviewEvidenceShapes } from '../preflight-repair'
import type { ProjectSessionContext } from '../../shared/ipc-channels'

/**
 * issue #203：核对失败必须**变成返回值**，不能变成没人接的异常。
 *
 * 现场：点「核对物证形态」等到 305 秒，通道 504。`generate()` 的失败路径是**抛异常**
 * （`requireIpcSuccess(response, '模型生成')`），而 13 个 `review*` 函数都只判断了
 * `if (!response.success)`（那条分支根本没被执行过）。异常穿过 review*、穿过按钮的
 * `try`，被 `finally` 吞掉 → 进度行消失、卡片 41→41、弹层一个字都没多：
 * **失败与「查过了没问题」在界面上长得一模一样**。
 *
 * 这里钉住契约本身：抛异常 → `{ status: 'failed', error }`；
 * 返回 `success: false` → 同样。两条都要让调用方的 `if (outcome.status === 'failed')` 跑到。
 */
const session: ProjectSessionContext = { projectId: 'novel', leaseId: 'lease', projectPath: 'C:/novel' } as ProjectSessionContext
const original = useLLMStore.getState().generate
type Generate = typeof original
/** 只关心「返回什么/抛什么」，参数照签名声明，避免类型漂移。 */
const stubGenerate = (impl: () => Promise<LLMResponse>) => vi.fn<Generate>(async () => impl())

afterEach(() => {
  useLLMStore.setState({ generate: original })
  vi.restoreAllMocks()
})

const chapters = [{ chapterNumber: 63, content: '外廊的灯点到第三盏。送检袋压在镇纸底下。' }]

describe('核对调用失败要落成返回值 (issue #203)', () => {
  it('turns a thrown provider error into a failed outcome instead of letting it escape', async () => {
    useLLMStore.setState({
      generate: stubGenerate(async () => { throw new Error('API 调用失败 (504): provider kept the connection alive without answering') }),
    })
    const outcome = await reviewEvidenceShapes(session, chapters, [], 'zh-CN')
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('504')
    // 失败时绝不能返回空 findings 冒充「查过了没问题」。
    expect(outcome.findings).toEqual([])
  })

  it('turns a non-success response into the same failed outcome', async () => {
    useLLMStore.setState({
      generate: stubGenerate(async () => ({ success: false, content: '', finishReason: 'error', error: '模型调用失败：连接被拒' })),
    })
    const outcome = await reviewEvidenceShapes(session, chapters, [], 'zh-CN')
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('连接被拒')
  })

  it('still reports failure when the thrown error carries no message', async () => {
    // 真实链路里偶尔抛出非 Error 或空消息；此时必须给一句人话，不能给空串。
    useLLMStore.setState({ generate: stubGenerate(async () => { throw new Error('') }) })
    const outcome = await reviewEvidenceShapes(session, chapters, [], 'zh-CN')
    expect(outcome.status).toBe('failed')
    expect(outcome.error?.trim()).toBeTruthy()
  })

  it('keeps the success path untouched (a parsed review still yields findings)', async () => {
    useLLMStore.setState({
      generate: stubGenerate(async () => ({ success: true, content: JSON.stringify({ issues: [] }), finishReason: 'stop' })),
    })
    const outcome = await reviewEvidenceShapes(session, chapters, [], 'zh-CN')
    expect(outcome.status).toBe('ok')
  })
})