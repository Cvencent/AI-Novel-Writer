import { describe, expect, it } from 'vitest'

import { findAnnihilatedPropRevival, findRepeatPropTermination } from '../prop-termination'
import { findPropRevivalFindings, findRepeatPropTerminationFindings } from '../consistency-preflight'

/** issue #73 报告里的两章原文（照抄，把判据钉在真实样本上）。 */
const CH27 = '全叔活动了一下胳膊，走到绞盘边蹲下。绳圈上三个结，他一个一个解开，解得很慢。解完，把绳头往滚筒底下一塞。'
const CH29 = '他把绞盘下的绳圈翻过来，露出底下压死的三个结。剪子伸进去，一下，一下，一下。结断了，断头落进滚筒底下。'

describe('findRepeatPropTermination (issue #73)', () => {
  it('flags the rope knots terminated once in ch27 and again in ch29', () => {
    const hits = findRepeatPropTermination([
      { chapterNumber: 27, content: CH27 },
      { chapterNumber: 29, content: CH29 },
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.prop).toBe('三个结')
    expect(hits[0]!.chapters).toEqual([27, 29])
    // 证据要能让人直接看到那两句话。
    expect(hits[0]!.excerpts[0]).toContain('一个一个解开')
  })

  it('is structural: a different prop and different actions also fire', () => {
    const hits = findRepeatPropTermination([
      { chapterNumber: 4, content: '他把那枚铜钥匙扔下河，看着它沉掉。' },
      { chapterNumber: 6, content: '周叙从抽屉里翻出那枚铜钥匙，拿走了。' },
    ])
    // 「那枚铜钥匙」与「铜钥匙」是同一件东西，至少报出一条。
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.chapters).toEqual([4, 6])
  })

  it('does not flag a prop terminated only once', () => {
    expect(findRepeatPropTermination([
      { chapterNumber: 27, content: CH27 },
      { chapterNumber: 28, content: '周叙把页按在湿板上蘸水溯读。' },
    ])).toEqual([])
  })

  it('does not flag the same prop mentioned without a terminal action', () => {
    // 「三个结」在两章都出现，但只有一章真的处理了它——那是正常的前后呼应。
    expect(findRepeatPropTermination([
      { chapterNumber: 20, content: '全叔蹲在桩边，绳圈上三个结塞在底下，绳头压得死紧。' },
      { chapterNumber: 27, content: '绳圈上三个结，他一个一个解开，解得很慢。' },
    ])).toEqual([])
  })

  it('stays silent when the two chapters are too far apart to be a contradiction', () => {
    // 隔了 20 章时读者早已不记得那件东西，重新出现更像新引入。
    expect(findRepeatPropTermination([
      { chapterNumber: 5, content: '他把铜钥匙扔下河。' },
      { chapterNumber: 25, content: '他翻出铜钥匙，又剪断了。' },
    ])).toEqual([])
  })

  it('does not treat a question about the prop as terminating it', () => {
    expect(findRepeatPropTermination([
      { chapterNumber: 3, content: '三个结要解开吗？他问自己。' },
      { chapterNumber: 5, content: '三个结，他一个一个解开。' },
    ])).toEqual([])
  })

  it('reports the widest case first and caps the list', () => {
    const many = Array.from({ length: 6 }, (_, index) => ([
      { chapterNumber: index * 2 + 1, content: `他把第${index}号证物烧掉。` },
      { chapterNumber: index * 2 + 2, content: `他翻出第${index}号证物，剪断了。` },
    ])).flat()
    const hits = findRepeatPropTermination(many)
    expect(hits.length).toBeLessThanOrEqual(4)
  })

  it('ignores empty chapters', () => {
    expect(findRepeatPropTermination([
      { chapterNumber: 1, content: '' },
      { chapterNumber: 2, content: '   ' },
    ])).toEqual([])
  })
})

/** issue #77 报告里的收纳句与 #78 报告里的票根线（照抄）。 */
const CH25_STOW = '周叙把签收联和纸片叠在一处，塞进风灯罩里。'
const CH26_TAKE_OUT = '周叙把签收联从灯罩里抽出来，展开递到灯下。'
const CH26_STOW_AGAIN = '周叙展开看了一眼，折回原样，和签收联一起塞进风灯罩。'

