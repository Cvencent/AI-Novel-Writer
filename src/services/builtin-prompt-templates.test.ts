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

// issue #35：只有 suspenseHook 有下游通道，上一章正文里的其他悬置承诺没人接。
describe('predecessor commitment rules (issue #35)', () => {
  const full = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint')
  const chunk = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint_chunk')

  it('both blueprint templates require carrying over non-hook pending commitments', () => {
    expect(full?.content).toContain('【前驱承诺必须接】')
    expect(chunk?.content).toContain('【前驱承诺必须接】')
    expect(full?.content).toContain('搁置了什么')
  })

  it('the immutable contract states it too', () => {
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('钩子以外的悬置承诺也要接')
  })
})

// issue #38：关键道具凭空换手（第 15 章被拒交的油纸包，第 16 章从主角怀里掏出来）。
describe('prop handoff rules (issue #38)', () => {
  const full = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint')
  const chunk = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint_chunk')

  it('both blueprint templates require an on-page handoff for key objects', () => {
    expect(full?.content).toContain('【关键道具必须当面易手】')
    expect(chunk?.content).toContain('【关键道具必须当面易手】')
    expect(full?.content).toContain('从怀里摸出')
  })

  it('the chapter review prompt has a prop-handoff dimension', () => {
    const review = BUILTIN_PROMPTS.find(template => template.key === 'consistency_check')
    expect(review?.content).toContain('道具交接')
    expect(review?.content).toContain('没有交接动作的情况下换了持有者')
  })
})

// issue #222 / #223：同章道具自相矛盾的另外两种形状（互斥处置 / 载体不点名）。
// #222：bp99 把「收下旁证却说不能入卷」压进同一句，随后「跟着卷走」；
// #223：bp31「夹进收料簿页缝」后「翻页时掉出」——翻的是折子，载体没点名。
describe('intra-chapter disposition and carrier rules (issue #222 / #223)', () => {
  const full = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint')
  const chunk = BUILTIN_PROMPTS.find(template => template.key === 'chapter_blueprint_chunk')
  const review = BUILTIN_PROMPTS.find(template => template.key === 'consistency_check')

  it('both blueprint templates forbid refuse-then-accept without lifting the obstacle', () => {
    expect(full?.content).toContain('拒绝收下某物或声明它「没有 X 不能入卷」')
    expect(full?.content).toContain('只作附卷')
    expect(chunk?.content).toContain('拒绝收下某物或声明它「没有 X 不能入卷」')
    expect(chunk?.content).toContain('只作附卷')
  })

  it('both blueprint templates require the carrier to be named when a paper falls out', () => {
    expect(full?.content).toContain('两份不同的簿册各自都装着它而中间没有挪动动作，是矛盾')
    expect(chunk?.content).toContain('两份不同的簿册各自都装着它而中间没有挪动动作，是矛盾')
  })

  it('the review prop-handoff dimension also asks about the carrier', () => {
    expect(review?.content).toContain('换了持有者或所在载体')
    expect(review?.content).toContain('两份不同的簿册/文书/容器里，而两次之间没有任何取出或放入的动作')
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

// issue #47：票号编号体系四章四种写法 + 同句「编号五位，零三一七」位数矛盾。
describe('numbering coherence dimension (issue #47)', () => {
  it('the chapter review prompt checks pervasive numbering against itself', () => {
    const review = BUILTIN_PROMPTS.find(template => template.key === 'consistency_check')
    expect(review?.content).toContain('贯穿性编号')
    expect(review?.content).toContain('位数')
    expect(review?.content).toContain('区间')
  })
})

// issue #52：第 16 章断言「是叶九的手」，第 19 章断言「不是」——结论反转必须要求核验过程。
describe('conclusion reversal dimension (issue #52)', () => {
  it('the chapter review prompt asks for the verification behind a reversed conclusion', () => {
    const review = BUILTIN_PROMPTS.find(template => template.key === 'consistency_check')
    expect(review?.content).toContain('结论反转')
    expect(review?.content).toContain('推翻前一次读法的核验过程')
    expect(review?.content).toContain('若正文已写出核验过程，则不报')
  })
})

// issue #51：核心能力「每班次只用一次」被自己作废，必须有维度问「是否超出已声明上限」。
describe('ability budget dimension (issue #51)', () => {
  it('the chapter review prompt checks ability use against stated limits', () => {
    const review = BUILTIN_PROMPTS.find(template => template.key === 'consistency_check')
    expect(review?.content).toContain('能力上限')
    expect(review?.content).toContain('用尽／只剩一次／再读不出')
    expect(review?.content).toContain('若正文已写出恢复条件，则不报')
  })
})
