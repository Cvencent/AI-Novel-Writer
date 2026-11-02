import { describe, expect, it } from 'vitest'

import {
  findAppearanceGaps,
  findBlueprintContinuityRisks,
  findCrossChapterAssertionReversals,
  findExpandedContinuityRisks,
  findMissingCastInArch,
  findNearCastNameFindings,
  findSynopsisCastMismatches,
  findUnregisteredBlueprintCast,
  mergeConsistencyFindingsIntoReview,
  synopsisSceneCharacters,
} from '../consistency-preflight'
import { buildFinalizedContinuityFacts } from '../finalized-continuity-facts'

it('本章候选名单超过八人时仍识别后续事实中的角色', () => {
  const names = [...Array.from({ length: 8 }, (_, index) => `无关${index}`), '顾舟']
  const facts = buildFinalizedContinuityFacts(1, '顾舟已经死亡。', '顾舟已经死亡。', names)
  expect(facts[0]?.entities).toEqual(['顾舟'])
  expect(findBlueprintContinuityRisks([{ draftId: 1, chapterNumber: 1, chapterTitle: '', chapterNotes: '', sourceStatus: 'current', facts }], {
    chapterNumber: 2, title: '归来', role: '', purpose: '', keyEvents: '顾舟出现', characters: ['顾舟'], suspenseHook: '', userGuidance: '', notes: '',
  }, [])).toHaveLength(1)
})

