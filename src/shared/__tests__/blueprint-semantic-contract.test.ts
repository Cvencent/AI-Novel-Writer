import { describe, expect, it } from 'vitest'

import {
  BLUEPRINT_CLOSING_SHOT_TYPES,
  closingShotOf,
  stagingOf,
  decodeBlueprintSemanticPayload,
  blueprintSemanticGenerationContract,
  parseBlueprintSemanticResponseText,
  validateBlueprintSemanticItem,
} from '../blueprint-semantic-contract'
import { StructuredContractDiagnostic } from '../structured-contract-diagnostic'

function validBlueprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const chapterNumber = typeof overrides.chapterNumber === 'number' ? overrides.chapterNumber : 1
  return {
    chapterNumber,
    title: `雨夜来信${chapterNumber}`,
    role: '开篇建置',
    purpose: '让主角接下无法回避的委托',
    keyEvents: '主角收到失踪多年的兄长寄来的密信，并在信封夹层发现追踪器。',
    characters: ['林岚', '周砚'],
    relationships: [{ from: '林岚', to: '周砚', relation: '临时盟友' }],
    suspenseHook: '追踪器忽然亮起，显示信件刚从屋内发出。', costsAndTurns: '代价：暴露了追踪器。', foreshadowing: '信件来源线。',
    ...overrides,
  }
}

