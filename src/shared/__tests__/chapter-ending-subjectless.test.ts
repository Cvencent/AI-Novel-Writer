import { describe, expect, it } from 'vitest'

import {
  LANDING_MIN_HITS,
  LANDING_WINDOW,
  continuesPastSentence,
  endingLandingOf,
  endsOnPerson,
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
/**
 * issue #197：末句「句首是物、句中有人接手」不是「没有人」。
 *
 * 现场：第 80 章末句「袖里的绳圈折着，帆布边被风掀起一角，**全叔把针拔出来**，线拖得老长。」
 * 句首是物件（先定格画面），落点在人身上——这正是 `suggestion` 要作者去做的事，
 * 旧判据却把它算成「没有人」。而这一章恰好是 10 章窗里第 4 个命中：
 * 去掉它 3/10 < 阈值 4，**整条 40% 收敛提醒一次都不会出现**（issue 的消融已验证）。
 */
describe('末句落点要看句中，不只看句首 (issue #197)', () => {
  it('counts a background-then-person ending as a person landing', () => {
    // 逐字原文（issue 证据）。
    const sentence = '袖里的绳圈折着，帆布边被风掀起一角，全叔把针拔出来，线拖得老长。'
    expect(leadsWithPerson(sentence, CAST), '句首确实是物').toBe(false)
    expect(endsOnPerson(sentence, CAST), '但收束那两拍里全叔在做动作').toBe(true)
    expect(endingLandingOf({ chapterNumber: 80, content: `正文。\n\n${sentence}`, castNames: CAST })).toBe('subject')
  })

  it('does NOT flip ch72 — 「全叔绕的绳圈」是定语，判它要靠语义，位置判据不猜', () => {
    /**
     * issue 把第 72 章也列进误判，但它和 ch80 不同类：这里的「全叔」是**定语**
     * （「全叔绕了一半的绳圈」），落点仍是那个绳圈。
     * 要判「定语里的动作算不算落在人身上」是**语义判断**，不是位置判断——
     * 按用户 2026-11-05 的定规（内容语义交模型，位置/形态才写规则），这条判据不翻转它。
     *
     * 它也不影响整条提醒：ch72 不在被报的那 10 章窗（79–88）里。
     */
    const sentence = '缆桩上剩着全叔绕了一半的绳圈。'
    expect(endsOnPerson(sentence, CAST)).toBe(false)
    expect(endingLandingOf({ chapterNumber: 72, content: `正文。\n\n${sentence}`, castNames: CAST }))
      .toBe('subjectless-pending')
  })

  it('keeps 「没人扶正」 as a subjectless ending (it says plainly that no one acted)', () => {
    // 第 39 章必须仍是命中：句中出现的「人」是「没人」，恰恰是无人称标志。
    expect(endsOnPerson('舵轮偏着半圈，没人扶正。', CAST)).toBe(false)
    expect(endingLandingOf({ chapterNumber: 39, content: '正文。\n\n舵轮偏着半圈，没人扶正。', castNames: CAST }))
      .toBe('subjectless-pending')
  })

  it('does not treat a mere mention of a name as a person landing (#111 不许因此回退)', () => {
    // 「只是句中提到某人」不是落点——#111 明确排除，本条不许把它捞回来。
    expect(endsOnPerson('顶缺的伙计睡在温珩隔壁铺，铺板窄。', CAST)).toBe(false)
  })

  it('does not look further back than the closing two beats', () => {
    // 人在很靠前的位置、收尾仍是物 → 不算人落点（否则「背景一段 + 收在物上」会全线漂白）。
    expect(endsOnPerson('全叔把绳圈绕好搁在桩上，外廊的风停了，绳头还垂着。', CAST)).toBe(false)
  })

  it('does not let a name inside dialogue create a fake clause boundary', () => {
    // 引号内的逗号先剔除，所以「他说「全叔，线还垂着」，然后转身」不会被切出以「全叔」
    // 起手的假分句。末拍「然后转身」不是人起手，前一拍「他说」是人称 → 仍算人落点是对的
    // （这一段本来就落在「他」身上）。关键是**不许靠台词里的名字蹭出来**：
    expect(endsOnPerson('绳头垂着，他停了一下，只留了「全叔」两个字。', CAST)).toBe(true)
    // 对照：引号里有人名、引号外完全没有人物 → 不算。
    expect(endsOnPerson('绳头垂着，灯影斜过去，纸上写着「全叔」。', CAST)).toBe(false)
  })
})

/**
 * issue #197 建议 ②：证据不许静默截断成 3 条。
 *
 * 现场：`hit.hits.slice(-3)` 只展示最后 3 条，被砍掉的正好是第 80 章那一条
 * （唯一句中有人物的、也就是被判错的那一条）→ 作者看到的 3 条全像是真的。
 * 而 `issue.zhCN` 里写着「命中章：80、82、85、88」——**说 4 章、只举 3 条**，
 * 两边不一致本身就会让作者以为是 3 章（#98 是同一族教训）。
 */
describe('证据要把每条命中都举出来 (issue #197 建议 ②)', () => {
  it('lists all four hits instead of silently keeping the last three', () => {
    // 四个不同章末尾句，每条都能在证据里认出来。
    const endings = ['桌面上只剩一摊黑墨。', '矮桌上的茶碗盖还在那儿打转。', '舵轮偏着半圈。', '灯壳里那一卷还带着一线潮的凉。']
    const chapters = Array.from({ length: 12 }, (_, index) =>
      ch(index + 1, `正文。\n\n${index >= 8 ? endings[index - 8]! : '周叙把封皮压平，起身往舱门走。'}`))
    const finding = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 13 })[0]!
    // 4 条命中 = 第 9、10、11、12 章，全部要出现在证据里。
    for (const chapterNumber of [9, 10, 11, 12]) {
      expect(finding.evidence, `第 ${chapterNumber} 章被截掉了`).toContain(`第${chapterNumber}章`)
    }
    expect(finding.evidence).not.toContain('未列出')
  })

  it('does not truncate at all — the window is fixed at 10 chapters, so every hit fits', () => {
    // 曾经用「字符预算 + 另 N 章未列出」兜底，但那会重新引入「按顺序丢句」的不确定性
    // （#171 的教训）。窗口固定 10 章、每条末句截 30 字 → 上限 ~400 字，全列即可。
    const chapters = Array.from({ length: 10 }, (_, index) =>
      ch(index + 1, `正文。

${'桌面上只剩一摊黑墨，纸角还压在镇纸底下没有抽走。'}`))
    const finding = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 11 })[0]!
    expect(finding.evidence).not.toContain('未列出')
    for (let chapterNumber = 1; chapterNumber <= 10; chapterNumber += 1) {
      expect(finding.evidence).toContain(`第${chapterNumber}章`)
    }
  })

  it('keeps 命中章 line and the samples consistent', () => {
    const endings = ['桌面上只剩一摊黑墨。', '矮桌上的茶碗盖还在那儿打转。', '舵轮偏着半圈。', '灯壳里那一卷还带着一线潮的凉。']
    const chapters = Array.from({ length: 12 }, (_, index) =>
      ch(index + 1, `正文。\n\n${index >= 8 ? endings[index - 8]! : '周叙把封皮压平，起身往舱门走。'}`))
    const finding = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 13 })[0]!
    const named = finding.issue.zhCN.match(/命中章：([\d、]+)/u)?.[1]?.split('、') ?? []
    expect(named).toEqual(['9', '10', '11', '12'])
    for (const chapterNumber of named) expect(finding.evidence).toContain(`第${chapterNumber}章`)
  })
})

