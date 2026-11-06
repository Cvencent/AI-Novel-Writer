import { describe, expect, it } from 'vitest'

import {
  BLUEPRINT_CLOSING_SHOT_TYPES,
  blueprintLabelKind,
  closingShotOf,
  stagingOf,
  decodeBlueprintSemanticPayload,
  blueprintSemanticGenerationContract,
  parseBlueprintSemanticResponseText,
  validateBlueprintSemanticItem,
  splitBlueprintLabels,
  joinBlueprintLabels,
} from '../blueprint-semantic-contract'
import { StructuredContractDiagnostic } from '../structured-contract-diagnostic'
import { timeAnchorOf } from '../chapter-time-anchor'

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

// issue #35：只有 suspenseHook 这一条通道被承诺承接；上一章正文里当众说出口的其他悬置
// 承诺（替班／交付／返回／闭嘴）整章无人提起。
describe('blueprint predecessor-commitment carry-over (issue #35)', () => {
  it('the immutable contract extends carry-over beyond the recorded hook', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('钩子以外的悬置承诺也要接')
    expect(zh).toContain('替班')
    expect(zh).toContain('明确搁置')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('Pending decisions outside the hook must also carry over')
    expect(en).toContain('take a shift')
    expect(en).toContain('defer it explicitly')
  })
})

// issue #38：关键道具没有交接账——第 15 章温珩当面拒绝交出油纸包，第 16 章直接从周叙怀里摸出来，
// 而且第 16 章蓝图自己写着「温珩推过来的」（正文里并没有这个动作）。
describe('blueprint prop handoff ledger (issue #38)', () => {
  it('the immutable contract requires an on-page handoff', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('关键道具必须当面易手')
    expect(zh).toContain('从怀里摸出')
    expect(zh).toContain('不得因为蓝图写了「某人推过来」就把物件当成本方已有')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('Key objects must change hands on the page')
    expect(en).toContain('the reader only believes what happened on the page')
  })
})

// issue #19：同一章蓝图一边让叶九收走账本，一边又让周叙溯读那一栏，
// 正文只好用「待核栏的铁页他早背下来了」圆场——读取实物被偷换成记忆复现。
describe('blueprint intra-chapter prop coherence (issue #19)', () => {
  it('the immutable contract forbids taking an object away and reading it in one chapter', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('同一章内不得自相矛盾')
    expect(zh).toContain('一边又让同一方读取或使用它')
    expect(zh).toContain('凭记忆复现')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('Never contradict yourself inside one chapter')
    expect(en).toContain('never let remembering substitute for reading the physical object')
  })
})

/**
 * issue #222 / #223：同章道具自相矛盾的另外两种形状。
 *
 * #222 现场：bp99 把「文书员**收下**旁证**却说**无实物佐证**不能入卷**」压进同一句，
 * 又写「这张纸往下跟着卷走」——起草照抄，读者读不出旁证进没进卷（那正是这场戏的目的）。
 * #223 现场：bp31 写「夹进**收料簿**页缝」，后文「骆守拙**翻页时**纸角掉出」——
 * 翻的是折子，载体没点名，纸角凭空从另一本簿册里滑出来。
 */
describe('blueprint exclusive disposition and carrier naming (issue #222 / #223)', () => {
  it('the immutable contract forbids refuse-then-accept in one chapter', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('互斥处置')
    expect(zh).toContain('中间没有任何一句解除该障碍')
    expect(zh).toContain('只作附卷不作证据')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('mutually exclusive dispositions')
    expect(en).toContain('inadmissible')
    expect(en).toContain('the reader cannot tell whether the item ever entered the file')
  })

  it('the immutable contract requires the carrier to be named when a paper falls out', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('载体必须点名')
    expect(zh).toContain('不得压成一个「翻页时」「顺手」这类两处都能指的短语')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('the carrier must be named')
    expect(en).toContain('do not compress both into one bare phrase')
  })
})

// issue #36：代价要留账——本样本四次「遗忘」代价都在同章 320 字内自愈，蓝图阶段就已
// 把「怎么找回来」写进了代价字段，起草只是执行。
describe('blueprint cost ledger (issue #36)', () => {
  it('the immutable contract forbids dissolving the cost inside the same chapter', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('代价必须留账')
    expect(zh).toContain('另一笔代价')
    // 明确禁止把「怎么找回来」写进代价字段（第 16 章蓝图原文就是这种写法）
    expect(zh).toContain('严禁把「怎么找回来」写进代价字段')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('The cost must leave a ledger')
    expect(en).toContain('another price')
    expect(en).toContain('Never write the recovery into the cost field itself')
  })
})

