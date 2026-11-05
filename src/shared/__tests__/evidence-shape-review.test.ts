import { describe, expect, it } from 'vitest'

import {
  EVIDENCE_SHAPE_RECENT_CHAPTERS,
  buildEvidenceShapePrompt,
  evidenceShapeFindings,
  parseEvidenceShapeReview,
} from '../evidence-shape-review'

/**
 * issue #156：被当作证据的物件（一枚指印）在两个相邻章里换形态，
 * 而那个形态被归因到一个人身上并不存在的部位。
 *
 * 现场原文（定稿正文）：
 * - ch73「签名旁压着半个红指印，**圆圆的**，比父亲的拇指小一圈。」
 * - ch74「落款旁那半个红印。**缺口齐整**。缺了半节的**拇指**按的。」「他右手**小指**缺半节。」
 * - ch45「叶九的**拇指**压在页面中段，压得实。」（拇指完好）
 *
 * 这一族原先没有任何一层看：`appearance-consistency` 判的是「正文与**角色卡**相悖」，
 * 这里正文与卡并不矛盾（卡上写的就是小指缺半节）——矛盾在**正文内部**。
 *
 * ⚠️ issue 建议的「部位一致性核对」（缺/残词表 × 部位词表 × 按印词表）是禁令针对的形态，
 * 所以整条交模型；规则只负责摆样本、校验两处引文可定位。
 */
const chapters = [
  { chapterNumber: 45, content: '“上半页。”叶九的拇指压在页面中段，压得实，“下半页不在我手里。”' },
  { chapterNumber: 73, content: '周叙低头。父亲的名字在签名栏，墨色比旁边深。签名旁压着半个红指印，圆圆的，比父亲的拇指小一圈。' },
  { chapterNumber: 74, content: '“落款旁那半个红印。”周叙往箱盖上点了点，“缺口齐整。缺了半节的拇指按的。”\n\n“不拆。提叶九来对指印。他右手小指缺半节。”\n\n叶九按了。抬起来，印子缺一角，缺口齐整。' },
]

const cards = [{
  name: '叶九',
  appearance: '灰布长衫，袖口和指甲缝里嵌着洗不掉的墨垢，右小指缺半节，随身带铜墨盒与一把压纸的竹尺。',
  notes: '改账时必用竹尺压纸；右手小指的旧伤是沉船那夜留下的。',
}]

describe('buildEvidenceShapePrompt (issue #156)', () => {
  it('feeds the chapters and the cast cards together', () => {
    const { user } = buildEvidenceShapePrompt({ chapters, cards, language: 'zh-CN' })
    expect(user).toContain('圆圆的')
    expect(user).toContain('缺口齐整')
    expect(user).toContain('右小指缺半节')
    expect(user).toContain('第74章')
  })

  it('states both kinds it may report and nothing else', () => {
    const { system } = buildEvidenceShapePrompt({ chapters, cards, language: 'zh-CN' })
    expect(system).toContain('same-object-drift')
    expect(system).toContain('impossible-cause')
    // 只许报这两类：否则模型会把「物证没再出现」这类正常延续也报上来。
    expect(system).toContain('只报下面这两类问题')
  })

  it('excludes changes the prose itself explains', () => {
    const { system } = buildEvidenceShapePrompt({ chapters, cards, language: 'zh-CN' })
    // 被擦掉/被换掉/在这章被弄坏 —— 正文交代过就不算矛盾。
    expect(system).toContain('自己交代过')
  })

  it('does not build any word list for traces or body parts (user 2026-11-05 定规)', () => {
    const { system, user } = buildEvidenceShapePrompt({ chapters, cards, language: 'zh-CN' })
    // 判据必须靠「按意思判断」，不许出现「命中以下词之一」这种形态。
    expect(system).toContain('按**意思**判断')
    expect(system).not.toMatch(/以下词|命中任一|封闭集合/u)
    // 提示词里出现「指印」「拇指」只可能来自我们喂进去的样本，不该是判据自己写死的表。
    expect(system).not.toContain('指印')
    expect(user.includes('指印')).toBe(true)
  })

  it('bounds how many chapters it reads', () => {
    expect(EVIDENCE_SHAPE_RECENT_CHAPTERS).toBeLessThanOrEqual(24)
  })
})

