import { describe, expect, it } from 'vitest'
import { parseOutlineNavigation } from '../outline-navigation'

/**
 * 大纲导航：把「一整篇大纲」切成可点的条目，让作者能从右侧列表跳到任意一段/任意一章，
 * 而不是只能从第 1 章往下滚。
 */
describe('parseOutlineNavigation', () => {
  it('细纲按章切，章号与标题都取出来', () => {
    const text = [
      '# 细纲',
      '',
      '## 第1章：雾钟',
      '林越在旧港听见第一声钟。',
      '',
      '## 第2章：北堤',
      '他顺着潮位找到第二处刻痕。',
    ].join('\n')
    const items = parseOutlineNavigation(text)
    expect(items.map(item => [item.kind, item.label, item.chapterFrom, item.chapterTo])).toEqual([
      ['chapter', '第1章：雾钟', 1, 1],
      ['chapter', '第2章：北堤', 2, 2],
    ])
    // 定位用的锚点必须能在原文里找到，编辑器才能跳过去
    for (const item of items) expect(text).toContain(item.heading)
  })

  it('粗纲按段切，区间以 from–to 呈现', () => {
    const text = [
      '## 第 1–20 章：废核与第一块残片',
      'beat: setup · 状态: confirmed',
      '',
      '方向一。',
      '',
      '## 第 21–45 章：学院暗流',
      'beat: rising · 状态: draft',
      '',
      '方向二。',
    ].join('\n')
    const items = parseOutlineNavigation(text)
    expect(items.map(item => [item.label, item.chapterFrom, item.chapterTo])).toEqual([
      ['第 1–20 章：废核与第一块残片', 1, 20],
      ['第 21–45 章：学院暗流', 21, 45],
    ])
  })

  it('小节标题本身不算条目（只认真正的章/段标题）', () => {
    const text = [
      '## 一句话前提',
      '当高三生觉醒空白源核……',
      '',
      '## 第3章：真相',
      '正文。',
    ].join('\n')
    expect(parseOutlineNavigation(text).map(i => i.label)).toEqual(['第3章：真相'])
  })

  it('空文本与没有章标题时返回空列表，不抛错', () => {
    expect(parseOutlineNavigation('')).toEqual([])
    expect(parseOutlineNavigation('# 细纲\n\n还没有内容。')).toEqual([])
    expect(parseOutlineNavigation('')).toEqual([])
  })

  it('容错：中英文破折号、半角/全角冒号、多余空格都认', () => {
    const text = [
      '## 第 5-9 章: 转折点',
      '## 第10 – 12章：收束',
      '##第13章：无空格',
    ].join('\n')
    const items = parseOutlineNavigation(text)
    expect(items.map(i => [i.chapterFrom, i.chapterTo])).toEqual([[5, 9], [10, 12], [13, 13]])
  })
})