describe('findBlueprintContinuityRisks', () => {
  const projection = [{
    draftId: 7,
    chapterNumber: 1,
    chapterTitle: '午夜怀表',
    chapterNotes: '银色怀表仍待调查。',
    sourceStatus: 'current' as const,
    facts: [{
      category: 'character-state' as const,
      entities: ['顾舟'],
      statement: '顾舟已经死亡。',
      sourceChapter: 1,
      evidence: '表盖内侧刻着一组陌生坐标。',
    }],
  }]

  it.each(['stale', 'legacy', undefined] as const)(
    'does not promote a %s projection to a deterministic finding',
    (sourceStatus) => {
      const findings = findBlueprintContinuityRisks([{ ...projection[0]!, sourceStatus }], {
        chapterNumber: 2, title: '重逢', role: '发展', purpose: '顾舟归来', keyEvents: '顾舟敲门',
        characters: ['顾舟'], suspenseHook: '', userGuidance: '', notes: '',
      }, [])
      expect(findings).toEqual([])
    },
  )

  it('returns a stable sourced finding when a terminal character is scheduled to appear', () => {
    const findings = findBlueprintContinuityRisks(projection, {
      chapterNumber: 2,
      title: '新的清晨',
      role: '发展',
      purpose: '主角拜访证人',
      keyEvents: '主角前往车站。',
      characters: ['林岚', '顾舟'],
      suspenseHook: '证人突然失踪。',
      userGuidance: '',
      notes: '',
    }, [])

    expect(findings).toEqual([expect.objectContaining({
      stableFactKey: expect.stringMatching(/^fact:[0-9a-f]{16}$/u),
      severity: 'warning',
      sourceChapter: 1,
      evidence: '表盖内侧刻着一组陌生坐标。',
    })])
    expect(findings[0]?.issue.zhCN).toContain('顾舟')
    expect(findings[0]?.issue.enUS).toContain('顾舟')
  })

  it('reports the named terminal subject instead of another entity or a witness', () => {
    const findings = findBlueprintContinuityRisks([{
      ...projection[0]!,
      chapterNumber: 4,
      facts: [{
        category: 'character-state' as const,
        entities: ['林舟', '林海'],
        statement: '[结果] 林海死亡，U盘与证据落入林舟手中',
        sourceChapter: 4,
        evidence: '林海留下证据后死亡。',
      }, {
        category: 'character-state' as const,
        entities: ['林舟'],
        statement: '| 林舟 | 接收U盘与钥匙，目睹父亲死亡后逃脱 |',
        sourceChapter: 4,
        evidence: '林舟目睹父亲死亡。',
      }],
    }], {
      chapterNumber: 5,
      title: '回声中的证人',
      role: '收束',
      purpose: '出席听证会',
      keyEvents: '林海亲自现身。',
      characters: ['林舟', '苏遥', '林海'],
      suspenseHook: '',
      userGuidance: '',
      notes: '',
    }, [])

    expect(findings).toHaveLength(1)
    expect(findings[0]?.issue.zhCN).toContain('林海')
    expect(findings[0]?.issue.zhCN).not.toContain('“林舟”')
  })

  it('does not report an omitted open thread and suppresses only active stable-key exemptions', () => {
    const openThreadProjection = [{ ...projection[0]!, facts: [{
      category: 'open-thread' as const, entities: ['银色怀表'], statement: '坐标尚未解释。',
      sourceChapter: 1, evidence: '表盖内侧刻着坐标。',
    }] }]
    const continued = findBlueprintContinuityRisks(openThreadProjection, {
      chapterNumber: 2,
      title: '怀表坐标',
      role: '发展',
      purpose: '调查银色怀表',
      keyEvents: '林岚解读坐标。',
      characters: ['林岚'],
      suspenseHook: '坐标指向旧码头。',
      userGuidance: '',
      notes: '',
    }, [])
    expect(continued).toEqual([])

    const ignored = findBlueprintContinuityRisks(projection, {
      chapterNumber: 2,
      title: '新的清晨', role: '发展', purpose: '拜访证人', keyEvents: '前往车站',
      characters: ['林岚', '顾舟'], suspenseHook: '证人失踪', userGuidance: '', notes: '',
    }, [{ stableFactKey: findBlueprintContinuityRisks(projection, {
      chapterNumber: 2, title: '重逢', role: '发展', purpose: '顾舟归来', keyEvents: '顾舟敲门',
      characters: ['顾舟'], suspenseHook: '', userGuidance: '', notes: '',
    }, [])[0]!.stableFactKey, reason: '回忆场景', revoked: false }])
    expect(ignored).toEqual([])
  })

  it('counts a cast member named only in the blueprint description as scheduled (issue #74)', () => {
    // 报告里的真实形态：叶九在第 24/25/26/28 章的蓝图**描述**里都在
    // （第 24、28 章还是情节支点），只是没被列进 characters 数组。
    // 旧判据只读数组，于是报出「已连续 7 章没有进入蓝图」——作者去查会发现人明明在。
    const blueprints = [
      { chapterNumber: 22, characters: ['周叙', '叶九'] },
      { chapterNumber: 24, characters: ['周叙', '温珩', '柯明远'],
        descriptionText: '存根连正面的模糊指印一并化尽，叶九缺半节小指的印子再没有实物可对' },
      { chapterNumber: 25, characters: ['周叙', '柯明远', '林棠', '温珩'],
        descriptionText: '林棠从墙缝递出一张纸片，低声说叶九天没亮就进了公司档案房' },
      { chapterNumber: 26, characters: ['周叙', '全叔', '柯明远', '温珩', '林棠'],
        descriptionText: '叶九今晚清库前要把档案房旧册挪走' },
      { chapterNumber: 28, characters: ['周叙', '全叔', '温珩'],
        descriptionText: '补笔稳匀属叶九' },
    ]
    const findings = findExpandedContinuityRisks({
      currentChapter: 29,
      blueprints,
      cast: [{ name: '叶九', role: 'antagonist', motivation: '清掉档案房旧册' }],
      threads: [],
    })
    // 第 28 章描述里有他 → 最近一次是第 28 章，不是第 22 章，且不该报缺席。
    expect(findings.filter(finding => finding.stableFactKey.startsWith('cast:absent:'))).toEqual([])
    expect(findings.filter(finding => finding.stableFactKey.startsWith('cast:never-appeared:'))).toEqual([])

    // 反证：把描述文本抽掉（回到旧判据的输入），假警报就出现了。
    const bare = findExpandedContinuityRisks({
      currentChapter: 29,
      blueprints: blueprints.map(({ chapterNumber, characters }) => ({ chapterNumber, characters })),
      cast: [{ name: '叶九', role: 'antagonist', motivation: '清掉档案房旧册' }],
      threads: [],
    })
    expect(bare.some(finding => finding.stableFactKey.startsWith('cast:absent:'))).toBe(true)
  })

  it('still reports a genuinely absent cast member when neither array nor description names them', () => {
    const findings = findExpandedContinuityRisks({
      currentChapter: 29,
      blueprints: [
        { chapterNumber: 22, characters: ['叶九'], descriptionText: '叶九在档案房。' },
        { chapterNumber: 28, characters: ['周叙'], descriptionText: '周叙把页按在湿板上蘸水溯读。' },
      ],
      cast: [{ name: '叶九', role: 'antagonist', motivation: '清掉旧册' }],
      threads: [],
    })
    const absent = findings.find(finding => finding.stableFactKey.startsWith('cast:absent:'))
    expect(absent).toBeDefined()
    expect(absent!.evidence).toBe('叶九 last scheduled in chapter 22')
  })

  it('reports absent, never-appeared, thin-cast, and overdue thread risks without duplicating AI review work', () => {
    const findings = findExpandedContinuityRisks({
      currentChapter: 8,
      blueprints: [
        { chapterNumber: 1, characters: ['林岚'] },
        { chapterNumber: 2, characters: ['林岚'] },
        { chapterNumber: 8, characters: ['周砚'] },
      ],
      cast: [
        { name: '林岚', role: 'protagonist', motivation: '查清父亲失踪真相' },
        { name: '周砚', role: 'antagonist', motivation: '' },
        { name: '沈舟', role: 'supporting', motivation: '守住码头' },
      ],
      threads: [
        { title: '银色怀表', status: 'progressing', dormantChapters: 5, overdue: false, authorIntent: '在第十章回收' },
        { title: '旧码头账册', status: 'planted', dormantChapters: 0, overdue: true, authorIntent: '账册必须在第八章前出现' },
        { title: '已收线索', status: 'resolved', dormantChapters: 8, overdue: true, authorIntent: '已解决' },
      ],
    })
    const messages = findings.map(item => item.issue.zhCN).join('\n')
    expect(messages).toContain('林岚')
    expect(messages).toContain('周砚')
    expect(messages).toContain('银色怀表')
    expect(messages).toContain('旧码头账册')
    expect(messages).not.toContain('已收线索')
    expect(messages).not.toContain('沈舟')
    expect(new Set(findings.map(item => item.stableFactKey)).size).toBe(findings.length)
  })
  it('maps deterministic findings into the existing review item shape', () => {
    const finding = findBlueprintContinuityRisks(projection, {
      chapterNumber: 2, title: '重逢', role: '发展', purpose: '顾舟归来', keyEvents: '顾舟敲门',
      characters: ['顾舟'], suspenseHook: '他为何归来', userGuidance: '', notes: '',
    }, [])[0]!
    const review = mergeConsistencyFindingsIntoReview({ summary: 'AI summary', items: [] }, [finding], 'en-US')
    expect(review.items).toEqual([expect.objectContaining({
      category: 'Deterministic continuity preflight', severity: 'warning',
      quote: '表盖内侧刻着一组陌生坐标。',
    })])
    expect(review.items[0]?.description).toContain('顾舟')
  })
})

