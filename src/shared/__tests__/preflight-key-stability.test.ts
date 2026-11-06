import { describe, expect, it } from 'vitest'

import {
  findDialogueOpenerConvergence,
  findEntranceShotFindings,
  findExpandedContinuityRisks,
  findOpeningShapeConvergence,
  findPendingLandingConvergence,
  findUltimatumStreak,
} from '../consistency-preflight'
import { lossRestatementReviewFindings } from '../loss-restatement-review'
import { findUndatedStreakFindings } from '../chapter-time-anchor'
import { deadlineReviewFindings } from '../deadline-review'
import { findRepeatedRevocationFindings } from '../repeated-revocation'
import { findDuplicateChapterTitleFindings } from '../chapter-title-uniqueness'
import { handwritingReviewFindings } from '../handwriting-review'
import { findQuoteStyleDriftFindings } from '../quote-style'
import { auditFinalizedProse } from '../finalized-prose-audit'
import { declaredCharacterCountFindings } from '../consistency-preflight'
import { findUnmetTimeAnchorFindings } from '../chapter-time-anchor'
import { findInventoryShortfallFindings } from '../inventory-count'
import { findGaugeScaleMismatches } from '../gauge-scale'
import { findRepeatedSentenceFindings, findShortSentenceReuseFindings } from '../repeated-sentence'
import { promisePolarityFindings } from '../promise-polarity-review'
import { findTitleBodyMismatchFindings } from '../title-body-mismatch'
import { glyphRadicalFindings } from '../glyph-radical'
import { findCastNameDriftFindings } from '../cast-name-drift'
import type { ConsistencyFinding } from '../consistency-preflight'

/**
 * 类级属性测试（issue #108 的建议 3）。
 *
 * 「提醒 key 里带了会变的东西（当前章号 / 末章号），ack 精确匹配 → 永远关不掉」
 * 这条缺陷在本仓已经犯过 **4 次**：#86（cast:absent）、#89（时间推进）、#98（开篇句）、
 * #108（正文重复 stillness/staging/posture）。前三次都是「修一处、下一轮又在新代码里犯一次」，
 * 因为每一处的测试都只盯自己那一条。
 *
 * 这条测试换一个问法：**把所有写前预检的判据挂在同一份样本上，逐个问
 * 「只把 `currentChapter` 加一，你的 `stableFactKey` 变了吗？」** —— 变了就是同一个坑。
 *
 * 为什么这是正确的判据：这些 finding 说的都是「**已经写下的那几章**里存在某种形态」，
 * 与「你正要写第几章」无关。所以同一个问题在下一章被重算时必须是同一个 key，
 * 否则作者点「我已知，稍后处理」只静音当章。
 *
 * 唯一允许 key 随 currentChapter 变的例外是 `cast:absent`：它的 key 里带 `last`（上次出场章），
 * 而那正是一条会随写作推进**变化**的事实（他真回来了就是新问题）。但它也**不含** currentChapter。
 */
const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })
const CAST = ['周叙', '温珩', '全叔']

/** 一本「三族写法都固定 + 有人缺动机」的样本：足以让所有判据都有话可说。 */
const SAMPLE_BOOK: ReadonlyArray<{ chapterNumber: number; content: string }> = Array.from(
  { length: 14 },
  (_, index) => ch(index + 1, [
    `第${index + 1}章：周叙蹲在铺位前核舱。`,
    '“怎么了？”周叙没动。',
    '他把存根从内襟抽出来，折好塞进内襟。',
    '全叔蹲在桩边绕绳圈。',
    '他把票根按在湿处，背面墨翻上来。',
    '半个“温”字。左边半边，立人旁。',
    // 自报计数与引出实体不符（issue #131）：让这条判据在该样本上确实有话可说。
    '他在“核清”后头添了六个字——核至本班次为止。',
    '穆敬堂调东码头了。',
    '周叙没答。',
  ].join('\n\n')),
)

// issue #118/#115 的判据也要挂上同一份属性测试（key 不能随章节推进而漂）。
const QUOTE_STYLE_BOOK = [
  ...Array.from({ length: 10 }, (_, i) => ({ chapterNumber: i + 1, content: Array.from({ length: 8 }, () => '“话。”').join('') })),
  { chapterNumber: 11, content: Array.from({ length: 9 }, () => '「话。」').join('') },
  ...Array.from({ length: 6 }, (_, i) => ({ chapterNumber: i + 12, content: Array.from({ length: 7 }, () => '“话。”').join('') })),
]

const BLUEPRINTS = [
  { chapterNumber: 1, keyEvents: '周叙登船。', foreshadowing: '留待第 3 章揭开「最薄那册」' },
  { chapterNumber: 3, keyEvents: '★【收束：物件落幅】周叙合上账本。' },
]

