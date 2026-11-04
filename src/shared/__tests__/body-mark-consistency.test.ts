import { describe, expect, it } from 'vitest'

import { declaredBodyMarks, findBodyMarkSideConflicts } from '../body-mark-consistency'

const CARD = {
  name: '叶九',
  appearance: '灰布长衫，袖口和指甲缝里嵌着洗不掉的墨垢，右小指缺半节，随身带铜墨盒与一把压纸的竹尺。',
  notes: '改账时必用竹尺压纸；右手小指的旧伤是沉船那夜留下的，酒后会说漏一句当年的事。',
}
const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

/**
 * issue #153：角色卡说「右小指缺半节」，正文第 51 章写成左手。
 *
 * 而全仓唯一碰 appearance 的判据只判「卡上有没有外貌」——**正文写了什么它完全不知道**，
 * 「用错了」更不判。而左右与部位都是闭合词类，机器本可以判。
 */
describe('declaredBodyMarks (issue #153)', () => {
  it('anchors on the marker and takes the part nearest to it', () => {
    // 「右手虎口留着一道旧疤」——先取「右手」会把部位停在「手」，
    // 从「疤」往回看才会遇到「虎口」，那才是被描述的部位。
    expect(declaredBodyMarks('右手虎口留着一道旧疤')).toEqual([{ side: '右', part: '虎口', marker: '疤' }])
  })

  it('reads the issue’s real card', () => {
    expect(declaredBodyMarks(`${CARD.appearance}；${CARD.notes}`)).toContainEqual({ side: '右', part: '小指', marker: '缺' })
  })

  it('ignores marks without a side, because there is nothing to contradict', () => {
    // 「背驼手粗」是体态，没有左右——不构成可对账的侧别。
    expect(declaredBodyMarks('背驼手粗，指节被咸水泡得发白')).toEqual([])
  })

  it('is structural: another card, another part', () => {
    expect(declaredBodyMarks('左肩有一道被缆绳勒出的旧疤')).toEqual([{ side: '左', part: '肩', marker: '疤' }])
  })
})

describe('findBodyMarkSideConflicts (issue #153)', () => {
  it('flags the real line that flipped 右小指 to 左手', () => {
    const [hit] = findBodyMarkSideConflicts(
      [ch(51, '笑停在脸上。叶九的左手从袖里出来，缺半节的小指往后一收。')],
      [CARD],
    )
    expect(hit).toBeDefined()
    expect(hit!.stableFactKey).toBe('character:body-mark-side:51:叶九:小指')
    expect(hit!.evidence).toContain('右小指')
    expect(hit!.issue.zhCN).toContain('左手')
  })

  it('stays silent when the chapter writes the card’s side', () => {
    for (const line of [
      '叶九站在桌对面，右手垂下，缺半节的小指缩在掌心里。',
      '袖口一圈墨垢，右手小指缺了半节，扣在账脊上。',
    ]) {
      expect(findBodyMarkSideConflicts([ch(45, line)], [CARD]), line).toEqual([])
    }
  })

  it('stays silent when the sentence uses the other hand for something else', () => {
    // 「左手接过册子，右小指缺半节」是合法句：左手在动作，右小指在被描述。
    expect(findBodyMarkSideConflicts(
      [ch(45, '叶九左手接过册子。右小指缺半节，扣在账脊上。')], [CARD],
    )).toEqual([])
  })

  it('does not treat a plain action with the other hand as a contradiction', () => {
    // 没有标记词的句子没有左右可言 —— 「叶九左手把册子推过来」不是特征描述。
    expect(findBodyMarkSideConflicts([ch(45, '叶九左手把册子推过来。')], [CARD])).toEqual([])
  })

  it('does not attribute across sentences without the character name', () => {
    // 代词主语判不准指向谁 —— 不猜（与 #144/#149 同一条）。
    expect(findBodyMarkSideConflicts([ch(45, '她左手抬起来，缺半节的小指往后一收。')], [CARD])).toEqual([])
  })

  it('keys on the chapter and the part, so it does not drift as the book advances', () => {
    const base = findBodyMarkSideConflicts([ch(51, '叶九的左手从袖里出来，缺半节的小指往后一收。')], [CARD])[0]!.stableFactKey
    const later = findBodyMarkSideConflicts([
      ch(51, '叶九的左手从袖里出来，缺半节的小指往后一收。'), ch(90, '又一章。'),
    ], [CARD])[0]!.stableFactKey
    expect(later).toBe(base)
  })

  it('stays silent without appearance cards: nothing was declared, so nothing can be contradicted', () => {
    expect(findBodyMarkSideConflicts([ch(51, '叶九的左手从袖里出来，缺半节的小指往后一收。')], [])).toEqual([])
  })
})
