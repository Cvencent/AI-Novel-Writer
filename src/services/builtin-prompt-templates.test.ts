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
