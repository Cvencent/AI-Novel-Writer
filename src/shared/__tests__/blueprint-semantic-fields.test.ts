import { describe, expect, it } from 'vitest'
import { BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST, blueprintSemanticGenerationContract, normalizeBlueprintSemanticItem } from '../blueprint-semantic-contract'

const base = {
  chapterNumber: 1,
  title: '读数为零',
  role: '建置',
  purpose: '弄清读数为零意味着什么',
  keyEvents: '他在检测厅被读作零，去申诉被驳回。',
  characters: ['林澈'],
  relationships: [],
  suspenseHook: '档案页角落编号是一个孤零零的 0',
  costsAndTurns: '代价：用掉当月唯一申诉额度',
  foreshadowing: '编号 0 接后文源起-0 命名空间',
}

describe('WP2b blueprint semantic fields', () => {
  it('requires costsAndTurns and foreshadowing', () => {
    expect(BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.requiredFields).toContain('costsAndTurns')
    expect(BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.requiredFields).toContain('foreshadowing')
  })
  it('normalizes the two new fields', () => {
    const item = normalizeBlueprintSemanticItem(base)
    expect(item.costsAndTurns).toBe('代价：用掉当月唯一申诉额度')
    expect(item.foreshadowing).toBe('编号 0 接后文源起-0 命名空间')
  })
  it('rejects a blueprint missing costsAndTurns', () => {
    const { costsAndTurns, ...without } = base
    void costsAndTurns
    expect(() => normalizeBlueprintSemanticItem(without)).toThrow(/costsAndTurns/u)
  })
  it('rejects a blueprint missing foreshadowing', () => {
    const { foreshadowing, ...without } = base
    void foreshadowing
    expect(() => normalizeBlueprintSemanticItem(without)).toThrow(/foreshadowing/u)
  })
  it('states both fields in the generation contract', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      const text = blueprintSemanticGenerationContract(lang)
      expect(text).toContain('costsAndTurns')
      expect(text).toContain('foreshadowing')
    }
  })
})
