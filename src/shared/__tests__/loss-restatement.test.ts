import { describe, expect, it } from 'vitest'

import { findLossRestatement, lossWindows } from '../loss-restatement'

/** issue #75 报告里的两章原文（照抄，把判据钉在真实样本上）。 */
const CH19 = '脑子里那几个数字还钉着，一七四。可它是从哪儿来的，他答不上来。他记得自己开口要过这三个结，要它们做什么，那里空了。'
const CH20 = '周叙往绞盘那边瞥了一眼。全叔蹲在桩边，绳圈上三个结塞在底下，绳头压得死紧。他记得让全叔打过这三个结，要它们做什么，脑子里空着。'
const CH23 = '周叙盯着那三个结。他记得让全叔打过这三个结，但为什么打，脑子里空着。存根背面的字浮上来：担保人，周德海。\n\n他直起腰，脑子里有个地方空着。林棠托人递过话——这他记得。递话的人他也记得。叮嘱了什么，却像被水洇开的墨，只剩一圈空壳。'
const CH24 = '林棠托人递的那句话，他使劲想，还是空壳。售票口封着，只能等靠埠后隔墙再问。'
const CH25 = '他张了张嘴。他记得有人递过话，也记得是林棠递的。话里是什么，空的。那片空着的地方一点边都摸不着。'

describe('lossWindows', () => {
  it('finds a loss statement where remembering and absence share one sentence', () => {
    const windows = lossWindows(CH19)
    expect(windows.length).toBeGreaterThan(0)
    // 单句窗口一定在（「他记得自己开口要过这三个结，……那里空了。」）。
    expect(windows.some(window => window.text.includes('那里空了'))).toBe(true)
  })

  it('finds it across two adjacent sentences', () => {
    // 组二的关键句：「他记得有人递过话……（下一句）话里是什么，空的。」
    // 按单句判会整组漏掉。
    expect(lossWindows('他记得有人递过话。“话里是什么，空的。”')).not.toHaveLength(0)
  })

  it('does not treat an ordinary empty room as a memory loss', () => {
    // 「空着」单独出现时是环境描写，不是缺失标记——这是补回「空着」的代价。
    expect(lossWindows('铺位空着，船舱也空着。')).toEqual([])
    expect(lossWindows('他记得那间屋子的样子，铺位空着。')).toEqual([])
  })

  it('does not count a carried-over memory as a fresh statement', () => {
    // 「仍然／还是没」这类承接短语说明读者读到的是「他一直没想起来」，连续性是对的。
    expect(lossWindows('他记得那三个结，可为什么打，仍然没想起来。')).toEqual([])
  })
})

describe('findLossRestatement (issue #75)', () => {
  const book = [
    { chapterNumber: 19, content: CH19 },
    { chapterNumber: 20, content: CH20 },
    { chapterNumber: 23, content: CH23 },
    { chapterNumber: 24, content: CH24 },
    { chapterNumber: 25, content: CH25 },
  ]

  it('flags both reported groups — the rope knots and Lin Tang’s message', () => {
    const hits = findLossRestatement(book)
    expect(hits).toHaveLength(2)
    const groupByChapters = hits.map(hit => hit.chapters.join(','))
    // 组一：三个结，第 19/20/23 章各宣告一次。
    expect(groupByChapters).toContain('19,20,23')
    // 组二：林棠递的话，第 23/25 章（第 24 章那句带「还是」，按判据不算新宣告）。
    expect(groupByChapters).toContain('23,25')
    expect(hits[0]!.chapters.length).toBeGreaterThanOrEqual(hits[1]!.chapters.length)
  })

  it('names the lost thing so the author can locate it', () => {
    const [widest] = findLossRestatement(book)
    expect(widest!.referent).toContain('这三个结')
    expect(widest!.excerpt).toContain('他记得')
  })

  it('does not report a single declaration', () => {
    expect(findLossRestatement([
      { chapterNumber: 19, content: CH19 },
      { chapterNumber: 21, content: '周叙把存根按进水隔下面。' },
    ])).toEqual([])
  })

  it('does not report the same loss declared far apart', () => {
    // 隔得远时读者早已接受那是旧事，重新提起更像回指而不是新损失。
    expect(findLossRestatement([
      { chapterNumber: 3, content: CH19 },
      { chapterNumber: 25, content: CH20 },
    ])).toEqual([])
  })

  it('is structural: a different loss and different wording also fire', () => {
    const hits = findLossRestatement([
      { chapterNumber: 4, content: '他记得那枚印章的样子，可印面刻的是什么，想不起来。' },
      { chapterNumber: 5, content: '那枚印章。他记得自己见过，刻的是什么，想不起来。' },
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.chapters).toEqual([4, 5])
    // 锚点是两章缺失句的**公共子串**，所以取到的是「刻的是什么」这种共同指称，
    // 而不是某一章独有的「那枚印章」——这正说明判据抓的是「同一件东西」而不是词面。
    expect(hits[0]!.referent.length).toBeGreaterThanOrEqual(3)
  })

  it('merges overlapping anchors so one loss is not reported several times', () => {
    // 「这三个结」「让全叔打过这三个」是同一处的不同切法，章号集合互相包含。
    const hits = findLossRestatement(book)
    const knotGroup = hits.filter(hit => hit.referent.includes('结'))
    expect(knotGroup).toHaveLength(1)
  })

  it('ignores empty chapters', () => {
    expect(findLossRestatement([
      { chapterNumber: 1, content: '' },
      { chapterNumber: 2, content: '   ' },
    ])).toEqual([])
  })
})