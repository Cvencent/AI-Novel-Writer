import { describe, expect, it } from 'vitest'
import { runningChapters } from '../stage-progress'

const keys = ['chapter:5', 'chapter:6', 'chapter:7', 'novel-config']

describe('runningChapters', () => {
  it('单章写作声明的章都算在写', () => {
    expect([...runningChapters([{ type: 'chapter_creation', currentStepIndex: 2, resourceKeys: ['chapter:3'] }])]).toEqual([3])
  })

  it('批量创作只有当前步骤那一章在写，其余排队的不算', () => {
    expect([...runningChapters([{ type: 'batch_generate', currentStepIndex: 0, resourceKeys: keys }])]).toEqual([5])
    expect([...runningChapters([{ type: 'batch_generate', currentStepIndex: 2, resourceKeys: keys }])]).toEqual([7])
  })
})
