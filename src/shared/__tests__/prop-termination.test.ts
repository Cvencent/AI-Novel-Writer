import { describe, expect, it } from 'vitest'

import { findRepeatPropTermination } from '../prop-termination'

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