describe('blueprint semantic contract', () => {
  it('decodes one complete blueprint and preserves its structured relationship facts', () => {
    expect(decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint()] },
      [1],
    )).toEqual([{
      chapterNumber: 1,
      title: '雨夜来信1',
      role: '开篇建置',
      purpose: '让主角接下无法回避的委托',
      keyEvents: '主角收到失踪多年的兄长寄来的密信，并在信封夹层发现追踪器。',
      characters: ['林岚', '周砚'],
      newCharacterCandidates: [],
      relationshipHints: [{ from: '林岚', to: '周砚', relation: '临时盟友' }],
      suspenseHook: '追踪器忽然亮起，显示信件刚从屋内发出。', costsAndTurns: '代价：暴露了追踪器。', foreshadowing: '信件来源线。',
    }])
  })

  it('accepts one direct or fenced JSON root but rejects narrative prefix extraction', () => {
    const payload = JSON.stringify({ blueprints: [validBlueprint()] })
    expect(parseBlueprintSemanticResponseText(payload, [1])).toHaveLength(1)
    expect(parseBlueprintSemanticResponseText(`\`\`\`json\n${payload}\n\`\`\``, [1])).toHaveLength(1)
    expect(() => parseBlueprintSemanticResponseText(`以下是结果：\n${payload}`, [1]))
      .toThrow(/code=invalid_envelope path=\$/u)
    expect(() => parseBlueprintSemanticResponseText(`${payload}\n补充说明`, [1]))
      .toThrow(/code=invalid_json path=\$/u)
  })

  it.each([
    ['title', '标题'],
    ['role', '章节功能'],
    ['purpose', '核心目的'],
    ['keyEvents', '关键事件'],
    ['characters', '出场角色'],
    ['relationships', '角色关系'],
    ['suspenseHook', '悬念钩子'],
  ])('rejects a missing %s field instead of synthesizing a default', (field) => {
    const incomplete = validBlueprint()
    delete incomplete[field]

    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [incomplete] },
      [1],
    )).toThrow(`code=missing_field path=blueprints[0].${field}`)
  })

  it.each([
    ['relationships', undefined, 'missing_field', 'blueprints[0].relationships'],
    ['characters', '林岚、周砚', 'invalid_type', 'blueprints[0].characters'],
    ['role', { label: '发展' }, 'invalid_type', 'blueprints[0].role'],
    ['keyEvents', ' ', 'empty_value', 'blueprints[0].keyEvents'],
    ['suspenseHook', undefined, 'missing_field', 'blueprints[0].suspenseHook'],
  ])('reports a sanitized typed diagnostic for likely model shape at %s', (field, value, code, path) => {
    const candidate = validBlueprint()
    if (value === undefined) delete candidate[field]
    else candidate[field] = value

    const failure = (() => {
      try {
        decodeBlueprintSemanticPayload({ blueprints: [candidate] }, [1])
        return null
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(StructuredContractDiagnostic)
    expect(failure).toMatchObject({ code, path, field })
    expect((failure as Error).message).not.toContain(JSON.stringify(value))
  })

  it('requires at least one valid, unique character name', () => {
    expect(validateBlueprintSemanticItem(validBlueprint({ characters: [] })))
      .toContain('code=invalid_value path=blueprint.characters')
    expect(validateBlueprintSemanticItem(validBlueprint({ characters: ['林岚', ' 林岚 '] })))
      .toContain('code=duplicate_item path=blueprint.characters')
  })

  it('accepts long narrative fields and full names, thirteen characters and candidates, and nine distinct relations', () => {
    const longName = '亚历山德拉'.repeat(7) + '完整姓名尾部'
    const characters = [longName, ...Array.from({ length: 12 }, (_, index) => `角色${index}`)]
    const candidate = validBlueprint({ title: '题'.repeat(500), role: 'r'.repeat(500), purpose: 'p'.repeat(1000),
      keyEvents: '事'.repeat(2000), suspenseHook: '悬'.repeat(1000), costsAndTurns: '代价。', foreshadowing: '伏笔。', characters,
      newCharacterCandidates: characters.map(name => ({ name, role: 'supporting' })),
      relationships: characters.slice(1, 10).map(to => ({ from: characters[0], to, relation: '同行' })),
    })
    expect(decodeBlueprintSemanticPayload([candidate], [1])[0]).toMatchObject({
      title: candidate.title, role: candidate.role, purpose: candidate.purpose, keyEvents: candidate.keyEvents,
      suspenseHook: candidate.suspenseHook, costsAndTurns: candidate.costsAndTurns, foreshadowing: candidate.foreshadowing, characters, newCharacterCandidates: candidate.newCharacterCandidates,
      relationshipHints: candidate.relationships,
    })
    const duplicate = { from: '林岚', to: '周砚', relation: '同行' }
    expect(validateBlueprintSemanticItem(validBlueprint({ relationships: [duplicate, duplicate] }))).toContain('duplicate_item')
  })

  it('accepts an explicit empty relationship list but rejects malformed or dangling relationships', () => {
    expect(validateBlueprintSemanticItem(validBlueprint({ relationships: [] }))).toBeUndefined()
    expect(validateBlueprintSemanticItem(validBlueprint({
      relationships: [{ from: '林岚', to: '未出场者', relation: '追踪' }],
    }))).toContain('code=relationship_endpoint_not_in_characters path=blueprint.relationships[0]')
    expect(validateBlueprintSemanticItem(validBlueprint({
      relationships: [{ from: '林岚', to: '周砚', relation: '' }],
    }))).toContain('code=empty_value path=blueprint.relationships[0].relation')
  })

  it('defaults omitted candidates and validates explicit recurring candidates', () => {
    expect(decodeBlueprintSemanticPayload({ blueprints: [validBlueprint()] }, [1])[0]
      .newCharacterCandidates).toEqual([])
    expect(decodeBlueprintSemanticPayload({
      blueprints: [validBlueprint({
        newCharacterCandidates: [{ name: '周砚', role: 'supporting' }],
      })],
    }, [1])[0].newCharacterCandidates).toEqual([{ name: '周砚', role: 'supporting' }])
    expect(validateBlueprintSemanticItem(validBlueprint({
      newCharacterCandidates: [{ name: '未出场者', role: 'supporting' }],
    }))).toContain('code=invalid_value path=blueprint.newCharacterCandidates[0].name')
    expect(validateBlueprintSemanticItem(validBlueprint({
      newCharacterCandidates: [{ name: '周砚', role: 'guest-star' }],
    }))).toContain('code=invalid_value path=blueprint.newCharacterCandidates[0].role')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('一次性路人不得声明为候选')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('never include incidental figures')
  })

  it.each([
    [
      { from: '林岚', to: '林岚', relation: '内心冲突' },
      'relationship_self_reference',
    ],
    [
      { from: '林岚', to: '周砚（化名）', relation: '追踪' },
      'relationship_endpoint_not_in_characters',
    ],
  ])('reports a stable sanitized relationship diagnostic without normalizing endpoints', (relationship, code) => {
    const failure = (() => {
      try {
        decodeBlueprintSemanticPayload({
          blueprints: [validBlueprint({ relationships: [relationship] })],
        }, [1])
        return null
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(StructuredContractDiagnostic)
    expect(failure).toMatchObject({
      code,
      path: 'blueprints[0].relationships[0]',
      field: 'relationships',
    })
    expect((failure as Error).message).not.toContain(relationship.to)
  })

  it('tells generators to copy exact character endpoints and omit unsupported relations', () => {
    const contract = blueprintSemanticGenerationContract('zh-CN')
    expect(contract).toContain('from/to 必须逐字复制同一项 characters 中的完整字符串')
    expect(contract).toContain('任一端点不在 characters 时，删除该关系或使用 []')
    expect(contract).toContain('不得发明别名')
  })

  it('requires generators to emit a concrete suspense hook even without a mystery', () => {
    expect(blueprintSemanticGenerationContract('en-US'))
      .toContain('suspenseHook is always required')
    expect(blueprintSemanticGenerationContract('zh-CN'))
      .toContain('suspenseHook 始终必填')
  })

  it('keeps narrative instructions free of the retired prose and count ceilings', () => {
    for (const language of ['en-US', 'zh-CN'] as const) {
      expect(blueprintSemanticGenerationContract(language)).not.toMatch(/1,?200|900|100–150|最多 (?:12|32|80)|at most (?:12|32|80)/u)
    }
  })

  it('requires exact chapter coverage with no missing, extra, or duplicate chapter', () => {
    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint(), validBlueprint({ chapterNumber: 3 })] },
      [1, 2],
    )).toThrow(/code=unexpected_item path=blueprints/u)
    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint(), validBlueprint()] },
      [1],
    )).toThrow(/code=duplicate_item path=blueprints/u)
  })

  it('rejects two chapters sharing one title, even across the batch boundary context (issue #16)', () => {
    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint({ chapterNumber: 5, title: '待核' }), validBlueprint({ chapterNumber: 9, title: '待核' })] },
      [5, 9],
    )).toThrow(/code=duplicate_title path=blueprints.title/u)
    expect(decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint({ chapterNumber: 5, title: '待核' }), validBlueprint({ chapterNumber: 9, title: '另一次核对' })] },
      [5, 9],
    )).toHaveLength(2)
  })
})

