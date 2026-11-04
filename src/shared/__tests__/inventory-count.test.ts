import { describe, expect, it } from 'vitest'

import { findEnumerationCountMismatches, findInventoryShortfallFindings } from '../inventory-count'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

/**
 * issue #133：第 57 章清库名单写「无编号薄本六册」，第 58 章筐里只有一册、也只化一册。
 *
 * 全仓此前没有任何一处做过这个比对——编号判「位」、`declared-character-count` 判「个字」、
 * 物证类判「同一件物的消亡/复活/过手」，都不看「一批物的件数」。
 */
describe('inventory counts (issue #133)', () => {
  /** 第 57 章的清单原文（照抄）。 */
  const CH57 = [
    '码头那头有人往档案房跑。周叙折过去。',
    '门上贴着一张纸。归档前清库名单。无编号薄本六册。靛蓝短褂一件。旧航次账抄件一册，经手人周德海。底下三个字：三日内化浆。',
  ].join('\n\n')
  /** 第 58 章的兑现（照抄）：声明三样，确实列了三样。 */
  const CH58 = '三样东西码成一排：无编号薄本在左，封皮发黑；靛蓝短褂叠在中间，袖口磨薄；旧航次账抄件在右，纸边卷了。'

  it('counts the real inventory as 8 items (六册 + 一件 + 一册), not 9', () => {
    // 「门上贴着一张纸」是那张告示本身，不是清单条目——量词后紧跟汉字的不算条目。
    const hits = findInventoryShortfallFindings([ch(57, CH57), ch(58, CH58)])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.evidence).toContain('合计 8 件')
    expect(hits[0]!.evidence).toContain('只列出 3 项')
    expect(hits[0]!.evidence).toContain('合计 8 件')
    expect(hits[0]!.issue.zhCN).toContain('差 5 件')
  })

  it('stays silent when the later chapter lays out the whole batch', () => {
    const complete = '八样东西码成一排：无编号薄本一；无编号薄本二；无编号薄本三；无编号薄本四；无编号薄本五；无编号薄本六；靛蓝短褂；旧航次账抄件。'
    expect(findInventoryShortfallFindings([ch(57, CH57), ch(58, complete)])).toEqual([])
  })

  it('does not pair a list with an enumeration of a different batch', () => {
    // 枚举项的物在清单原文里找不到 → 不是同一批货，不报。
    const other = '三样东西码成一排：竹筐在左，麻布在中，木牌在右。'
    expect(findInventoryShortfallFindings([ch(57, CH57), ch(58, other)])).toEqual([])
  })

  it('ignores a single count in a paragraph: that is narration, not an inventory', () => {
    // 只有一条计数的句子不是清单（「他拿了两张」），合计门槛要求同段 ≥2 条。
    const prose = '他把存根抽出来。他拿了两张，压在灯下。'
    expect(findInventoryShortfallFindings([ch(9, prose), ch(10, '三样东西码成一排：存根一；存根二；存根三。')])).toEqual([])
  })

  it('does not look beyond the window: a list is not the same batch many chapters later', () => {
    expect(findInventoryShortfallFindings([ch(1, CH57), ch(40, CH58)])).toEqual([])
  })

  it('flags a same-chapter enumeration whose item count is short', () => {
    // 「四样东西：A；B；C」——声明 4、只列 3。
    const [hit] = findEnumerationCountMismatches(ch(12, '四样东西码成一排：薄本在左；短褂在中；抄件在右。'))
    expect(hit!.stableFactKey).toBe('inventory:enumeration:12:4:3')
    expect(hit!.evidence).toContain('声明 4 项')
    expect(hit!.evidence).toContain('实际列出 3 项')
  })

  it('stays silent on a same-chapter enumeration that matches', () => {
    expect(findEnumerationCountMismatches(ch(12, '三样东西码成一排：薄本在左；短褂在中；抄件在右。'))).toEqual([])
  })

  it('does not treat a colon after a single measure word as an enumeration', () => {
    // 「一张纸：…」不是清单枚举（只有 1 项，且声明 <2）。
    expect(findEnumerationCountMismatches(ch(3, '一张纸：归档前清库名单。'))).toEqual([])
  })

  it('is structural: a different book with different items is judged the same way', () => {
    const hits = findInventoryShortfallFindings([
      ch(3, '库房里清点：铜钥匙五把。账本三册。'),
      ch(4, '摆出来的只有两样：铜钥匙在桌上；账本在抽屉里。'),
    ])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.evidence).toContain('合计 8 件')
    expect(hits[0]!.evidence).toContain('只列出 2 项')
  })

  it('keys are stable: they name the settled chapters, not the chapter being written', () => {
    const at20 = findInventoryShortfallFindings([ch(57, CH57), ch(58, CH58)])[0]!.stableFactKey
    const at30 = findInventoryShortfallFindings([ch(57, CH57), ch(58, CH58), ch(59, '他把钥匙收进袖里。')])[0]!.stableFactKey
    expect(at20).toBe('inventory:shortfall:57:58')
    expect(at30).toBe(at20)
  })
})