describe('findSynopsisCastMismatches (issue #27)', () => {
  const castNames = ['周叙', '温珩', '阿茂', '陆敬堂', '柯有顺', '陶有根', '邵德昌', '陈阿水']

  it('解析「身份·姓名」出场人物行，剥离身份前缀', () => {
    const line = '**场景与出场人物**：雾津港验票舱与码头酒棚，出场的有验票船工·周叙、搭档·温珩、补网匠·陶有根。舱口挂灯摇晃。'
    const names = synopsisSceneCharacters(line)
    // 解析只给候选；场景条目这类非人名候选由调用方按 characters 名单过滤。
    expect(names).toEqual(expect.arrayContaining(['周叙', '温珩', '陶有根']))
  })

  it('细纲点名、蓝图漏掉的角色给出提示（陶有根式：蓝图把这条线换成了别人）', () => {
    const synopsisChunk = [
      '## 第1章：多出的名字',
      '',
      '**场景与出场人物**：雾津港验票舱口，出场的有验票船工·周叙、搭档·温珩，以及本章失踪的补网匠·陶有根。',
      '',
      '**本章目标**：周叙要弄清补网匠·陶有根到底上没上船。',
      '**结尾钩子**：开航点名，陶有根没来。',
    ].join('\n')
    const findings = findSynopsisCastMismatches({
      chapterNumber: 1,
      synopsisChunk,
      blueprintCharacters: ['周叙', '温珩', '陈阿水'],
      castNames,
    })
    const messages = findings.map(item => item.issue.zhCN).join('\n')
    // 细纲主线人物被蓝图漏掉
    expect(messages).toContain('陶有根')
    // 蓝图排了一个细纲整章都没写的角色（替换信号）
    expect(messages).toContain('陈阿水')
    expect(findings.every(item => item.severity === 'warning' && item.sourceChapter === 1)).toBe(true)
    expect(new Set(findings.map(item => item.stableFactKey)).size).toBe(findings.length)
  })

  it('细纲与蓝图互相覆盖时不产生发现（正常章节不打扰作者）', () => {
    const synopsisChunk = [
      '## 第2章：压平的那一格',
      '',
      '**场景与出场人物**：验票舱，出场的有验票船工·周叙、搭档·温珩、售票经手人·阿茂。',
      '',
      '**本章目标**：周叙查底册，温珩帮他重抄，阿茂递来票根。',
    ].join('\n')
    expect(findSynopsisCastMismatches({
      chapterNumber: 2,
      synopsisChunk,
      blueprintCharacters: ['周叙', '温珩', '阿茂'],
      castNames,
    })).toEqual([])
  })

  it('场景/舱口这类非人名条目不算角色，只在册角色参与比对', () => {
    const synopsisChunk = [
      '## 第3章：撕口',
      '',
      '**场景与出场人物**：潮生号后舱验票台与码头酒棚，出场的有验票船工·周叙、散工·陈阿水。',
    ].join('\n')
    const findings = findSynopsisCastMismatches({
      chapterNumber: 3,
      synopsisChunk,
      blueprintCharacters: ['周叙'],
      castNames,
    })
    expect(findings.map(item => item.issue.zhCN).join('\n')).toContain('陈阿水')
    expect(findings.map(item => item.issue.zhCN).join('\n')).not.toContain('潮生号后舱验票台')
    expect(findings.map(item => item.issue.zhCN).join('\n')).not.toContain('码头酒棚')
  })
})