/**
 * issue #197 建议 ③ 能做的那一小半：**临界要说出来**。
 *
 * W=10 / K=4 是在另一本书上标定的，在本书上余量只有 1 章——「刚好达线」和「明显收敛」
 * 在作者眼里是两件事：前者意味着这条提醒本身很脆（下一章换个落点就消失）。
 * 阈值没有动（按本书密度动态标定需要真实分布，不是这一轮能定的），但文案要说明临界。
 */
describe('刚好达线要说出来 (issue #197 建议 ③)', () => {
  it('flags a finding that only just reached the threshold', () => {
    // 10 章里恰好 4 章命中 = 阈值，属于临界。
    const chapters = Array.from({ length: 10 }, (_, index) =>
      ch(index + 1, `正文。\n\n${index < 4 ? '桌面上只剩一摊黑墨。' : '周叙把封皮压平，起身往舱门走。'}`))
    const finding = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 11 })[0]!
    expect(finding.evidence).toContain('刚好达到判断线')
  })

  it('does not cry borderline when the convergence is clear', () => {
    const chapters = Array.from({ length: 10 }, (_, index) =>
      ch(index + 1, `正文。\n\n${index < 6 ? '桌面上只剩一摊黑墨。' : '周叙把封皮压平，起身往舱门走。'}`))
    const finding = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 11 })[0]!
    expect(finding.evidence).not.toContain('刚好达到判断线')
  })

  it('no longer claims 「没有人」 — the criterion is 「句首不出现人」', () => {
    // 类名/文案原来写「没有人」，而第 80 章那种「物起手、人收尾」的句子恰好推翻了这个说法。
    // 判据只保证「句首不是人」，就不许把它说成「这一拍没有人」。
    const chapters = Array.from({ length: 10 }, (_, index) =>
      ch(index + 1, `正文。\n\n${index < 4 ? '桌面上只剩一摊黑墨。' : '周叙把封皮压平，起身往舱门走。'}`))
    const finding = findPendingLandingConvergence({ chapters, castNames: CAST, currentChapter: 11 })[0]!
    expect(finding.evidence).toContain('句首不出现人')
    expect(finding.evidence).not.toContain('没有人')
  })
})
