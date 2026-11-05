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

  it('states the kinds it may report and nothing else', () => {
    const { system } = buildEvidenceShapePrompt({ chapters, cards, language: 'zh-CN' })
    expect(system).toContain('same-object-drift')
    expect(system).toContain('impossible-cause')
    // issue #182：第三档「保管关系」（谁持有 / 锁没锁 / 哪个房间）也进来了。
    expect(system).toContain('custody-drift')
    // 只许报这几类：否则模型会把「物证没再出现」这类正常延续也报上来。
    expect(system).toContain('只报下面这三类问题')
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
/**
 * issue #182：物证本身没复活、没换容器，换的是**保管关系与所在场所**
 * （谁持有、锁没锁、在哪个房间）——这一层原来全仓没有任何判据。
 *
 * 现场：ch78/79 柯明远亲手把铜墨盒锁进自己的私柜、「手在锁上压着，没挪开」；
 * ch82 同一把柜子「没锁死」、钥匙在**管物人**腰上，全章没有一句交接。
 * 而 ch82 整章的推理（湿印、指甲痕、谁动的）全都建立在「柜子锁着、钥匙在柯明远手上」这个前提上。
 */
describe('保管关系突变 (issue #182)', () => {
  const custodyRequest = {
    chapters: [
      { chapterNumber: 78, content: '盒子进了私柜。钥匙在锁孔里转了一圈，铜扣按紧。私柜靠墙。柯明远的手在锁上压着，没挪开。' },
      { chapterNumber: 82, content: '办公楼墙边，私柜挂着一把锁，没锁死。柜门拉开，铜墨盒不在。“锁没撬。钥匙在我腰上。”' },
    ],
    language: 'zh-CN' as const,
  }

  it('asks about the keeper, the locked state and the room as a third axis', () => {
    const { system } = buildEvidenceShapePrompt(custodyRequest)
    expect(system).toContain('custody-drift')
    // 三处都要在提问里点到——只问「谁持有」会漏掉「没锁死」和「房间从公所挪到办公楼」。
    expect(system).toContain('保管人')
    expect(system).toContain('锁具状态')
    expect(system).toContain('所在房间')
  })

  it('excludes a handover the prose itself narrates', () => {
    const { system } = buildEvidenceShapePrompt(custodyRequest)
    // 「正文自己写出来的交接」不算问题（如「有人把钥匙交出去」「当着人撬封」）。
    expect(system).toContain('自己写出来的')
  })

  it('accepts a custody-drift report whose two quotes locate verbatim', () => {
    const parsed = parseEvidenceShapeReview(JSON.stringify({
      issues: [{
        kind: 'custody-drift',
        chapterNumber: 82,
        quote: '私柜挂着一把锁，没锁死',
        conflictingChapterNumber: 78,
        conflictingQuote: '柯明远的手在锁上压着，没挪开',
        explanation: '同一把柜子的钥匙从柯明远换到管物人手上，没有交接',
      }],
    }), { chapters: custodyRequest.chapters })
    expect(parsed).toHaveLength(1)
    expect(parsed![0]!.kind).toBe('custody-drift')
  })

  it('words a pure custody drift differently from a shape drift', () => {
    const [custody] = evidenceShapeFindings([{
      chapterNumber: 82,
      kind: 'custody-drift',
      quote: '私柜挂着一把锁，没锁死',
      conflictingChapterNumber: 78,
      conflictingQuote: '柯明远的手在锁上压着，没挪开',
      explanation: '钥匙换了人',
    }])
    // 作者要能一眼看出「这次变的是保管关系」，而不是「形态变了」。
    expect(custody!.issue.zhCN).toContain('保管人')
    expect(custody!.issue.zhCN).toContain('交接')
    // 英文措辞用 keeper / locked state / room —— 比抽象的 custody 更能让作者对上原文。
    expect(custody!.issue.enUS).toContain('keeper')
  })
})

/**
 * issue #186：**同一个容器的内装物**换了，也算物证形态漂移。
 *
 * 现场：ch78 盒盖内沿是「一行小字」（而且底下还有一层刻上去再蘸墨描的），
 * 夹层是「一页纸」且「纸面湿透，什么也认不出」；
 * ch83 同一两个位置变成「内沿浮出**半个红印**」「墨盒**夹层的指模**」——
 * 「指模」全书仅此一次（词频实测 1 章）。而 ch83 整章的定罪链（两个缺口并排、对上了）
 * 正架在这两处上。
 *
 * 判据原来只举「一枚印、一道痕、一件信物」这类**外在形态**，没提「容器里装什么」。
 */
describe('容器内装物也算形态漂移 (issue #186)', () => {
  const request = {
    chapters: [
      { chapterNumber: 78, content: '先起的是盖内沿。一行小字浮出来，笔压匀，收锋慢。夹层那一页软下来。内沿那行还在，夹层那页已经翻开，纸面湿透，什么也认不出。' },
      { chapterNumber: 83, content: '盒盖内沿凑近水汽。指腹抹过去，干墨慢慢泛开，半个红印浮出来。叶九看了邵广海一眼。“邵把头留在墨盒夹层的指模。我代按。”' },
    ],
    language: 'zh-CN' as const,
  }

  it('states that the CONTENTS of one container count as the same axis', () => {
    const { system } = buildEvidenceShapePrompt(request)
    // 描述里要有「容器 / 里装的东西」这一层，否则模型只会看外在形态。
    expect(system).toContain('同一个容器')
    expect(system).toContain('内装物')
    // 具体到位置：盒盖内沿 / 夹层 / 柜格 / 内衬 / 封套。
    expect(system).toContain('夹层')
  })

  it('names both container locations of the reported case in the prompt guidance', () => {
    const { system } = buildEvidenceShapePrompt(request)
    // 提示词要能把「内沿是字 vs 印」「夹层是纸 vs 模」这种对照问出来。
    expect(system).toContain('盒盖内沿')
    expect(system).toContain('一处是字')
    expect(system).toContain('一页纸')
  })

  it('keeps the outer-shape wording (the #156 case must still be caught)', () => {
    const { system } = buildEvidenceShapePrompt(request)
    // 扩范围不许把原来那档挤掉：外在形态（一圆一缺）仍在描述里。
    expect(system).toContain('一圆一缺')
  })

  it('accepts a report about a container’s contents whose two quotes locate verbatim', () => {
    const parsed = parseEvidenceShapeReview(JSON.stringify({
      issues: [{
        kind: 'same-object-drift',
        chapterNumber: 83,
        quote: '半个红印浮出来',
        conflictingChapterNumber: 78,
        conflictingQuote: '一行小字浮出来',
        explanation: '同一个盒盖内沿：前章是字、本章是印',
      }],
    }), { chapters: request.chapters })
    expect(parsed).toHaveLength(1)
  })

  it('still requires both quotes to locate — a container claim is not a free pass', () => {
    expect(parseEvidenceShapeReview(JSON.stringify({
      issues: [{
        kind: 'same-object-drift',
        chapterNumber: 83,
        quote: '内沿浮出一个印',
        conflictingChapterNumber: 78,
        conflictingQuote: '一行小字浮出来',
        explanation: 'x',
      }],
    }), { chapters: request.chapters })).toEqual([])
  })
})