// issue #42：第 11 章蓝图与正文一致地引入「任九」（4 次出场、3 句台词），但角色卡里没有这个人。
// 下游全部收不到他：状态回写没有锚点、一致性检查只按名册取角色、下一章起草对他一片空白。
describe('findUnregisteredBlueprintCast (issue #42)', () => {
  const castNames = ['周叙', '温珩', '陆敬堂', '阿茂', '陈阿水', '柯有顺', '陶有根', '邵德昌']

  it('蓝图角色不在名册时给出可见性提示，并说明后果与两条出路', () => {
    const findings = findUnregisteredBlueprintCast({ chapterNumber: 11, blueprintCharacters: ['周叙', '任九', '温珩'], castNames })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'warning', sourceChapter: 11 })
    expect(findings[0]!.issue.zhCN).toContain('任九')
    expect(findings[0]!.issue.zhCN).toContain('角色卡里没有这个人')
    // 出路：建卡，或换成无名的身份称呼
    expect(findings[0]!.suggestion.zhCN).toContain('建卡')
    expect(findings[0]!.suggestion.zhCN).toContain('身份称呼')
    expect(findings[0]!.stableFactKey).toContain('unregistered')
  })

  it('全部在册时不产生提示（正常章节不打扰作者）', () => {
    expect(findUnregisteredBlueprintCast({ chapterNumber: 12, blueprintCharacters: ['周叙', '温珩'], castNames })).toEqual([])
  })

  it('每章最多 4 条，避免一次性挤占上下文', () => {
    const findings = findUnregisteredBlueprintCast({
      chapterNumber: 13,
      blueprintCharacters: ['周叙', '甲一', '乙二', '丙三', '丁四', '戊五'],
      castNames,
    })
    expect(findings).toHaveLength(4)
  })
})