describe('issue #77: 收纳句不再被当成终结', () => {
  it('does not treat 塞进 (stowing) as a terminal action', () => {
    // 「塞进风灯罩」是收纳：下一章就「从灯罩里抽出来」了，中间没有任何东西「没了」。
    // 旧实现把它算成终结，一条收纳句同时产出「签收联」与「塞进风灯罩」两条误报。
    const hits = findRepeatPropTermination([
      { chapterNumber: 25, content: CH25_STOW },
      { chapterNumber: 26, content: [CH26_TAKE_OUT, CH26_STOW_AGAIN].join(String.fromCharCode(10) + String.fromCharCode(10)) },
    ])
    expect(hits).toEqual([])
  })

  it('never uses an action verb inside the reported prop name', () => {
    // 锚点必须是名词性片段：「同一个物证『塞进风灯罩』」作者根本不知道指哪件东西。
    const hits = findRepeatPropTermination([
      { chapterNumber: 25, content: '他把那枚印章压死在一张纸上。' },
      { chapterNumber: 26, content: '他把印章又压死了一遍。' },
    ])
    for (const hit of hits) {
      expect(hit.prop).not.toContain('压死')
      expect(hit.prop).not.toContain('塞进')
    }
  })

  it('still reports the real ch27/ch29 rope-knot case', () => {
    // 删掉「塞进」不能伤到 #73 的真阳性。
    const hits = findRepeatPropTermination([
      { chapterNumber: 27, content: '绳圈上三个结，他一个一个解开，解得很慢。' },
      { chapterNumber: 29, content: '露出底下压死的三个结。剪子伸进去，一下，一下，一下。' },
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.prop).toBe('三个结')
    expect(hits[0]!.chapters).toEqual([27, 29])
  })

  it('merges one sentence that yields two names into a single finding', () => {
    // 旧去重靠「名字互相包含」，「签收联 / 塞进风灯罩」互不包含且章号相同，于是报两遍。
    const hits = findRepeatPropTermination([
      { chapterNumber: 25, content: '周叙把签收联烧掉了。' },
      { chapterNumber: 26, content: '他又把签收联烧掉一遍。' },
    ])
    const sameChapters = hits.filter(hit => hit.chapters.join(',') === '25,26')
    expect(sameChapters).toHaveLength(1)
  })
})

describe('issue #78: 被写死的物证又自己回来', () => {
  const CH21 = ['票根表面起毛，纸芯吸饱了水，一按就塌。第三下，纸面从中间酥开，碎成几片，沾在他掌心的茧上，一捻就烂。', '没了。'].join(String.fromCharCode(10) + String.fromCharCode(10))
  const CH22 = '晨光斜进来，纸是干的。票根昨夜泡碎了，他读不了，只把指尖点在装订线那侧一个极小的字上。'
  const CH28 = '他把那页按在湿板上，从怀里摸出空白票根，蘸水压上去。'
  const CH30 = '他把票根蘸了潮，压上去。'

  it('flags the ticket stub that comes back five chapters after being destroyed', () => {
    const hits = findAnnihilatedPropRevival([
      { chapterNumber: 21, content: CH21 },
      { chapterNumber: 22, content: CH22 },
      { chapterNumber: 28, content: CH28 },
      { chapterNumber: 30, content: CH30 },
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.prop).toBe('票根')
    // 消亡取**最早**那一章（读者第一次读到它没了的地方），不因第 22 章又确认一次而报两遍。
    expect(hits[0]!.annihilatedAt).toBe(21)
    expect(hits[0]!.appearedAt).toEqual([28, 30])
  })

  it('does not flag a prop that was re-acquired on the page', () => {
    // 有「重新获得」动作时不是自行复活。
    expect(findAnnihilatedPropRevival([
      { chapterNumber: 21, content: CH21 },
      { chapterNumber: 28, content: '他向全叔讨了一张空白票根，从怀里摸出来蘸水压上。' },
    ])).toEqual([])
  })

  it('does not flag a prop that simply never comes back', () => {
    expect(findAnnihilatedPropRevival([
      { chapterNumber: 21, content: CH21 },
      { chapterNumber: 28, content: '他把那页按在湿板上，指尖点在装订线那侧。' },
    ])).toEqual([])
  })

  it('stays silent when the revival is too far away to read as a contradiction', () => {
    expect(findAnnihilatedPropRevival([
      { chapterNumber: 1, content: CH21 },
      { chapterNumber: 40, content: CH28 },
    ])).toEqual([])
  })

  it('recognises the irreversible-damage wording the book actually uses', () => {
    // 旧动作表里没有「泡酥/酥开/碎成/化成浆」这一族，而本书用它们写过两次损失。
    const hits = findAnnihilatedPropRevival([
      { chapterNumber: 8, content: '原页在水里化成浆，捞不起来。' },
      { chapterNumber: 12, content: '他把原页取出来，压在湿板上。' },
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.prop).toBe('原页')
  })
})

describe('issue #79: 提醒必须指向证据所在的章，而不是正在写的这一章', () => {
  it('names the evidence chapters on the prop-termination finding', () => {
    const chapters = [
      { chapterNumber: 27, content: '绳圈上三个结，他一个一个解开，解得很慢。' },
      { chapterNumber: 29, content: '露出底下压死的三个结。剪子伸进去，一下，一下，一下。' },
    ]
    // currentChapter 是 31（正在写的章），而证据在第 27/29 章。
    const [finding] = findRepeatPropTerminationFindings({ chapters, currentChapter: 31 })
    expect(finding!.sourceChapter).toBe(29)
    expect(finding!.sourceChapter).not.toBe(31)
    expect(finding!.evidence).toContain('第 27、29 章')
  })

  it('names the revival chapter on the prop-revival finding', () => {
    const chapters = [
      { chapterNumber: 21, content: ['票根表面起毛，纸芯吸饱了水，一按就塌。第三下，纸面从中间酥开，碎成几片，沾在他掌心的茧上，一捻就烂。', '没了。'].join(String.fromCharCode(10)) },
      { chapterNumber: 28, content: '他从怀里摸出空白票根，蘸水压上去。' },
    ]
    const [finding] = findPropRevivalFindings({ chapters, currentChapter: 31 })
    // 证据的最后一章是 28（它又出现的那一章），不是正在写的 31。
    expect(finding!.sourceChapter).toBe(28)
    expect(finding!.evidence).toContain('第 21 章被写没了')
  })
})