describe('parseEvidenceShapeReview (issue #156)', () => {
  const request = { chapters }

  const drift = {
    kind: 'same-object-drift',
    chapterNumber: 74,
    quote: '缺口齐整。缺了半节的拇指按的。',
    conflictingChapterNumber: 73,
    conflictingQuote: '签名旁压着半个红指印，圆圆的',
    explanation: '同一枚印前章是圆的，本章有缺口',
  }

  it('keeps a report whose two quotes both locate verbatim', () => {
    const parsed = parseEvidenceShapeReview(JSON.stringify({ issues: [drift] }), request)
    expect(parsed).toEqual([drift])
  })

  it('drops reports with a kind outside the two allowed', () => {
    const parsed = parseEvidenceShapeReview(JSON.stringify({ issues: [{ ...drift, kind: 'stale-duration' }] }), request)
    expect(parsed).toEqual([])
  })

  it('drops the report when the conflicting quote is not in the chapter it names', () => {
    // 模型把 ch73 的句子说成 ch45 的 → 作者按它去核会翻空。
    const wrongChapter = { ...drift, conflictingChapterNumber: 45 }
    expect(parseEvidenceShapeReview(JSON.stringify({ issues: [wrongChapter] }), request)).toEqual([])
  })

  it('drops the report when either quote cannot be found at all', () => {
    expect(parseEvidenceShapeReview(JSON.stringify({ issues: [{ ...drift, quote: '缺口整整齐齐' }] }), request)).toEqual([])
    expect(parseEvidenceShapeReview(JSON.stringify({ issues: [{ ...drift, conflictingQuote: '圆圆的红指印' }] }), request)).toEqual([])
  })

  it('drops reports about chapters outside the request and rejects bad JSON', () => {
    expect(parseEvidenceShapeReview(JSON.stringify({ issues: [{ ...drift, chapterNumber: 199 }] }), request)).toEqual([])
    expect(parseEvidenceShapeReview('{not json', request)).toBeNull()
    expect(parseEvidenceShapeReview(JSON.stringify({ contradictions: [] }), request)).toBeNull()
  })

  it('dedupes the same report twice', () => {
    expect(parseEvidenceShapeReview(JSON.stringify({ issues: [drift, drift] }), request)).toHaveLength(1)
  })
})

describe('evidenceShapeFindings (issue #156)', () => {
  const drift = {
    kind: 'same-object-drift' as const,
    chapterNumber: 74,
    quote: '缺口齐整。缺了半节的拇指按的。',
    conflictingChapterNumber: 73,
    conflictingQuote: '签名旁压着半个红指印，圆圆的',
    explanation: '同一枚印前章圆、本章有缺口',
  }
  const cause = {
    kind: 'impossible-cause' as const,
    chapterNumber: 74,
    quote: '缺了半节的拇指按的',
    conflictingChapterNumber: 45,
    conflictingQuote: '叶九的拇指压在页面中段，压得实',
    explanation: '缺半节的是小指，拇指完好',
  }

  it('names both sides in the evidence so the author can locate them', () => {
    const [finding] = evidenceShapeFindings([drift])
    expect(finding!.stableFactKey).toBe('prose:evidence-shape:74')
    expect(finding!.sourceChapter).toBe(74)
    expect(finding!.evidence).toContain('缺口齐整')
    expect(finding!.evidence).toContain('圆圆的')
    expect(finding!.evidence).toContain('第73章')
  })

  it('distinguishes drift from an impossible cause in the wording', () => {
    const [driftFinding] = evidenceShapeFindings([drift])
    const [causeFinding] = evidenceShapeFindings([cause])
    expect(driftFinding!.issue.zhCN).toContain('形态')
    expect(causeFinding!.issue.zhCN).toContain('成因')
    expect(causeFinding!.issue.zhCN).toContain('物理上不成立')
  })

  it('merges several problems in one chapter into one finding (ack must not swallow the rest)', () => {
    const findings = evidenceShapeFindings([drift, cause])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidence).toContain('圆圆的')
    expect(findings[0]!.evidence).toContain('拇指压在页面中段')
    // 两种问题并存时文案要说清楚，作者才知道要改到哪一步。
    expect(findings[0]!.issue.zhCN).toContain('形态与成因')
  })

  it('offers two mutually exclusive repairs and points at the fact ledger', () => {
    const [finding] = evidenceShapeFindings([drift])
    expect(finding!.suggestion.zhCN).toContain('按物证重写推理')
    expect(finding!.suggestion.zhCN).toContain('按推理改物证')
    // 账本会把这条证据原样收下并注入后续起草 —— 修完必须同步。
    expect(finding!.suggestion.zhCN).toContain('事实账本')
  })

  it('gives the English side too', () => {
    const [finding] = evidenceShapeFindings([drift])
    expect(finding!.issue.enUS).toContain('evidence')
    expect(finding!.suggestion.enUS).toContain('fact ledger')
  })
})