// issue #28：收束镜头跨章同构（本样本 14 章里 9 章以「温珩站在舱门/梯口、一言不发」收尾）。
// 与 #14 代价轮换同形：合同声明轮换要求，并把最近落幅摘要交给生成侧。
describe('blueprint closing-shot rotation (issue #28)', () => {
  it('the immutable JSON contract requires rotating the closing shot', () => {
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('收束方式必须轮换')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('【收束：类型】')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('references')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('Closing shot must rotate')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('【收束：类型】')
  })

  it('closingShotOf reads the trailing label and returns the canonical type', () => {
    expect(closingShotOf('周叙按上票根，墨层浮起。【收束：物件落幅】')).toBe('物件落幅')
    expect(closingShotOf('他推门，天光洒落。【收束:对话收束】')).toBe('对话收束')
    // 取最后一个标注（模型可能中途写一次、末尾再写一次）
    expect(closingShotOf('【收束：时空切换】……他转身。【收束：内心独白】')).toBe('内心独白')
  })

  it('unknown or missing labels return empty instead of guessing', () => {
    expect(closingShotOf('没有任何标注。')).toBe('')
    expect(closingShotOf('【收束：风景描写】')).toBe('')
    expect(closingShotOf('')).toBe('')
  })

  it('the six documented types are exactly what the parser accepts', () => {
    for (const type of BLUEPRINT_CLOSING_SHOT_TYPES) {
      expect(closingShotOf(`正文。【收束：${type}】`)).toBe(type)
    }
    expect(BLUEPRINT_CLOSING_SHOT_TYPES).toHaveLength(6)
  })
})

// issue #32 / #33：场景装置与人物反应句式同样要轮换（同一套写法在相邻章反复）。
describe('blueprint staging and reaction rotation (issue #32 / #33)', () => {
  it('the immutable contract requires rotating staging and reaction wording', () => {
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('场景装置必须轮换')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('【装置：')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('人物反应必须换写法')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('没动／没答／没应')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('Staging must rotate')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('Character reactions must vary')
  })

  it('stagingOf reads the trailing label; missing labels return empty', () => {
    expect(stagingOf('周叙进舱底拧水隔。【装置：舱底＋拧水隔】')).toBe('舱底＋拧水隔')
    expect(stagingOf('【装置:码头售票口＋翻票根】他核对名册。')).toBe('码头售票口＋翻票根')
    expect(stagingOf('没有标注。')).toBe('')
    expect(stagingOf('')).toBe('')
  })
})
