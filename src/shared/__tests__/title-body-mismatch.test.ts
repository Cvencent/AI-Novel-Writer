import { describe, expect, it } from 'vitest'

import { findTitleBodyMismatchFindings } from '../title-body-mismatch'

const ch = (chapterNumber: number, title: string, content: string, keyEvents = '', castNames: string[] = CAST) =>
  ({ chapterNumber, title, content, keyEvents, castNames })

const CAST = ['周叙', '温珩', '邵广海', '叶九', '柯明远', '林棠', '全叔']

/**
 * issue #144：章节标题与本章正文之间没有任何比对。
 *
 * 第 67 章标题「温珩按住了那一角布」，而该章正文里温珩没有任何动作
 * （布角是周叙自己按在舵板上读的）。
 */
describe('findTitleBodyMismatchFindings (issue #144)', () => {
  it('flags a title naming a cast member who never appears in the chapter', () => {
    // 照抄第 67 章现场：本章只有周叙在动，温珩只被顺带提了一句「从跳板那头过来」
    // 而标题说「温珩按住了那一角布」——所以这里用一份**完全不提温珩**的正文。
    const body = '周叙把布铺在舵板上，指腹压下去。「布角归我。」他读出了压在下层的三个字。'
    const [hit] = findTitleBodyMismatchFindings([ch(67, '温珩按住了那一角布', body)])
    expect(hit).toBeDefined()
    expect(hit!.stableFactKey).toBe('chapter-title:unmet:67')
    expect(hit!.evidence).toContain('温珩')
    expect(hit!.issue.zhCN).toContain('温珩按住了那一角布')
  })

  it('stays silent when the named character is on the page', () => {
    const body = '温珩从跳板那头过来。他按住那一角布，指腹压下去。'
    expect(findTitleBodyMismatchFindings([ch(67, '温珩按住了那一角布', body)])).toEqual([])
  })

  it('counts the blueprint as landing too: a character planned in keyEvents is not missing', () => {
    // 作者可能只把这一章的计划写在蓝图里（正文尚未按它写全）。
    const body = '周叙把布铺在舵板上。'
    expect(findTitleBodyMismatchFindings([
      ch(67, '温珩按住了那一角布', body, '温珩按住舵板上的那一角布，读出压在下层的三个字'),
    ])).toEqual([])
  })

  it('does not judge a chapter that has no prose yet', () => {
    // 正文还没写时「标题点到的人没出现」是必然的，不是缺陷。
    expect(findTitleBodyMismatchFindings([ch(67, '温珩按住了那一角布', '')])).toEqual([])
  })

  it('only judges cast members: an object name in the title is not this finding', () => {
    // 第 66 章标题「指印比名字早一笔」——「指印」是物不是人。
    // 按内容词判会大面积误报（实测 25/66 章），所以本判据只认名册里的人。
    const body = '周叙点了头。手伸过去，指腹按在徐汐名字的末一笔上。名字下面压着一层。'
    expect(findTitleBodyMismatchFindings([ch(66, '指印比名字早一笔', body)])).toEqual([])
  })

  it('does not flag a title that merely contains a character of a cast name', () => {
    // 「温」单字出现不算点到「温珩」（判据用完整名，不做单字匹配）。
    const body = '他把温热的碗搁下。'
    expect(findTitleBodyMismatchFindings([ch(9, '温热的一碗', body)])).toEqual([])
  })

  it('is structural: a different book with a different cast is judged the same way', () => {
    const [hit] = findTitleBodyMismatchFindings([
      ch(3, '沈砚挡下了那一刀', '周叙抬手格住。刃面在灯下泛白。', '', ['周叙', '沈砚']),
    ])
    expect(hit!.evidence).toContain('沈砚')
  })

  it('keys name the chapter, so the finding does not drift as the book advances', () => {
    const body = '周叙把布铺在舵板上。'
    const base = findTitleBodyMismatchFindings([ch(67, '温珩按住了那一角布', body)])[0]!.stableFactKey
    const later = findTitleBodyMismatchFindings([
      ch(67, '温珩按住了那一角布', body),
      ch(70, '他合上账本', '他合上账本。'),
    ])[0]!.stableFactKey
    expect(base).toBe('chapter-title:unmet:67')
    expect(later).toBe(base)
  })
})