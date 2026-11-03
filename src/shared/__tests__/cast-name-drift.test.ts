import { describe, expect, it } from 'vitest'

import {
  CAST_NAME_DRIFT_BLOCKED_HEADS,
  CAST_NAME_DRIFT_MIN_CHARS,
  findCastNameDrift,
  findCastNameDriftFindings,
  findCastNameDriftInChapter,
} from '../cast-name-drift'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

// issue #102：那本 46 章的悬疑长篇里，已登记角色「陆敬堂」在第 23 章被写成「穆敬堂」——
// 全书前 22 章一律作「陆敬堂」（第 4–13 章共 28 次），第 23 章第一次出现就是「穆敬堂」，
// 正文没有任何交代。错误已被事实账本继承（chapter_commits.facts_json 与 summary_snapshots
// 第 23 章都写进了「穆敬堂」），会作为「定稿历史」喂给后面每一章。
describe('findCastNameDriftInChapter (issue #102)', () => {
  const ROSTER = ['周叙', '温珩', '陆敬堂', '陈阿水', '柯有顺', '陶有根', '邵德昌']

  it('catches the reported drift — 穆敬堂 for the registered 陆敬堂', () => {
    const hits = findCastNameDriftInChapter(ch(23,
      '“点数、贴签、押运。”马六把工钱簿一合，“穆敬堂调东码头了，这一摊归你。日结，不录名。”'), ROSTER)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ variant: '穆敬堂', canonical: '陆敬堂' })
    expect(hits[0]!.excerpt).toContain('穆敬堂调东码头')
  })

  it('does not report a name that IS on the roster', () => {
    expect(findCastNameDriftInChapter(ch(1, '邵德昌在码头等他。'), ROSTER)).toEqual([])
    expect(findCastNameDriftInChapter(ch(1, '陆敬堂把工钱簿合上。'), ROSTER)).toEqual([])
  })

  it('requires at least three characters — two-char names sharing one char are normal', () => {
    // 「阿茂」「阿水」在同书并存很正常，共享一字不是漂移；门槛就是为它们设的。
    expect(CAST_NAME_DRIFT_MIN_CHARS).toBe(3)
    expect(findCastNameDriftInChapter(ch(1, '阿水把绳子拴上。'), ['阿茂'])).toEqual([])
  })

  it('needs the whole given name to match, not just a shared character', () => {
    // 「陆水」与「陈阿水」只共一字、后缀不同 → 不是同一后缀，不报。
    expect(findCastNameDriftInChapter(ch(1, '陆水来了。'), ROSTER)).toEqual([])
  })

  // ⚠️ 这条是真实语料标定时发现的坑：名册里有「陶有根」时，普通短语「没有根」「也有根」
  // 正好是「某字 + 有根」的等长窗口，会被当成「陶有根」的异姓写法（同 #96「任九」的坑）。
  // 收窄方式是「变体首字不能是虚词/功能字」，复用 prose-flavor 那份封闭语法类。
  it('does not mistake an ordinary phrase for a drifted name (「没有根」≠「X有根」)', () => {
    expect(findCastNameDriftInChapter(ch(1,
      '那件事没有根由。他也有根绳。大家都有一根蜡烛。'), ['陶有根'])).toEqual([])
    expect(CAST_NAME_DRIFT_BLOCKED_HEADS.has('没')).toBe(true)
    expect(CAST_NAME_DRIFT_BLOCKED_HEADS.has('也')).toBe(true)
    expect(CAST_NAME_DRIFT_BLOCKED_HEADS.has('都')).toBe(true)
  })

  it('still catches a real drift whose surname is not a function character', () => {
    expect(findCastNameDriftInChapter(ch(1, '邵德昌站在门口。'), ['柯德昌'])[0])
      ?.toMatchObject({ variant: '邵德昌', canonical: '柯德昌' })
  })

  it('stays quiet on a chapter with no names at all', () => {
    expect(findCastNameDriftInChapter(ch(1, '船开了。风从舷边过去。'), ROSTER)).toEqual([])
    expect(findCastNameDriftInChapter(ch(1, ''), ROSTER)).toEqual([])
  })
})

describe('findCastNameDrift (issue #102 cross-chapter)', () => {
  const ROSTER = ['周叙', '陆敬堂', '邵德昌']
  const book = [
    ch(4, '陆敬堂在外廊收下那张纸。'),
    ch(9, '陆敬堂把底册合上。'),
    ch(23, '“穆敬堂调东码头了，这一摊归你。”'),
    ch(24, '周叙想起穆敬堂。'),
  ]

  it('aggregates the same variant across chapters into one hit', () => {
    const hits = findCastNameDrift(book, ROSTER)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.variant).toBe('穆敬堂')
    expect(hits[0]!.canonical).toBe('陆敬堂')
    expect(hits[0]!.chapters).toEqual([23, 24])
  })

  it('keeps a stable identity independent of which chapter is written', () => {
    // 判据出的「身份」不随章号漂（key 在 findings 层拼装，不带章号）。
    const before = findCastNameDrift(book, ROSTER)[0]!
    const after = findCastNameDrift([...book, ch(25, '穆敬堂仍在东码头。')], ROSTER)[0]!
    expect(before.variant).toBe(after.variant)
    expect(before.canonical).toBe(after.canonical)
  })
})

describe('findCastNameDriftFindings (issue #102 finding shape)', () => {
  const ROSTER = ['周叙', '陆敬堂', '邵德昌']
  const book = [
    ch(4, '陆敬堂在外廊收下那张纸。'),
    ch(23, '“穆敬堂调东码头了，这一摊归你。”'),
  ]

  it('reports one finding with the drift, the canonical name and both chapters', () => {
    const findings = findCastNameDriftFindings({ chapters: book, castNames: ROSTER })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('cast:name-drift:陆敬堂:穆敬堂')
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.sourceChapter).toBe(23)
    expect(findings[0]!.evidence).toContain('穆敬堂')
    expect(findings[0]!.evidence).toContain('陆敬堂')
  })

  it('hands over two executable exits (fix the typo / register a new person)', () => {
    const finding = findCastNameDriftFindings({ chapters: book, castNames: ROSTER })[0]!
    expect(finding.suggestion.zhCN).toContain('改回「陆敬堂」')
    expect(finding.suggestion.zhCN).toContain('建档')
    expect(finding.suggestion.enUS.length).toBeGreaterThan(40)
  })

  it('mentions that the wrong form leaks into the fact ledger', () => {
    // issue 的核心论点：这条比普通错字严重，因为错误会被账本继承、越往后越难改。
    const finding = findCastNameDriftFindings({ chapters: book, castNames: ROSTER })[0]!
    expect(finding.issue.zhCN).toContain('账本')
  })

  it('does not embed the chapter number in the key — an ack must stick (issues #86/#89/#98)', () => {
    const at23 = findCastNameDriftFindings({ chapters: book, castNames: ROSTER })[0]!
    const at24 = findCastNameDriftFindings({
      chapters: [...book, ch(24, '穆敬堂仍在。')], castNames: ROSTER,
    })[0]!
    expect(at23.stableFactKey).toBe(at24.stableFactKey)
  })

  it('produces nothing when the roster is empty', () => {
    expect(findCastNameDriftFindings({ chapters: book, castNames: [] })).toEqual([])
  })
})
