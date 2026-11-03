import { describe, expect, it } from 'vitest'

import {
  LANDING_MIN_HITS,
  LANDING_WINDOW,
  continuesPastSentence,
  endingLandingOf,
  leadsWithPerson,
  pendingLandingConvergence,
} from '../chapter-ending'
import { findPendingLandingConvergence } from '../consistency-preflight'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })
const CAST = ['周叙', '温珩', '叶九', '柯明远', '全叔']
/** 把一句末句包成一个章节（前置一段无关正文，确保取的是「最后一段的最后一句」）。 */
const endingOn = (chapterNumber: number, lastSentence: string) =>
  ch(chapterNumber, `第${chapterNumber}章：周叙蹲在铺位前核舱，把存根折好塞进内襟。\n\n${lastSentence}`)

/**
 * issue #111 报告里的逐字末句（原文照抄，用于把判据钉在真实样本上）。
 * 后 6 章是「收敛」样本，前 2 章（22/28）是前段的稀疏同类。
 */
const REPORTED_SENTENCES: ReadonlyArray<[number, string]> = [
  [22, '红还没洗掉。'],
  [28, '内襟里那张纸硌着胸口，报告已经交进去了。'],
  [36, '桌面上只剩一摊黑墨，和那只倒扣的铜墨盒。'],
  [39, '舵轮偏着半圈，没人扶正。'],
  [42, '矮桌上的茶碗盖还在那儿打转。'],
  [44, '蹭不掉。'],
  [46, '底下经手人那一栏，还锁在别人包里。'],
  [47, '灯壳里那一卷贴着掌心，还带着一线潮的凉。'],
]

describe('continuesPastSentence / leadsWithPerson (issue #111 判据)', () => {
  it('reads the reported endings as subjectless-and-pending', () => {
    for (const [chapter, sentence] of REPORTED_SENTENCES) {
      expect(endingLandingOf({ chapterNumber: chapter, content: `正文。\n\n${sentence}`, castNames: CAST }), `ch${chapter}`)
        .toBe('subjectless-pending')
    }
  })

  it('does not count a sentence that leads with a cast name or a pronoun as subjectless', () => {
    // 判据②：句首是施动者就不算。名的匹配要求**句首逐字相接**，不做「句中包含」。
    expect(leadsWithPerson('周叙手探进内襟，碰到那两张存根，湿的。', CAST)).toBe(true)
    expect(leadsWithPerson('他手里只有那半个字。', CAST)).toBe(true)
    expect(leadsWithPerson('桌面上只剩一摊黑墨。', CAST)).toBe(false)
    // ⚠️ 标定对齐：第 6 章「温珩刚才站过的地方…」**句首就是人名**，故判据②不成立、不进命中集
    // （与 issue 的逐章结果 [3,22,36,39,42,44,46,47] 一致）；而「顶缺的伙计睡在温珩隔壁铺」
    // 只是句中提到某人，句首不是人 → 仍算候选（第 32 章）。
    expect(leadsWithPerson('温珩刚才站过的地方，木头还是湿的。', CAST)).toBe(true)
    expect(leadsWithPerson('顶缺的伙计睡在温珩隔壁铺。', CAST)).toBe(false)
  })

  it('does not treat a plain declarative as pending', () => {
    expect(endingLandingOf({ chapterNumber: 12, content: '正文。\n\n缆绳从桩上滑下去，跳板收起，船身往外荡开半尺。', castNames: CAST }))
      .toBe('other')
    expect(endingLandingOf({ chapterNumber: 38, content: '正文。\n\n外廊风灯点起来了，灯影把库门那道水痕照得发亮。', castNames: CAST }))
      .toBe('other')
  })

  it('excludes a comparative 「比…还…」 from the still-pending marker', () => {
    // ⚠️ 标定踩到：第 3 章「换锁的人来得比他回船还快」是「比…还…」的比较级。
    expect(continuesPastSentence('换锁的人来得比他回船还快。')).toBe(false)
    expect(continuesPastSentence('红还没洗掉。')).toBe(true)
  })

  it('does not read a prepositional 「着」 as the durative marker', () => {
    // ⚠️ 标定踩到：0202 第 15 章「就着晨光，他把那道印子看了很久」的「就着」是介词。
    expect(continuesPastSentence('就着晨光，他把那道印子看了很久。')).toBe(false)
    expect(continuesPastSentence('底下经手人那一栏，还锁在别人包里。')).toBe(true)
    expect(continuesPastSentence('灯壳里那一卷贴着掌心。')).toBe(true)
  })

  it('does not count a bare 「没」/「不」 as pending (would flood ordinary narration)', () => {
    // 本书前 35 章大量「没有动／没答」，收了会把整本书判成收敛。
    // （「他」起头的句子本来就会被判成 subject，这里只问未完结标记本身。）
    expect(continuesPastSentence('桌面上没有灯。')).toBe(false)
    expect(continuesPastSentence('缆绳从桩上滑下去。')).toBe(false)
    expect(continuesPastSentence('蹭不掉。')).toBe(true)
  })

  it('does not classify a sentence that closes inside dialogue', () => {
    expect(endingLandingOf({ chapterNumber: 24, content: '正文。\n\n“不签，箱子当场扣下。今夜别想开船。”', castNames: CAST }))
      .toBe('other')
  })
})

