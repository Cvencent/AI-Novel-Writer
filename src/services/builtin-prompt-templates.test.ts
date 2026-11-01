import { describe, expect, it } from 'vitest'

import { BUILTIN_PROMPTS } from './builtin-prompt-templates'
import { blueprintSemanticGenerationContract } from '../shared/blueprint-semantic-contract'

describe('blueprint cost rotation rules (issue #14)', () => {
  const full = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint')
  const chunk = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint_chunk')

  it('both full and chunk blueprint templates mandate adjacent-cost rotation', () => {
    expect(full?.content).toContain('【代价类型轮换】')
    expect(full?.content).toContain('不能连续两章都是「忘了某人刚说过的话」')
    expect(chunk?.content).toContain('【代价类型轮换】')
    expect(chunk?.content).toContain('上一章已付过的代价见 chapter_list 摘要')
  })

  it('the immutable JSON contract requires cost rotation against recentBlueprints', () => {
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('代价必须轮换')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('recentBlueprints 的 costs 字段')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('The cost must rotate')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('recentBlueprints')
  })
})

// issue #28：收束镜头跨章同构。与 #14 代价轮换、#20 钩子续接同一类约束写法。
describe('blueprint closing-shot rotation rules (issue #28)', () => {
  const full = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint')
  const chunk = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint_chunk')

  it('both full and chunk blueprint templates mandate closing-shot rotation', () => {
    expect(full?.content).toContain('【收束方式轮换】')
    expect(full?.content).toContain('【收束：类型】')
    expect(chunk?.content).toContain('【收束方式轮换】')
    expect(chunk?.content).toContain('【收束：类型】')
    expect(full?.content).toContain('同一个角色以同一个姿态')
  })
})

// issue #32 / #33：场景装置与人物反应句式的跨章重复。
describe('blueprint staging & reaction rotation rules (issue #32 / #33)', () => {
  const full = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint')
  const chunk = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint_chunk')

  it('both blueprint templates mandate staging and reaction rotation', () => {
    expect(full?.content).toContain('【场景装置轮换】')
    expect(full?.content).toContain('【人物反应轮换】')
    expect(chunk?.content).toContain('【场景装置轮换】')
    expect(chunk?.content).toContain('【人物反应轮换】')
  })
})

// issue #36：代价写了却被当场抹平（四次「遗忘」都在 320 字内自愈）。
describe('cost ledger rules (issue #36)', () => {
  const full = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint')
  const chunk = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint_chunk')

  it('both blueprint templates mandate that a cost leaves a ledger', () => {
    expect(full?.content).toContain('【代价必须留账】')
    expect(chunk?.content).toContain('【代价必须留账】')
    expect(full?.content).toContain('不算代价')
  })

  it('the chapter review prompt has a cost-redemption dimension', () => {
    // 审稿侧此前从不问「这笔代价是不是当场就被抹平了」，四次遗忘全部被放过。
    const review = BUILTIN_PROMPTS.find(template => template.key === 'consistency_check')
    expect(review?.content).toContain('代价兑现')
    expect(review?.content).toContain('被抹平')
  })
})

// issue #20：钩子逐章写、下一章却整章不提。模型看得到 recentBlueprints 里的 suspenseHook，
// 缺的是「必须接」这条硬约束——与代价轮换一样写进不可变合同。
describe('blueprint hook carry-over rule (issue #20)', () => {
  it('the immutable JSON contract requires addressing the previous chapter hook', () => {
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('上一章钩子必须接')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('recentBlueprints')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('搁置')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('Hook carry-over is required')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('recentBlueprints')
  })
})