describe('hook pragmatic rotation (issue #66)', () => {
  it('requires the hook form to rotate instead of closing on an ultimatum every chapter', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('语用方式必须轮换')
    expect(zh).toContain('连续三章也不得都以条件/警告句收尾')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('pragmatic form must rotate')
    expect(en).toContain('three consecutive chapters must never all close on a conditional or threatening line')
  })

  it('lists concrete alternative hook forms so the model is not left guessing', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('未解的具体疑问')
    expect(zh).toContain('一件尚未解释的物证')
  })
})

describe('character entrance rotation (issue #81)', () => {
  it('requires entrances to vary instead of the same posture-plus-clothing formula', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('人物登场不得同构')
    expect(zh).toContain('姿态＋地点＋穿戴')
    // 给出可执行的替代信息，而不是只说「别重复」。
    expect(zh).toContain('他累不累')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('Entrances must not repeat')
    expect(en).toContain('posture + place + clothing')
    expect(en).toContain('whether they are tired')
  })

  // issue #82：低身起手动作（蹲/俯身/弯腰）的轮换——与 #81 的登场「穿戴」同构问题
  // 相邻但不同轴：#81 管的是「同一套姿态＋地点＋穿戴反复」，本条管的是**动作本身**
  // 被当成每场戏的固定起手（26 章里 19 章都从「某人蹲下」开始）。
  it('requires entrance *actions* to rotate, not just the clothing formula (issue #82)', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('人物进场动作必须轮换')
    expect(zh).toContain('低身姿态')
    // 给出可执行的替代动作，而不是只说「别重复」。
    expect(zh).toContain('让他站着')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('Entrance actions must rotate')
    expect(en).toContain('crouch')
    expect(en).toContain('let them stand')
  })
})

// issue #84：章级时间推进从来没被表达过——链路上没有任何一处产出时点，
// 起草契约的「同一天紧接」默认于是永远生效。这里给蓝图加一个必填的时点标注。
describe('chapter time anchor (issue #84)', () => {
  it('requires each blueprint to label when the chapter happens', () => {
    const zh = blueprintSemanticGenerationContract('zh-CN')
    expect(zh).toContain('时点必须写明')
    expect(zh).toContain('【时点：…】')
    // 要说明「不标它跨日就永远写不出来」，而不是只说「请标注」。
    expect(zh).toContain('同一天紧接')
    // 给出可执行的取值示例。
    expect(zh).toContain('次日清晨')
    const en = blueprintSemanticGenerationContract('en-US')
    expect(en).toContain('State the time anchor')
    expect(en).toContain('the next morning')
    expect(en).toContain('only place in the pipeline that produces a time anchor')
  })
})

describe('machine-read labels are separable from editable prose (issue #65)', () => {
  const keyEvents = '周叙把签收联叠进风灯罩。【收束：物件落幅】【装置：跳板口＋把笔撂在移交单上】'

  it('also treats the time anchor as a machine-read label (issue #84)', () => {
    // 时点标注与收束/装置同类：下游用 `timeAnchorOf` 读它，作者手改正文时不能把它改坏。
    const withTime = '周叙把签收联叠进风灯罩。【收束：物件落幅】【时点：次日清晨】'
    const { prose, labels } = splitBlueprintLabels(withTime)
    expect(prose).toBe('周叙把签收联叠进风灯罩。')
    // 顺序按「剥离次序」：时点先剥 → 排在前面（#65 那三个标注的次序本来就未约定）。
    expect(labels).toEqual(['【时点：次日清晨】', '【收束：物件落幅】'])
    // 往返之后仍可读——否则作者一编辑，起草路径的时点就丢了。
    expect(timeAnchorOf(joinBlueprintLabels(prose, labels))).toBe('次日清晨')
    expect(closingShotOf(joinBlueprintLabels(prose, labels))).toBe('物件落幅')
  })

  it('splits the labels out of the prose used by the editor', () => {
    const { prose, labels } = splitBlueprintLabels(keyEvents)
    expect(prose).toBe('周叙把签收联叠进风灯罩。')
    expect(labels).toEqual(['【收束：物件落幅】', '【装置：跳板口＋把笔撂在移交单上】'])
  })

  it('keeps the labels readable for downstream rotation checks after the round trip', () => {
    const { prose, labels } = splitBlueprintLabels(keyEvents)
    const rejoined = joinBlueprintLabels(`${prose}（作者补的一句）`, labels)
    expect(closingShotOf(rejoined)).toBe('物件落幅')
    expect(stagingOf(rejoined)).toBe('跳板口＋把笔撂在移交单上')
    expect(rejoined).toContain('作者补的一句')
  })

  it('leaves a plain keyEvents untouched', () => {
    expect(splitBlueprintLabels('周叙推门进屋。')).toEqual({ prose: '周叙推门进屋。', labels: [] })
    expect(joinBlueprintLabels('周叙推门进屋。', [])).toBe('周叙推门进屋。')
  })

  it('does not strip unrelated brackets the author may have written', () => {
    const { prose, labels } = splitBlueprintLabels('他盯着那页【备注】出神。')
    expect(prose).toBe('他盯着那页【备注】出神。')
    expect(labels).toEqual([])
  })

  it('survives a label the model wrote mid-sentence', () => {
    const { prose, labels } = splitBlueprintLabels('他先【收束：对话收束】再推门。')
    expect(prose).toBe('他先再推门。')
    expect(labels).toEqual(['【收束：对话收束】'])
  })
})

