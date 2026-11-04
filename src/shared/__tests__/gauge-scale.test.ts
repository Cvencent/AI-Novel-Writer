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

  /**
   * issue #139：**增量 ≠ 容量**。第 1 章那句「半指，多一个人」是增量
   * （基准是「开船前对过的刻痕」，已装 32 人；沉半指 = **多**上来一个人），
   * 不能与全船 32 人相比。上一版把它当绝对容量，于是**写每一章都误报一次**，
   * 且建议会诱使作者把全书核心装置那一句改坏。
   *
   * 而第 59 章的基准是「**空载**」——那是绝对容量。两者口径不同，不可比。
   */
  it('does not treat an incremental conversion as a capacity (issue #139)', () => {
    expect(findGaugeScaleMismatches([ch(1, CH1)])).toEqual([])
    expect(findGaugeScaleMismatches([ch(1, CH1), ch(59, CH59)])).toEqual([])
  })

  it('still flags two explicit absolute capacities that disagree', () => {
    // 两处都以空载为基准（绝对容量），比值却差 2 倍 → 报。
    const hits = findGaugeScaleMismatches([
      ch(1, '吃水刻痕比空载时沉了半指。\n\n半指，八个人。'),
      ch(9, '吃水刻痕比空载时沉出一指。\n\n三十二个人。'),
    ])
    const ratio = hits.find(hit => hit.stableFactKey === 'gauge:scale-ratio:指')
    expect(ratio).toBeDefined()
    expect(ratio!.evidence).toContain('16 人/指')
    expect(ratio!.evidence).toContain('32 人/指')
    expect(ratio!.evidence).toContain('第1章')
    expect(ratio!.evidence).toContain('第9章')
  })

  it('still flags a chapter whose own absolute conversion contradicts its own headcount', () => {
    // 绝对容量句（无增量标记）：「半指 = 1 人」却写 32 张票 → 同一章自己打自己。
    const [hit] = findGaugeScaleMismatches([ch(1, '吃水刻痕比空载时沉了半指。\n\n半指，一个人。\n\n三十二张票。')])
    expect(hit!.stableFactKey).toBe('gauge:scale:1')
    expect(hit!.issue.zhCN).toContain('数量级')
  })

  it('stays silent when two absolute capacities agree', () => {
    expect(findGaugeScaleMismatches([
      ch(1, '吃水刻痕比空载时沉了半指。\n\n半指，八个人。'),
      ch(9, '吃水刻痕比空载时沉出一指。\n\n十六个人。'),
    ])).toEqual([])
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
    // 两处都以空载为基准（绝对容量）、换量具换单位 → 判据照样成立。
    const hits = findGaugeScaleMismatches([
      ch(2, '他看水位标的刻痕，比空载时沉了两寸。\n\n两寸，八个人。'),
      ch(8, '水位标的刻痕比空载时沉出四寸。\n\n四十张票。'),
    ])
    expect(hits.some(hit => hit.stableFactKey === 'gauge:scale-ratio:寸')).toBe(true)
  })

  /**
   * issue #141：判据里的 `\s*`（数字与量词之间的空白容忍）必须真的生效。
   * 旧写法在模板串里用了单反斜杠 → 退化成字母 `s` → 在带空格的文本上静默漏匹配。
   * 这条用例专门喂带空格/全角空格的正文，否则这类缺陷永远测不出来。
   */
  it('tolerates whitespace between numbers and measure words (issue #141)', () => {
    const hits = findGaugeScaleMismatches([
      ch(1, '吃水刻痕比空载时沉了 半指 。半指 ， 八 个人。'),
      ch(9, '吃水刻痕比空载时沉出 一指 。票 三十二 张。'),
    ])
    expect(hits.some(hit => hit.stableFactKey === 'gauge:scale-ratio:指')).toBe(true)
  })

  it('keys name the settled chapters, so they do not drift as the book advances', () => {
    const base = findGaugeScaleMismatches([ch(1, CH1), ch(59, CH59)])
    const later = findGaugeScaleMismatches([ch(1, CH1), ch(59, CH59), ch(62, '他把缆绳绕好。')])
    expect(base.map(hit => hit.stableFactKey).sort()).toEqual(later.map(hit => hit.stableFactKey).sort())
  })
})