// issue #40：AI 新建的邵德昌在第 8、9 章各有戏，角色卡 appearance 一直为空——
// 起草时 appearance 会进提示，留空等于把这个角色的长相交给模型每章即兴。
describe('findAppearanceGaps (issue #40)', () => {
  const cast = [
    { name: '周叙', role: 'protagonist', appearance: '三十上下，靛蓝短褂。' },
    { name: '邵德昌', role: 'supporting', appearance: '' },
    { name: '陆敬堂', role: 'antagonist', appearance: '   ' },
    { name: '陈阿水', role: 'minor', appearance: '瘦小，袖口磨白。' },
    { name: '  ', role: 'minor', appearance: '' },
  ]

  it('只有缺外貌的在册角色被报出，空名与已填的不报', () => {
    const findings = findAppearanceGaps({ cast, chapterNumber: 12 })
    expect(findings.map(finding => finding.evidence)).toEqual([
      '角色「邵德昌」的角色卡没有外貌字段',
      '角色「陆敬堂」的角色卡没有外貌字段',
    ])
    expect(findings.every(finding => finding.severity === 'warning' && finding.sourceChapter === 12)).toBe(true)
    // 补上外貌后同一个角色不再出现（提示自愈）
    expect(findAppearanceGaps({ cast: [{ name: '邵德昌', role: 'supporting', appearance: '花白须，玄色长衫。' }], chapterNumber: 12 })).toEqual([])
  })

  it('stableFactKey 按角色名唯一，便于逐条豁免', () => {
    const findings = findAppearanceGaps({ cast, chapterNumber: 12 })
    expect(findings.map(finding => finding.stableFactKey)).toEqual([
      'character:appearance-gap:邵德昌',
      'character:appearance-gap:陆敬堂',
    ])
  })

  it('建议里给的是「照已写过的描写回填」，不是让人另编一套外形', () => {
    const [finding] = findAppearanceGaps({ cast: [{ name: '邵德昌', role: 'supporting', appearance: '' }], chapterNumber: 12 })
    expect(finding!.suggestion.zhCN).toContain('不要另起一套外形')
  })

  it('一次性上限 6 条，不刷屏', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `路人${index}`, role: 'minor', appearance: '' }))
    expect(findAppearanceGaps({ cast: many, chapterNumber: 1 })).toHaveLength(6)
  })
})

