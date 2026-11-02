import { describe, expect, it } from 'vitest'

import { EN_US_BUILTIN_PROMPTS } from '../../../prompt-language'
import { BUILTIN_PROMPTS } from '../../../prompt-templates'
import { segmentChapterNotes, splitProseSentences } from '../../../../shared/finalized-continuity-facts'
import { buildFinalizedContinuityFacts } from '../finalize-chapter.command'

describe('buildFinalizedContinuityFacts', () => {
  it('preserves a long statement and its complete evidence including a final correction', () => {
    const statement = '阿青听说宝剑已经售出，' + '这个尚未证实的消息在客栈内被反复转述，'.repeat(20) + '但消息并不属实，宝剑仍在木箱里。'

    expect(buildFinalizedContinuityFacts(1, statement, statement, ['阿青'])).toEqual([{
      category: 'plot', entities: ['阿青'], statement, sourceChapter: 1, evidence: statement,
    }])
  })

  it('falls back to sentences without the character name when those are the only ones that support it (issue #76)', () => {
    // 实测第 14 章：27 条要点只落库 1 条。原因是候选池按角色名硬筛，而中文正文里
    // 支撑陈述的常常是**台词或省略主语的短句**，不含角色名。
    const notes = '邵德昌说手写原件有次级效力'
    const body = [
      '邵德昌沉默不语。',              // 含角色名，但零支撑
      '“手写原件有次级效力。”',        // 不含角色名，唯一真正支撑的一句
    ].join(String.fromCharCode(10) + String.fromCharCode(10))

    const facts = buildFinalizedContinuityFacts(14, notes, body, ['周叙', '邵德昌'])

    expect(facts).toHaveLength(1)
    expect(facts[0]!.evidence).toBe('“手写原件有次级效力。”')
  })

  it('still prefers a qualifying sentence that names the character (issue #76)', () => {
    // 两级池子的顺序不能反：含角色名且合格时必须优先用它。
    const notes = '邵德昌把手写原件放在桌上'
    const body = [
      '邵德昌把手写原件放在桌上。',    // 含角色名且合格 → 应当选它
      '“手写原件在你手边。”',
    ].join(String.fromCharCode(10) + String.fromCharCode(10))

    const [fact] = buildFinalizedContinuityFacts(14, notes, body, ['周叙', '邵德昌'])
    expect(fact!.evidence).toBe('邵德昌把手写原件放在桌上。')
  })

  it('still omits a note whose only candidates are unrelated (issue #63 guard intact)', () => {
    // 回退放宽的是**池子**，不是标准：不相干的句子照样不能当出处。
    const notes = '邵德昌主张手写原件有次级效力'
    const body = [
      '邵德昌沉默不语。',
      '货舱伙计说短褂先生这两天夜夜在船尾写什么。',
    ].join(String.fromCharCode(10) + String.fromCharCode(10))

    expect(buildFinalizedContinuityFacts(14, notes, body, ['周叙', '邵德昌'])).toEqual([])
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

// issue #41：12 条上限被同义事实占满——第 9/10 章各 12 条，ch9 至少 5 对高度重叠。
// 同一事件在「本章目标」「转折与代价」「伏笔」各写一遍，去重必须在截断之前发生。
describe('事实账本去重 (issue #41)', () => {
  it('同一件事换个小节标题再写一遍时只保留一条（第 9 章真实样本）', () => {
    const content = [
      '底册末页为九十九格，却写出一百个名字；陆敬堂称“册子乱了”。',
      '阿茂塞给周叙半张空白票根，称“重抄那夜我不在船上”；周叙在票根写下自己的名字。',
    ].join('')
    const notes = [
      '[触发] 账房伙计第二次来催缴，称子初前缴清；陆敬堂指认底册末页九十九格却写出一百个名字，称“册子乱了”，宣布今夜换卷。',
      '底册末页为九十九格，却写出一百个名字；陆敬堂称“册子乱了”。',
      '[结果] 阿茂塞给他半张空白票根并称“重抄那夜我不在船上”，周叙在票根写下自己的名字。',
      '[埋] 阿茂塞给周叙半张空白票根，称“重抄那夜我不在船上”；周叙在票根写下自己的名字。',
    ].join('\n')

    const facts = buildFinalizedContinuityFacts(9, notes, content, ['周叙', '陆敬堂', '阿茂'])
    expect(facts).toHaveLength(2)
    // 保留信息更完整的那条（长句），而不是先出现的短摘要
    expect(facts.some(fact => fact.statement.startsWith('[触发]') && fact.statement.includes('今夜换卷'))).toBe(true)
    expect(facts.some(fact => fact.statement.includes('周叙在票根写下自己的名字'))).toBe(true)
  })

  it('不重复时一条都不删（12 条互不相同的流水不误伤）', () => {
    const statements = Array.from({ length: 12 }, (_, index) => `第${index + 1}次核对时，账房在${index + 1}号票根背面发现一道旧墨。`)
    const content = statements.join('')
    const facts = buildFinalizedContinuityFacts(3, statements.join('\n'), content, ['周叙'])
    expect(facts).toHaveLength(12)
    expect(new Set(facts.map(fact => fact.statement)).size).toBe(12)
  })

  it('近重复被合并后腾出的名额，留给后面的独特事实', () => {
    const unique = Array.from({ length: 11 }, (_, index) => `第${index + 1}份清单登记了${index + 7}个不同编号。`)
    const duplicated = [
      '周叙把票根塞进船板翘起的夹缝。',
      '周叙把票根塞进船板翘起的一道夹缝。',
      '周叙把票根塞进船板翘起的夹缝里。',
    ]
    const notes = [...duplicated, ...unique].join('\n')
    const content = [...duplicated, ...unique].join('')
    const facts = buildFinalizedContinuityFacts(5, notes, content, ['周叙'])
    // 3 条近重复压成 1 条 + 11 条独特 = 12 条，且最后一条独特事实没被截掉
    expect(facts).toHaveLength(12)
    expect(facts.filter(fact => fact.statement.includes('夹缝'))).toHaveLength(1)
    expect(facts.some(fact => fact.statement === unique.at(-1))).toBe(true)
  })
})

// issue #63：出处（evidence）必须真的支撑陈述、必须能在本章正文里原样定位、
// 同章内不得把同一句当成多条事实的出处。旧实现 26% 与陈述无关、36% 同章重复、
// 还会截断在引号内部（候选来自「按句号切、引号内也切」的残片）。
describe('事实出处可信度 (issue #63)', () => {
  const content = [
    '周叙把票根按上舱板，指尖在潮气里重描“待核”那一栏。',
    '第一层墨浮起来——叶九的，横折收得急。',
    '他往下压，票根磕在铁页楔口，一行字浮出来：笔画生，横折收得急，跟刚才读出的一模一样。',
    '他把票根收回怀里，数字还剩在脑子里，写不进账，也念不给人听。',
  ].join('')

  it('出处必须是正文里原样可定位的句子（含引号整句，不切在引号内部）', () => {
    const notes = [
      '周叙在潮气里重描“待核”那一栏，第一层墨浮起来是叶九的。',
      '他往下压时读到笔画生、横折收得急的一行字。',
    ].join('\n')
    const facts = buildFinalizedContinuityFacts(1, notes, content, ['周叙', '叶九'])
    expect(facts.length).toBeGreaterThan(0)
    for (const fact of facts) {
      const inner = fact.evidence.replace(/^[“”「」『』"']+|[“”」『』"']+$/gu, '').trim()
      expect(inner.length).toBeGreaterThan(0)
      // 原样可定位：去掉首尾引号后仍是正文子串
      expect(content.includes(inner)).toBe(true)
      // 不切在引号内部：出处不以收引号开头
      expect(fact.evidence.startsWith('”')).toBe(false)
    }
  })

  it('同章内一句正文只能作为一条事实的出处（不得复用）', () => {
    // 三条要点都能匹配到「票根磕在铁页楔口」那一句；只能有一条用它。
    const notes = [
      '他往下压票根，读到写着笔画生的那行字。',
      '票根磕在铁页楔口，一行字浮出来。',
      '那行字的笔画生、横折收得急。',
    ].join('\n')
    const facts = buildFinalizedContinuityFacts(2, notes, content, ['周叙'])
    const evidences = facts.map(fact => fact.evidence)
    expect(new Set(evidences).size).toBe(evidences.length)
  })

  it('出处与陈述毫无共同内容时不产出该条（宁缺毋滥，不再拿不相干的句子充数）', () => {
    const notes = '货舱伙计较过三遍船票，确认少了两个人。'
    const facts = buildFinalizedContinuityFacts(3, notes, content, ['周叙'])
    // 正文里没有「伙计核对船票」这件事：不得拿「票根按上舱板」之类不相干的句子当出处
    expect(facts).toEqual([])
  })

  it('引号内的候选不再被当成独立句子（正文切句引号感知）', () => {
    const dialogue = '周叙问“三天前谁动过账？”，温珩合上记录本，说“再核下去，今晚船就别想开。”'
    const sentences = splitProseSentences(dialogue)
    expect(sentences).toHaveLength(1)
    expect(sentences[0]).toBe(dialogue)
  })
})
