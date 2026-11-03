import { describe, expect, it } from 'vitest'

import {
  findDialogueOpenerConvergence,
  findEntranceShotFindings,
  findExpandedContinuityRisks,
  findLossRestatementFindings,
  findOpeningShapeConvergence,
  findParagraphOpenerFindings,
  findPropHandoverFindings,
  findPropRevivalFindings,
  findRepeatPropTerminationFindings,
  findUltimatumStreak,
} from '../consistency-preflight'
import { findUndatedStreakFindings } from '../chapter-time-anchor'
import { findUnsettledDeadlineFindings } from '../deadline-settlement'
import { findRepeatedRevocationFindings } from '../repeated-revocation'
import { auditFinalizedProse } from '../finalized-prose-audit'
import { proseRepetitionFindings } from '../prose-repetition'
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
    '穆敬堂调东码头了。',
    '周叙没答。',
  ].join('\n\n')),
)

const BLUEPRINTS = [
  { chapterNumber: 1, keyEvents: '周叙登船。', foreshadowing: '留待第 3 章揭开「最薄那册」' },
  { chapterNumber: 3, keyEvents: '★【收束：物件落幅】周叙合上账本。' },
]

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
    ...findOpeningShapeConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    ...findDialogueOpenerConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    ...findRepeatPropTerminationFindings({ chapters: SAMPLE_BOOK, currentChapter }),
    ...findLossRestatementFindings({ chapters: SAMPLE_BOOK, currentChapter }),
    ...findPropRevivalFindings({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    ...findEntranceShotFindings({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    ...findParagraphOpenerFindings({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter }),
    ...findPropHandoverFindings({ chapters: SAMPLE_BOOK, currentChapter }),
    ...findUndatedStreakFindings(SAMPLE_BOOK, currentChapter),
    ...proseRepetitionFindings(SAMPLE_BOOK, currentChapter, CAST),
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
      ['findOpeningShapeConvergence', n => findOpeningShapeConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter: n })],
      ['findDialogueOpenerConvergence', n => findDialogueOpenerConvergence({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter: n })],
      ['findRepeatPropTerminationFindings', n => findRepeatPropTerminationFindings({ chapters: SAMPLE_BOOK, currentChapter: n })],
      ['findLossRestatementFindings', n => findLossRestatementFindings({ chapters: SAMPLE_BOOK, currentChapter: n })],
      ['findPropRevivalFindings', n => findPropRevivalFindings({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter: n })],
      ['findEntranceShotFindings', n => findEntranceShotFindings({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter: n })],
      ['findParagraphOpenerFindings', n => findParagraphOpenerFindings({ chapters: SAMPLE_BOOK, castNames: CAST, currentChapter: n })],
      ['findPropHandoverFindings', n => findPropHandoverFindings({ chapters: SAMPLE_BOOK, currentChapter: n })],
      ['findUndatedStreakFindings', n => findUndatedStreakFindings(SAMPLE_BOOK, n)],
      ['proseRepetitionFindings', n => proseRepetitionFindings(SAMPLE_BOOK, n, CAST)],
      ['glyphRadicalFindings', () => glyphRadicalFindings(SAMPLE_BOOK)],
      ['findCastNameDriftFindings', () => findCastNameDriftFindings({ chapters: SAMPLE_BOOK, castNames: CAST })],
      ['auditFinalizedProse', () => auditFinalizedProse({ chapters: SAMPLE_BOOK, castNames: CAST, blueprints: BLUEPRINTS })],
      ['findUnsettledDeadlineFindings', n => findUnsettledDeadlineFindings({ chapters: SAMPLE_BOOK, currentChapter: n })],
      ['findRepeatedRevocationFindings', () => findRepeatedRevocationFindings({
        ledger: [{ chapterNumber: 1, costs: '从此不能再上柜台' }, { chapterNumber: 12, costs: '柜台从此不能再用' }],
        prose: SAMPLE_BOOK, castNames: CAST,
      })],
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