// issue #52：第 16 章蓝图/正文断言「是叶九的手」，第 19 章蓝图与正文都写「不是叶九的手」，
// 而第 19 章整章推理架在后一句上——生成本章蓝图时第 16 章还在最近三章窗口内，却没人比对过。
describe('findCrossChapterAssertionReversals (issue #52)', () => {
  const castNames = ['周叙', '温珩', '叶九', '林棠', '全叔']
  const asserted = {
    chapterNumber: 16,
    text: '周叙回船趁开航前的水汽再读待核栏：温珩的名字果然已被写上，墨迹极新，笔压稳匀，是叶九的手。',
    label: '蓝图',
  }

  it('前一章断言、本章否定同一短语时报出，并指向两章的原文', () => {
    const findings = findCrossChapterAssertionReversals({
      castNames,
      earlier: [asserted],
      current: {
        chapterNumber: 19,
        text: '压在叶九昨夜新落的“待核”那一笔上溯读：这一笔落在签押之后，笔压发慌，与叶九平日稳匀的手不是一路。不是叶九的手。',
      },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'warning', sourceChapter: 19 })
    expect(findings[0]!.evidence).toContain('第16章蓝图')
    expect(findings[0]!.evidence).toContain('叶九的手')
    expect(findings[0]!.stableFactKey).toContain('assertion-reversal:叶九的手')
    // 两条出路：改成一致，或写出「为什么上一次读错了」
    expect(findings[0]!.issue.zhCN).toContain('推翻前一次的核验过程')
    expect(findings[0]!.suggestion.zhCN).toContain('为什么上一次读错了')
  })

  it('短语不含在册角色名时不报（「不是钱的事」这类日常否定不能当反转）', () => {
    expect(findCrossChapterAssertionReversals({
      castNames,
      earlier: [{ chapterNumber: 3, text: '这一趟不是钱的事，是人情。', label: '蓝图' }],
      current: { chapterNumber: 5, text: '他心里清楚，不是钱的事。' },
    })).toEqual([])
  })

  it('本章没有明确否定时不报（正常推进不打扰）', () => {
    expect(findCrossChapterAssertionReversals({
      castNames,
      earlier: [asserted],
      current: { chapterNumber: 17, text: '周叙把那一笔抄进私册，笔迹与叶九平日一样稳匀。' },
    })).toEqual([])
  })

  it('顺序不能反：后章断言、前章否定不算反转', () => {
    expect(findCrossChapterAssertionReversals({
      castNames,
      earlier: [{ chapterNumber: 5, text: '那不是叶九的手。', label: '蓝图' }],
      current: { chapterNumber: 9, text: '墨压稳匀，是叶九的手。' },
    })).toEqual([])
  })

  it('同一短语最多一条，避免同章多处否定刷屏', () => {
    const findings = findCrossChapterAssertionReversals({
      castNames,
      earlier: [asserted, { ...asserted, chapterNumber: 14 }],
      current: { chapterNumber: 19, text: '不是叶九的手。再一次：不是叶九的手。' },
    })
    expect(findings).toHaveLength(2)   // 两章各一条（同一断言在两章都说过）
    expect(new Set(findings.map(finding => finding.stableFactKey)).size).toBe(2)
  })
})

describe('near-cast name findings are actionable and stay muted once confirmed (issue #69)', () => {
  const input = (chapterNumber: number) => ({
    chapterNumber,
    // 判据只认**引号里**的名字（「柯阅」）：正文里直接写名字不算，因为那可能是任意词。
    descriptionText: '周叙掀盖，抽出航次账。“你写的。「柯阅」。”',
    castNames: ['柯明远', '周叙'],
  })

  it('reports the near name once per pair, not once per chapter', () => {
    // 原来 stableFactKey 带章号：同一个署名（实测第 21/22/26 章）每章都重报一次。
    const first = findNearCastNameFindings(input(22))
    const later = findNearCastNameFindings(input(26))
    expect(first.map(finding => finding.stableFactKey)).toEqual(later.map(finding => finding.stableFactKey))
    expect(first[0]!.stableFactKey).toBe('blueprint-cast:near-name:柯明远:柯阅')
  })

  it('points at actions that exist in the product', () => {
    const [finding] = findNearCastNameFindings(input(22))
    // 出路一必须是「保存安排」（预检弹层里真有这个按钮），不能再写「角色别名」——
    // 全仓没有加别名的入口。
    expect(finding!.suggestion.zhCN).toContain('保存安排')
    expect(finding!.suggestion.zhCN).toContain('说明为何属于刻意安排')
    expect(finding!.suggestion.zhCN).not.toContain('角色别名里')
    // 出路二（建卡）在角色名单里确实做得到，保留。
    expect(finding!.suggestion.zhCN).toContain('建卡')
    expect(finding!.suggestion.enUS).toContain('Save arrangement')
    expect(finding!.suggestion.enUS).not.toContain('as an alias')
  })
})