describe('pendingLandingConvergence (issue #111 window 10 / min 4)', () => {
  /** 12 章：末句全部是「无人称 + 未完结」，窗口内 12 章命中。 */
  const allPending = Array.from({ length: 12 }, (_, index) =>
    endingOn(index + 1, index % 2 === 0 ? '桌面上只剩一摊黑墨。' : '舵轮偏着半圈，没人扶正。'))

  it('fires when the recent window is dominated by the same landing', () => {
    const hit = pendingLandingConvergence(allPending.map(item => ({ ...item, castNames: CAST })))
    expect(hit).not.toBeNull()
    expect(hit!.window).toHaveLength(LANDING_WINDOW)
    expect(hit!.hits.length).toBeGreaterThanOrEqual(LANDING_MIN_HITS)
  })

  it('stays silent when the same book starts with ordinary, varied endings', () => {
    // 前段样本：末句是人物动作 / 画面定格（没有未完结标记），一条都不该命中。
    const front = [
      endingOn(1, '周叙把话咽了回去。'),
      endingOn(2, '周叙上跳板，把条子按到栏板上，手掌抹平。'),
      endingOn(3, '温珩跟上，赤脚踩过石板。'),
      endingOn(4, '他扶着舵轮，站定了。'),
    ]
    expect(pendingLandingConvergence(front.map(item => ({ ...item, castNames: CAST })))).toBeNull()
  })

  it('requires the window chapters to be consecutive', () => {
    // 中间挖掉一章（没导入）→ 不算一条链（同 #66/#71）。
    const gapped = allPending.filter(item => item.chapterNumber !== 6)
    expect(pendingLandingConvergence(gapped.map(item => ({ ...item, castNames: CAST })))).toBeNull()
  })

  it('returns null when there are fewer chapters than the window', () => {
    expect(pendingLandingConvergence(
      allPending.slice(0, LANDING_WINDOW - 1).map(item => ({ ...item, castNames: CAST })),
    )).toBeNull()
  })
})

describe('findPendingLandingConvergence (issue #111 finding shape)', () => {
  const chapters = Array.from({ length: 12 }, (_, index) =>
    endingOn(index + 1, index % 2 === 0 ? '桌面上只剩一摊黑墨。' : '矮桌上的茶碗盖还在那儿打转。'))

  it('names the window, the hitting chapters and the share', () => {
    const findings = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 13 })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.evidence).toContain('10')
    expect(findings[0]!.evidence).toContain('只剩')
  })

  it('keeps the key stable as the book advances (issues #86/#89/#98/#108)', () => {
    // key 锚在「哪一种落点收敛」上、**不带章号**：带末章号的 key 会每章都变、永远关不掉。
    const finding = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 13 })[0]!
    expect(finding.stableFactKey).toBe('chapter-ending:subjectless-pending')
    expect(finding.stableFactKey).not.toMatch(/:1[0-9]$/u)
  })

  it('hands over actionable exits (land on a person, on speech, or cut away)', () => {
    const finding = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 13 })[0]!
    expect(finding.suggestion.zhCN).toContain('落在人身上')
    expect(finding.suggestion.zhCN).toContain('切断')
    expect(finding.suggestion.enUS).toContain('Alternate')
  })

  it('says nothing when every chapter ends on a person acting', () => {
    const ok = Array.from({ length: 12 }, (_, index) => endingOn(index + 1, '周叙把封皮压平，起身往舱门走。'))
    expect(findPendingLandingConvergence({ chapters: ok, castNames: CAST, currentChapter: 13 })).toEqual([])
  })
})