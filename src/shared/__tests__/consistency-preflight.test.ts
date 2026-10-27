import { describe, expect, it } from 'vitest'

import { findBlueprintContinuityRisks, findExpandedContinuityRisks, mergeConsistencyFindingsIntoReview } from '../consistency-preflight'
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
