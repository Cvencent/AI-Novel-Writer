import { describe, expect, it } from 'vitest'

import {
  CONTAINER_DEPARTURE,
  PROP_LOCATION_PHRASES,
  PROP_STOW_ACTIONS,
  findPropContainerDepartureFindings,
  findPropContainerDepartures,
} from '../prop-relocation'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })
const CAST = ['周叙', '温珩', '叶九']

/**
 * issue #113：主线物证「那片纸角」第 14 章被收进册子衬页、册子被抽走、内衬确认空了，
 * 第 17/18 章它又在内衬里——中间没有取回动作。
 */
describe('findPropContainerDepartures (issue #113)', () => {
  const reported = [
    ch(14, '他探进内衬，抽出那片纸角，把纸角折回原样，掀开册子封底的衬页，塞进去，抹平，合上。\n\n册子被抽走了。'),
    ch(18, '他伸手把纸角抽出来。\n\n手揣回内衬，指尖碰到船牌和纸角。'),
  ]

  it('catches the reported case (收进容器 → 容器离开 → 又回到身上)', () => {
    const hits = findPropContainerDepartures(reported, CAST)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.prop).toBe('纸角')
    expect(hits[0]!.stowedAt).toBe(14)
    expect(hits[0]!.containerPhrase).toBe('衬页')
    expect(hits[0]!.returnsAt).toContain(18)
  })

  it('stays silent when the container does NOT leave (东西还在容器里)', () => {
    // 收进容器但容器一直由当事人拿着 → 没有断裂。
    expect(findPropContainerDepartures([
      ch(14, '他把纸角折回原样，掀开册子封底的衬页，塞进去，抹平，合上。'),
      ch(18, '他翻开册子，从衬页里把纸角取出来。\n\n手揣回内衬，指尖碰到纸角。'),
    ], CAST)).toEqual([])
  })

  it('stays silent when it never comes back on the body', () => {
    // 收进容器、容器离开，之后它就没再出现 → 那是**没有下文**，不是位置矛盾。
    expect(findPropContainerDepartures([
      ch(14, '他把纸角折回原样，塞进册子封底的衬页，抹平，合上。\n\n册子被抽走了。'),
      ch(18, '档案库里那卷封存的底册没人翻动。'),
    ], CAST)).toEqual([])
  })

  it('ignores an indefinite object (「一张纸」每次都是新的一个)', () => {
    expect(findPropContainerDepartures([
      ch(14, '他把一张纸折好，塞进公文包，合上。\n\n公文包被收走了。'),
      ch(18, '他从内衬里摸出一张纸，看了看。'),
    ], CAST)).toEqual([])
  })

  it('ignores destinations that merely appear in the same sentence (not adjacent to the verb)', () => {
    // 「他把箱子搁在舱口，抽出竹尺」——箱子不是「抽出」的目的地。
    expect(findPropContainerDepartures([
      ch(1, '他把箱子搁在舱口，抽出竹尺。'),
      ch(2, '他从袖里抽出竹尺，横压在那一栏上。'),
    ], CAST)).toEqual([])
  })

  it('ignores cast names picked up as objects (#80: 人不是道具)', () => {
    expect(findPropContainerDepartures([
      ch(1, '他把周叙按在册子上，塞进公文包。\n\n公文包被收走了。'),
      ch(3, '周叙在内衬里按了一下。'),
    ], CAST)).toEqual([])
  })

  it('requires the object to be stowed into a CONTAINER, not onto the body', () => {
    // 收进内衬（身体族）本来就没离开当事人 → 不算断裂。
    expect(findPropContainerDepartures([
      ch(1, '他把纸角折好，塞进内衬。\n\n内衬按了按，只剩一道折痕。'),
      ch(3, '他把纸角从内衬里摸出来。'),
    ], CAST)).toEqual([])
  })

  it('uses closed functional classes for verbs and locations (no topic word list)', () => {
    // 换一本书、换一件物，只要形态一致照样成立。
    for (const action of PROP_STOW_ACTIONS) {
      const [hit] = findPropContainerDepartures([
        ch(1, `他把木牌${action}匣子。\n\n匣子被收走了。`),
        ch(4, '他手里捏着木牌，塞回内衬。'),
      ], CAST)
      expect(hit?.prop, action).toBe('木牌')
    }
    expect(Object.keys(PROP_LOCATION_PHRASES)).toEqual(['body', 'container', 'place'])
    expect(CONTAINER_DEPARTURE.length).toBeGreaterThan(3)
  })
})

describe('findPropContainerDepartureFindings (issue #113 finding shape)', () => {
  const reported = [
    ch(14, '他探进内衬，抽出那片纸角，把纸角折回原样，掀开册子封底的衬页，塞进去，抹平，合上。\n\n册子被抽走了。'),
    ch(18, '他伸手把纸角抽出来。\n\n手揣回内衬，指尖碰到船牌和纸角。'),
  ]

  it('names the prop, the container, both chapters and the return, and stays a warning', () => {
    const findings = findPropContainerDepartureFindings(reported, CAST)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.evidence).toContain('纸角')
    expect(findings[0]!.evidence).toContain('14')
    expect(findings[0]!.evidence).toContain('18')
  })

  it('keeps the key anchored to the prop and free of chapter numbers (#86/#89/#98/#108)', () => {
    const finding = findPropContainerDepartureFindings(reported, CAST)[0]!
    expect(finding.stableFactKey).toBe('prop:container-departure:纸角')
    expect(finding.sourceChapter).toBe(14)
    // 追加一章不应改变 key。
    const longer = [...reported, ch(19, '别的事。')]
    expect(findPropContainerDepartureFindings(longer, CAST)[0]!.stableFactKey).toBe(finding.stableFactKey)
  })

  it('hands over two actionable exits (show the retrieval / change the location)', () => {
    const finding = findPropContainerDepartureFindings(reported, CAST)[0]!
    expect(finding.suggestion.zhCN).toContain('补上取回动作')
    expect(finding.suggestion.zhCN).toContain('改掉后一处的位置')
    expect(finding.suggestion.enUS).toContain('show the retrieval')
  })

  it('does not report internal/dev artifacts in user-facing copy (issue #112)', () => {
    const finding = findPropContainerDepartureFindings(reported, CAST)[0]!
    for (const text of [finding.evidence, finding.issue.zhCN, finding.issue.enUS, finding.suggestion.zhCN, finding.suggestion.enUS]) {
      expect(text).not.toMatch(/issue\s*#\d+/u)
      expect(text).not.toMatch(/样本/u)
    }
  })
})