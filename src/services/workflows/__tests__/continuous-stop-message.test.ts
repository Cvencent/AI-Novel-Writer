import { describe, expect, it } from 'vitest'

import { continuousStopMessage } from '../continuous-outline-runner'

// issue #29：失败原因（「粗纲还没铺满全书：覆盖到第 22 章」）在 t=10s 被通用文案整条覆盖，
// 且通用文案在 0 批时说「已完成大纲已保存」——本样本上是假话。这里锁住终止句的两种说法。
const text = (zh: string) => zh

describe('continuousStopMessage (issue #29)', () => {
  it('本次一批都没成功：不得声称「已完成大纲已保存」，要说明没生成任何章节', () => {
    const message = continuousStopMessage({
      consecutiveFailures: 3, batchesCompleted: 0, coveredChapters: 3, progressedTo: 3, totalChapters: 100, text,
    })
    expect(message).toContain('没有生成任何章节')
    expect(message).toContain('大纲仍覆盖 3 章')
    expect(message).not.toContain('已完成大纲已保存')
    expect(message).toContain('先解决上面的失败原因')
  })

  it('确实推进过：说明完成了多少章、可稍后继续', () => {
    const message = continuousStopMessage({
      consecutiveFailures: 3, batchesCompleted: 2, coveredChapters: 3, progressedTo: 23, totalChapters: 100, text,
    })
    expect(message).toContain('已完成 23 / 100 章')
    expect(message).toContain('可稍后继续')
    expect(message).not.toContain('没有生成任何章节')
  })

  it('章数没变但有过成功批次时，按「已完成 N 章」说实话（不谎报推进）', () => {
    const message = continuousStopMessage({
      consecutiveFailures: 3, batchesCompleted: 1, coveredChapters: 10, progressedTo: 10, totalChapters: 100, text,
    })
    expect(message).toContain('已完成 10 / 100 章')
    expect(message).not.toContain('没有生成任何章节')
  })
})