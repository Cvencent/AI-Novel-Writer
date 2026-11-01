import { describe, expect, it } from 'vitest'

import { EN_US_BUILTIN_PROMPTS } from '../../../prompt-language'
import { BUILTIN_PROMPTS } from '../../../prompt-templates'
import { segmentChapterNotes } from '../../../../shared/finalized-continuity-facts'
import { buildFinalizedContinuityFacts } from '../finalize-chapter.command'

describe('buildFinalizedContinuityFacts', () => {
  it('preserves a long statement and its complete evidence including a final correction', () => {
    const statement = '阿青听说宝剑已经售出，' + '这个尚未证实的消息在客栈内被反复转述，'.repeat(20) + '但消息并不属实，宝剑仍在木箱里。'

    expect(buildFinalizedContinuityFacts(1, statement, statement, ['阿青'])).toEqual([{
      category: 'plot', entities: ['阿青'], statement, sourceChapter: 1, evidence: statement,
    }])
  })

  it('classifies an explicit character death as character state', () => {
    const finalizedContent = '韩峥被洪水卷入排水井，当场死亡。'

    const facts = buildFinalizedContinuityFacts(
      2,
      '韩峥被洪水卷入排水井，当场死亡。',
      finalizedContent,
      ['韩峥'],
    )

    expect(facts).toEqual([
      expect.objectContaining({
        category: 'character-state',
        entities: ['韩峥'],
        statement: '韩峥被洪水卷入排水井，当场死亡。',
      }),
    ])
  })

  it('binds each fact to its own finalized evidence and omits unsupported notes', () => {
    const facts = buildFinalizedContinuityFacts(
      4,
      [
        '林舟把铜钥匙交给苏遥。',
        '韩峥在洪水中死亡。',
        '顾明破解了保险箱密码。',
      ].join('\n'),
      '林舟把铜钥匙交给苏遥。韩峥随后被洪水卷走，当场死亡。',
      ['林舟', '苏遥', '韩峥', '顾明'],
    )

    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({
      entities: ['林舟', '苏遥'],
      evidence: '林舟把铜钥匙交给苏遥。',
    })
    expect(facts[1]).toMatchObject({
      entities: ['韩峥'],
      evidence: '韩峥随后被洪水卷走，当场死亡。',
    })
    expect(facts.some(fact => fact.statement.includes('顾明'))).toBe(false)
  })

  it('does not treat an entity boundary bigram as evidence for a contradictory fact', () => {
    const facts = buildFinalizedContinuityFacts(
      5,
      '林海在北京死亡。',
      '林海在上海生活。',
      ['林海'],
    )

    expect(facts).toEqual([])
  })

  it('does not treat a shared location as support for the opposite predicate', () => {
    const facts = buildFinalizedContinuityFacts(
      5,
      '林海在北京死亡。',
      '林海在北京生活。',
      ['林海'],
    )

    expect(facts).toEqual([])
  })

  it('applies the fact limit after rejecting unsupported note statements', () => {
    const supportedFact = '林岚在北塔因爆炸碎片受伤，顾砚亲眼看见。'
    const unsupportedNotes = Array.from(
      { length: 12 },
      (_, index) => `无正文证据的摘要陈述${index + 1}。`,
    )

    const facts = buildFinalizedContinuityFacts(
      6,
      [...unsupportedNotes, supportedFact].join('\n'),
      supportedFact,
      ['林岚', '顾砚'],
    )

    expect(facts).toEqual([{
      category: 'character-state',
      entities: ['林岚', '顾砚'],
      statement: supportedFact,
      sourceChapter: 6,
      evidence: supportedFact,
    }])
  })

  it('does not split inside quotes: dialogue with sentence marks stays one fact', () => {
    const notes = '周叙问“三天前谁动过账？”，温珩走过来伸手合上记录本，说“再核下去，今晚船就别想开。”'
    const content = '周叙问“三天前谁动过账？”，温珩走过来伸手合上记录本，说“再核下去，今晚船就别想开。”温珩走过来，伸手把记录本合上了。'

    const facts = buildFinalizedContinuityFacts(1, notes, content, ['周叙', '温珩'])

    expect(facts).toHaveLength(1)
    expect(facts[0].statement).toBe(notes)
    expect(facts[0].statement.startsWith('”')).toBe(false)
  })

  it('skips markdown heading and table rows instead of storing them as facts', () => {
    const notes = [
      '## 角色动态',
      '| 周叙 | 核完三十二张票根；问“三天前谁动过账？',
      '---',
      '温珩替老太太临开船补了一张湿票，没有入底。',
      '| 温珩 | 承认补票 |',
      '父亲留下的空白票根受潮压到涂改处，原字会慢慢洇出。',
    ].join('\n')
    const content = '温珩替老太太临开船补了一张湿票，没有入底。父亲留下的空白票根受潮压到涂改处，原字会慢慢洇出。'

    const facts = buildFinalizedContinuityFacts(2, notes, content, ['温珩'])

    expect(facts.every(fact => !fact.statement.startsWith('|'))).toBe(true)
    expect(facts.some(fact => fact.statement.includes('湿票'))).toBe(true)
    expect(facts.some(fact => fact.statement.includes('洇出'))).toBe(true)
  })

  it('keeps real facts ahead of fragments when the limit would truncate', () => {
    // 旧版把对话切成 2+ 残片（” 开头）挤占名额，真事实被截在 12 条之外；新规则不会。
    const realFact = '父亲留下的空白票根受潮压到涂改处，原字会慢慢洇出。'
    const dialogueLine = '周叙问“三天前谁动过账？”，温珩合上记录本说“再核下去，今晚船就别想开。”'
    const filler = Array.from({ length: 10 }, (_, index) => `第${index + 1}段流水记录，周叙核对第${index + 1}张票根的墨迹。`)
    const notes = [...filler, dialogueLine, realFact].join('\n')
    const content = `${realFact}周叙核对票根的墨迹。`

    const facts = buildFinalizedContinuityFacts(3, notes, content, ['周叙'])

    expect(facts.length).toBeLessThanOrEqual(12)
    expect(facts.some(fact => fact.statement === realFact)).toBe(true)
    // dialogueLine 没有正文证据不会落库（既有证据门），但切分层面它必须是完整一条，
    // 不能以 ” 残片形式占名额。
    expect(segmentChapterNotes(notes)).toContain(dialogueLine)
    expect(segmentChapterNotes(notes).every(statement => !statement.startsWith('”'))).toBe(true)
  })

  it('asks chapter notes to preserve only explicit continuity context without filling every field', () => {
    const zh = BUILTIN_PROMPTS.find(template => template.key === 'generate_chapter_notes')
    const en = EN_US_BUILTIN_PROMPTS.generate_chapter_notes

    expect(zh?.content).toContain('若正文明确写出其原因、发生地点、知情者或获知来源')
    expect(zh?.content).toContain('不要求每条凑齐这些要素')
    expect(zh?.content).toContain('正文未明确的信息不得补全或推测')
    expect(zh?.content).not.toContain('每项不超过 30 字')
    expect(en.content).toContain('an explicitly stated cause, location, witness, or source of knowledge')
    expect(en.content).toContain('Do not infer missing details or require every note to contain all of these elements')
    expect(zh?.content).toContain('在角色动态或伏笔与钩子中保留相关角色的最后更正及当前条件')
    expect(zh?.content).toContain('不得用更显著的旧事件替代当前安排，也不得把计划写成已执行')
    expect(en.content).toContain('preserve the affected character\'s last correction and current conditions in Character Dynamics or Foreshadowing and Hooks')
    expect(en.content).toContain('Do not substitute a more prominent earlier event for the current plan or describe a plan as executed')
  })
})