// issue #91：标注是只读 chip，作者改不掉；而他能写字的正文框里新写的标注会被拼在
// **旧标注后面**，下游三个读取函数全部取 `matches.at(-1)` ⇒ **读到的永远是旧值**。
// 实测：正文写【收束：物件落幅】，`closingShotOf` 仍返回「悬念直陈」。
describe('an author-written label replaces the old one of the same kind (issue #91)', () => {
  it('lets the closing shot written in prose win over the stored chip', () => {
    const stored = '温珩把舵轮扶正，一直没对人讲。【收束：悬念直陈】【装置：舵舱＋凑水盂湿气读票】'
    const { prose, labels } = splitBlueprintLabels(stored)
    // 作者只能在正文框写字 → 新标注落在正文里
    const saved = joinBlueprintLabels(`${prose}\n【收束：物件落幅】`, labels)
    expect(closingShotOf(saved)).toBe('物件落幅')
    // 同类的旧标注被丢掉，不是并存
    expect(saved.match(/【收束/g)?.length).toBe(1)
    // 别的类别不受影响
    expect(stagingOf(saved)).toBe('舵舱＋凑水盂湿气读票')
    expect(saved.match(/【装置/g)?.length).toBe(1)
  })

  it('does the same for the time anchor', () => {
    const stored = '上午周叙赶回船上。【时点：同日上午】【收束：人物动作收束】'
    const { prose, labels } = splitBlueprintLabels(stored)
    const saved = joinBlueprintLabels(`【时点：次日清晨】${prose}`, labels)
    expect(timeAnchorOf(saved)).toBe('次日清晨')
    expect(saved.match(/【时点/g)?.length).toBe(1)
  })

  it('keeps the stored label when the author did not touch that kind', () => {
    // 作者只改了正文、没提标注时，行为与旧实现一致（chip 原样保留）。
    const stored = '周叙把签收联叠进风灯罩。【收束：物件落幅】【装置：跳板口＋把笔撂在移交单上】'
    const { prose, labels } = splitBlueprintLabels(stored)
    const saved = joinBlueprintLabels(`${prose}（作者补的一句）`, labels)
    expect(closingShotOf(saved)).toBe('物件落幅')
    expect(stagingOf(saved)).toBe('跳板口＋把笔撂在移交单上')
    expect(saved).toContain('作者补的一句')
  })

  it('classifies the three label kinds so the UI can group them', () => {
    expect(blueprintLabelKind('【时点：次日清晨】')).toBe('时点')
    expect(blueprintLabelKind('【收束：物件落幅】')).toBe('收束')
    expect(blueprintLabelKind('【装置：舱底＋拧水隔】')).toBe('装置')
    expect(blueprintLabelKind('【备注】')).toBe(null)
  })

  it('deleting a label (empty string) removes only that one', () => {
    const stored = '正文。【收束：对话收束】【装置：码头＋翻票根】'
    const { prose, labels } = splitBlueprintLabels(stored)
    const kept = labels.filter(label => !label.includes('收束'))
    const saved = joinBlueprintLabels(prose, kept)
    expect(closingShotOf(saved)).toBe('')
    expect(stagingOf(saved)).toBe('码头＋翻票根')
  })
})