/**
 * issue #111：末句收敛需要 10 章窗口里 ≥4 章的**末句**都写成
 * 「物 + 未完结标记 + 句首没有人」。SAMPLE_BOOK 的末句全是「穆敬堂调东码头了。」（有人名），
 * 一条都命中不了，拿它测这条判据会是**空转**（本仓吃过空转测试的亏）——所以单独造一份。
 */
const PENDING_LANDING_BOOK: ReadonlyArray<{ chapterNumber: number; content: string }> = Array.from(
  { length: 12 },
  (_, index) => ch(index + 1, [
    `第${index + 1}章：周叙蹲在铺位前核舱。`,
    '他把存根折好塞进内襟。',
    index % 3 === 0 ? '桌面上只剩一摊黑墨。' : (index % 3 === 1 ? '舵轮偏着半圈，没人扶正。' : '红还没洗掉。'),
  ].join('\n\n')),
)

/** 跑一遍「写前预检」里能离线跑的全部判据。 */
function allFindings(currentChapter: number): ConsistencyFinding[] {
  const cast = [
    { name: '周叙', role: 'protagonist', motivation: '查清父亲失踪', seenChapters: 14 },
    { name: '温珩', role: 'supporting', motivation: '守住船行', seenChapters: 14 },
    { name: '全叔', role: 'supporting', motivation: '', seenChapters: 14 },
  ]
  return [
    ...findExpandedContinuityRisks({
      currentChapter,
      blueprints: [
        { chapterNumber: 1, characters: ['周叙'] },
        { chapterNumber: 2, characters: ['周叙'] },
      ],
      cast,
      threads: [],
    }),
    ...findUltimatumStreak({ chapters: SAMPLE_BOOK, currentChapter }),
    ...findPendingLandingConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    ...findOpeningShapeConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    ...findDialogueOpenerConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    // 同一笔遗忘那一族已改成模型判据（#163），这里直接喂它的产出转 findings 那一段：
    // key 锚在**损失本身**上，不带会滚动的章号。
    ...lossRestatementReviewFindings([{ referent: '三个结', chapterNumbers: [19, 20], quoteChapterNumber: 19, quote: '那里空了', explanation: '' }]),
    ...findEntranceShotFindings({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    ...findUndatedStreakFindings(SAMPLE_BOOK, currentChapter),
    ...glyphRadicalFindings(SAMPLE_BOOK),
    ...findCastNameDriftFindings({ chapters: SAMPLE_BOOK, castNames: CAST }),
    ...auditFinalizedProse({ chapters: SAMPLE_BOOK, castNames: CAST, blueprints: BLUEPRINTS }),
  ]
}

describe('no preflight key may change when only currentChapter advances (issue #108)', () => {
  const keys = (currentChapter: number) => allFindings(currentChapter).map(finding => finding.stableFactKey)

  it('the sample actually exercises the detectors (guards against a vacuous test)', () => {
    // 否则「key 没变」可能只是因为一条都没产出（本仓吃过空转测试的亏）。
    expect(allFindings(15).length).toBeGreaterThan(3)
  })

  it('every key is identical at currentChapter = N, N+1 and N+2', () => {
    const base = keys(15)
    expect(base.length).toBeGreaterThan(0)
    expect(keys(16)).toEqual(base)
    expect(keys(17)).toEqual(base)
  })

  it('enumerates each producer separately so a future regression names the culprit', () => {
    // 分开跑，失败信息里能直接看出是哪个判据的 key 漂了（合在一起只能看到一串 key）。
    const producers: ReadonlyArray<[string, (currentChapter: number) => ConsistencyFinding[]]> = [
      ['findExpandedContinuityRisks', n => findExpandedContinuityRisks({
        currentChapter: n,
        blueprints: [{ chapterNumber: 1, characters: ['周叙'] }, { chapterNumber: 2, characters: ['周叙'] }],
        cast: [{ name: '温珩', role: 'supporting', motivation: '守着', seenChapters: 14 }],
        threads: [],
      })],
      ['findUltimatumStreak', n => findUltimatumStreak({ chapters: SAMPLE_BOOK, currentChapter: n })],
      ['findPendingLandingConvergence', n => findPendingLandingConvergence({ chapters: PENDING_LANDING_BOOK, castNames: CAST, currentChapter: n })],
      ['findOpeningShapeConvergence', n => findOpeningShapeConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter: n })],
      ['findDialogueOpenerConvergence', n => findDialogueOpenerConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter: n })],
      ['lossRestatementReviewFindings', () => lossRestatementReviewFindings([{ referent: '三个结', chapterNumbers: [19, 20], quoteChapterNumber: 19, quote: '那里空了', explanation: '' }])],
      ['findEntranceShotFindings', n => findEntranceShotFindings({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter: n })],
      ['findUndatedStreakFindings', n => findUndatedStreakFindings(SAMPLE_BOOK, n)],
      ['glyphRadicalFindings', () => glyphRadicalFindings(SAMPLE_BOOK)],
      ['findCastNameDriftFindings', () => findCastNameDriftFindings({ chapters: SAMPLE_BOOK, castNames: CAST })],
      ['auditFinalizedProse', () => auditFinalizedProse({ chapters: SAMPLE_BOOK, castNames: CAST, blueprints: BLUEPRINTS })],
      // 期限那一族已改成模型判据（#163），这里直接喂它的产出转 findings 那一段：
      // key 锚在**期限制**上（同形于旧实现），不带会滚动的章号。
      ['deadlineReviewFindings', () => deadlineReviewFindings([{ chapterNumber: 1, quote: '明早交不出就完了。', deadline: '明早交完', explanation: '' }])],
      ['findRepeatedRevocationFindings', () => findRepeatedRevocationFindings({
        ledger: [{ chapterNumber: 1, costs: '从此不能再上柜台' }, { chapterNumber: 12, costs: '柜台从此不能再用' }],
        prose: SAMPLE_BOOK, castNames: CAST,
      })],
      ['findDuplicateChapterTitleFindings', () => findDuplicateChapterTitleFindings({
        chapters: [{ chapterNumber: 1, title: '压印' }, { chapterNumber: 2, title: '压印的' }],
      })],
      ['findQuoteStyleDriftFindings', () => findQuoteStyleDriftFindings(QUOTE_STYLE_BOOK)],
      ['declaredCharacterCountFindings', () => SAMPLE_BOOK.flatMap(chapter => declaredCharacterCountFindings(chapter))],
      ['findUnmetTimeAnchorFindings', () => findUnmetTimeAnchorFindings([
        { chapterNumber: 1, content: '他推开舱门。', keyEvents: '【时点：同日夜】' },
        { chapterNumber: 2, content: '他推开舱门。', keyEvents: '【时点：次日清晨】' },
      ])],
      ['findInventoryShortfallFindings', () => findInventoryShortfallFindings([
        { chapterNumber: 57, content: '清库名单。无编号薄本六册。靛蓝短褂一件。旧航次账抄件一册。' },
        { chapterNumber: 58, content: '三样东西码成一排：无编号薄本在左；靛蓝短褂在中；旧航次账抄件在右。' },
      ])],
      ['findGaugeScaleMismatches', () => findGaugeScaleMismatches([
        { chapterNumber: 1, content: '吃水线的刻痕往水里沉了半指。半指，多一个人。三十二张票。' },
        { chapterNumber: 59, content: '船尾吃水刻痕比空载时沉出一指。票三十二张。' },
      ])],
      ['findRepeatedSentenceFindings', () => findRepeatedSentenceFindings([
        { chapterNumber: 59, content: '周叙看了两息，指腹按进印泥，压在栏上。' },
        { chapterNumber: 60, content: '船开了。周叙看了两息，指腹按进印泥，压在栏上。' },
      ])],
      // issue #163 第七批：规则侧 promise-polarity.ts 已下线，key 稳定性由新模块的 findings 承担
      // （章号是既成事实 + 原句前缀，重复执行同 key）。
      ['promisePolarityFindings', () => promisePolarityFindings([{
        firstChapterNumber: 60, secondChapterNumber: 63,
        firstQuote: '「答应我。座号不写进任何册。」', secondQuote: '「你答应过写进册。」', explanation: '',
      }])],
      ['findTitleBodyMismatchFindings', () => findTitleBodyMismatchFindings([
        { chapterNumber: 67, title: '温珩按住了那一角布', content: '周叙把布铺在舵板上。', castNames: ['周叙', '温珩'] },
      ])],
      ['findShortSentenceReuseFindings', () => findShortSentenceReuseFindings([
        { chapterNumber: 34, content: '脑子里空了一块。' },
        { chapterNumber: 43, content: '脑子里空了一块。' },
        { chapterNumber: 52, content: '脑子里空了一下。' },
        { chapterNumber: 67, content: '脑子里空了一块。' },
      ], CAST)],
      // 笔迹那一族已改成模型判据（#163），这里直接喂它「产出转 findings」的那一段：
      // 同样要满足「key 不含会滚动的章号」——它锚在书写者身上。
      ['handwritingReviewFindings', () => handwritingReviewFindings([{
        owner: '温珩', chapterNumber: 1, quote: '温珩的笔稳、匀，起笔带锋。',
        conflictingChapterNumber: 2, conflictingQuote: '温珩的笔，横折收得急。', explanation: '',
      }])],
    ]
    for (const [name, produce] of producers) {
      const at15 = produce(15).map(finding => finding.stableFactKey)
      const at16 = produce(16).map(finding => finding.stableFactKey)
      const at17 = produce(17).map(finding => finding.stableFactKey)
      expect(at16, `${name} key drifted between currentChapter 15 and 16`).toEqual(at15)
      expect(at17, `${name} key drifted between currentChapter 15 and 17`).toEqual(at15)
    }
  })
})