describe('findMissingCastInArch (issue #3)', () => {
  // 报告里的两份数据（原文照抄）：名单 6 人，群像只有 4 个条目。
  const ROSTER = [
    { name: '周叙', role: 'protagonist' },
    { name: '温珩', role: 'supporting' },
    { name: '沈砚', role: 'antagonist' },
    { name: '陆秉文', role: 'antagonist' },
    { name: '林晚', role: 'supporting' },
    { name: '顾棠', role: 'supporting' },
  ]
  const ARCH = [
    '## 主角：周叙',
    '他想查清父亲那趟航次的真相。',
    '',
    '## 配角：林晚',
    '她在售票口做活，记得每个熟客。',
    '',
    '## 配角：温珩',
    '穿同一件靛蓝短褂，话少。',
    '',
    '## 配角：顾棠',
    '档案房的年轻文员。',
  ].join(String.fromCharCode(10))

  it('flags the two antagonists the group portrait omits', () => {
    const findings = findMissingCastInArch({ charactersArch: ARCH, cast: ROSTER })
    expect(findings.map(finding => finding.evidence)).toEqual([
      expect.stringContaining('沈砚'),
      expect.stringContaining('陆秉文'),
    ])
    // 角色定位要进证据与结论：缺的是两位施压方，作者一眼能看到严重性。
    expect(findings[0]!.evidence).toContain('antagonist')
    expect(findings[0]!.issue.zhCN).toContain('施压方')
    expect(findings[0]!.stableFactKey).toBe('architecture:cast-missing-in-arch:沈砚')
  })

  it('does not flag anyone when the portrait covers the roster', () => {
    const complete = `${ARCH}
## 反派：沈砚
渡运站主事，笑时只看人不看眼。
## 反派：陆秉文
账房，常年戴铜框老花镜。`
    expect(findMissingCastInArch({ charactersArch: complete, cast: ROSTER })).toEqual([])
  })

  it('counts a bare name heading as coverage', () => {
    // 作者可能写成「## 沈砚」而不是「## 反派：沈砚」，两种都要算有。
    expect(findMissingCastInArch({
      charactersArch: ['## 沈砚', '主事。'].join(String.fromCharCode(10)),
      cast: [{ name: '沈砚' }],
    })).toEqual([])
  })

  it('says nothing when the group portrait has not been generated yet', () => {
    // 群像为空是「还没生成」，不是「漏了人」——报「每个人都缺」没有意义。
    expect(findMissingCastInArch({ charactersArch: '', cast: ROSTER })).toEqual([])
    expect(findMissingCastInArch({ charactersArch: '   ', cast: ROSTER })).toEqual([])
  })

  it('gives an actionable fix rather than just naming the gap', () => {
    const [finding] = findMissingCastInArch({ charactersArch: ARCH, cast: ROSTER })
    expect(finding!.suggestion.zhCN).toContain('补一段')
    expect(finding!.suggestion.zhCN).toContain('不要另起一套设定')
    expect(finding!.suggestion.enUS).toContain('Add a paragraph')
  })

  it('caps the report so a large roster cannot flood the panel', () => {
    const big = Array.from({ length: 12 }, (_, index) => ({ name: `角色${index}`, role: 'supporting' }))
    expect(findMissingCastInArch({
      charactersArch: ['## 周叙', '主线。'].join(String.fromCharCode(10)),
      cast: big,
    }).length).toBeLessThanOrEqual(6)
  })
})
