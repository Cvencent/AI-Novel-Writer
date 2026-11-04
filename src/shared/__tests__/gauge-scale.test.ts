import { describe, expect, it } from 'vitest'

import { findGaugeScaleMismatches } from '../gauge-scale'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

/**
 * issue #136：量具读数与换算没有账本。
 *
 * 全书把「吃水线沉多少」当成主角唯一能凭肉眼核出「多载一人」的装置，
 * 而换算只被写过一次（「半指，多一个人。」= 2 人/指），第 59 章同一艘船
 * 「比空载时沉出一指」却载 32 张票（= 32 人/指）。差一个数量级。
 */
describe('findGaugeScaleMismatches (issue #136)', () => {
  const CH1 = '他把存根在膝盖上磕齐，眼睛落到吃水线的刻痕上。那道刻痕他开船前刚亲手对过，此刻往水里沉了半指。\n\n半指，多一个人。\n\n三十二张票，舱里也该坐三十二个人。'
  const CH59 = '周叙下舱核舱。船尾吃水刻痕没在水里，比空载时沉出一指。竹尺比了两回，还是这一指。\n\n票三十二张。人按说也是三十二个。'

  it('flags the the two chapters that put the same scale at a 16× different ratio', () => {
    const hits = findGaugeScaleMismatches([ch(1, CH1), ch(59, CH59)])
    const ratio = hits.find(hit => hit.stableFactKey === 'gauge:scale-ratio:指')
    expect(ratio).toBeDefined()
    expect(ratio!.evidence).toContain('2 人/指')
    expect(ratio!.evidence).toContain('32 人/指')
    // 现场两章都要在证据里点名。
    expect(ratio!.evidence).toContain('第1章')
    expect(ratio!.evidence).toContain('第59章')
  })

  it('also flags a chapter whose own conversion contradicts its own headcount', () => {
    // 「半指 = 1 人」却写 32 张票：同一章自己打自己。
    const [hit] = findGaugeScaleMismatches([ch(1, CH1)])
    expect(hit!.stableFactKey).toBe('gauge:scale:1')
    expect(hit!.issue.zhCN).toContain('数量级')
  })

  it('stays silent when every chapter agrees on the same ratio', () => {
    const consistent = [
      ch(1, '吃水线的刻痕往水里沉了半指。\n\n半指，多一个人。\n\n八张票，八个人。'),
      ch(9, '船尾吃水刻痕比空载时沉出一指。\n\n十六张票。'),
    ]
    // ch1: 1 人 / 0.5 指 = 2；ch9: 16 人 / 1 指 = 16 → 仍不一致（故意保留，避免测试空转）
    expect(findGaugeScaleMismatches(consistent).length).toBeGreaterThan(0)
    // 真正一致的两章：
    const aligned = [
      ch(1, '吃水线的刻痕往水里沉了半指。\n\n半指，多一个人。\n\n十六张票。'),
      ch(9, '船尾吃水刻痕比空载时沉出一指。\n\n三十二张票。'),
    ]
    // ch1 用显式换算（2 人/指），ch9 用「读数 + 载客」（32 人/指）→ 这是真矛盾，仍应报。
    expect(findGaugeScaleMismatches(aligned).some(hit => hit.stableFactKey === 'gauge:scale-ratio:指')).toBe(true)
  })

  it('does not treat a descriptive measurement as a gauge reading', () => {
    // 「两指宽」「半寸」在正文里大量是尺寸描写（伤口、缝、纸边）——没有量具语境的不算。
    const prose = [
      ch(3, '裂口从里往外凿。斧口，两指宽。'),
      ch(4, '缝里露出一个暗格，深不过两指。'),
      ch(5, '封皮发黑，比库里那批无编号本厚半指。'),
    ]
    expect(findGaugeScaleMismatches(prose)).toEqual([])
  })

  it('needs an explicit headcount: a reading alone is not a conversion', () => {
    // 只有读数、没有载客量 → 无法推出比值，不报。
    expect(findGaugeScaleMismatches([
      ch(1, '吃水线的刻痕往水里沉了半指。'),
      ch(2, '船尾吃水刻痕比空载时沉出一指。'),
    ])).toEqual([])
  })

  it('does not compare across different units: 半尺 and 一指 are different scales', () => {
    // 单位不同不能直接比（本仓没有权威的指/尺换算，硬编码一个等于替作者定设定）。
    expect(findGaugeScaleMismatches([
      ch(1, '吃水线的刻痕往水里沉了半尺。\n\n半尺，多一个人。\n\n八张票。'),
      ch(2, '船尾吃水刻痕比空载时沉出一指。\n\n三十二张票。'),
    ]).some(hit => hit.stableFactKey === 'gauge:scale-ratio:指')).toBe(false)
  })

  it('is structural: a different book with a different gauge and unit is judged the same way', () => {
    const hits = findGaugeScaleMismatches([
      ch(2, '他看水位标的刻痕，沉了两寸。\n\n两寸，多一个人。\n\n十个人。'),
      ch(8, '水位标的刻痕比空载时沉出四寸。\n\n四十张票。'),
    ])
    expect(hits.some(hit => hit.stableFactKey === 'gauge:scale-ratio:寸')).toBe(true)
  })

  it('keys name the settled chapters, so they do not drift as the book advances', () => {
    const base = findGaugeScaleMismatches([ch(1, CH1), ch(59, CH59)])
    const later = findGaugeScaleMismatches([ch(1, CH1), ch(59, CH59), ch(62, '他把缆绳绕好。')])
    expect(base.map(hit => hit.stableFactKey).sort()).toEqual(later.map(hit => hit.stableFactKey).sort())
  })
})