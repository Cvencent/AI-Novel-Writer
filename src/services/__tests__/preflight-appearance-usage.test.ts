import { describe, expect, it } from 'vitest'

import { appearanceUnusedMarkFindings } from '../preflight-repair'

/**
 * issue #153 第一部分：卡上的显眼标志「_这几章一次没写到_」要能被指出来。
 *
 * 现场量化（只读副本，73 章）：7 张卡 25 个显眼标志里，衣着/随身物被写 379 次、
 * 身体特征只有 30 次（12.6 倍）；全叔出场 40 余章「背驼手粗」0 次、邵广海的金戒指 0 次、
 * 周叙「眼窝很深」0 次、掌心的茧全书 1 次。
 *
 * ⚠️ 这是**提示**不是缺陷，所以两条纪律：
 * 1. 文案必须给出「这次不需要写也完全可以」的读法——否则作者会以为被要求每章都写；
 * 2. key 只锚「角色 + 那条标志」，**不带章号**——否则同一个人会被逐章重报（#160 的教训）。
 */
describe('appearanceUnusedMarkFindings (issue #153)', () => {
  const mark = {
    characterName: '邵广海',
    mark: '手上戴着金戒指',
    chapters: [12, 19, 31],
    explanation: '这几章只写了他的绸褂和身后的两个伙计',
  }

  it('names the character, the card mark, and the chapters where they appeared', () => {
    const [finding] = appearanceUnusedMarkFindings([mark])
    expect(finding!.evidence).toContain('邵广海')
    expect(finding!.evidence).toContain('手上戴着金戒指')
    expect(finding!.evidence).toContain('12、19、31')
    // sourceChapter 指向最近那一章（作者回头看的位置）。
    expect(finding!.sourceChapter).toBe(31)
  })

  it('keeps the key stable across chapters so one character is reported once', () => {
    const [finding] = appearanceUnusedMarkFindings([mark])
    expect(finding!.stableFactKey).toBe('character:appearance-unused:邵广海:手上戴着金戒指')
    // 不带章号：下一次核对时章号集合会变（滚动窗口），但 key 必须不变，否则 ack 永远关不掉。
    expect(finding!.stableFactKey).not.toMatch(/:\d+$/u)
    const later = appearanceUnusedMarkFindings([{ ...mark, chapters: [12, 19, 31, 40] }])
    expect(later[0]!.stableFactKey).toBe(finding!.stableFactKey)
  })

  it('says plainly that skipping it this time is fine (it is a prompt, not a defect)', () => {
    const [finding] = appearanceUnusedMarkFindings([mark])
    expect(finding!.suggestion.zhCN).toContain('完全可以')
    expect(finding!.issue.zhCN).toContain('显眼标志')
    // 说明了为什么会系统性偏向衣着：衣服和随身物每场都用得上。
    expect(finding!.issue.zhCN).toContain('道具架')
  })

  it('offers the other honest exit: delete the mark from the card', () => {
    const [finding] = appearanceUnusedMarkFindings([mark])
    // 「卡上留着、正文从不出现」会让后续判据继续按它核对——所以删卡也是合法出路。
    expect(finding!.suggestion.zhCN).toContain('删掉')
  })

  it('keeps the model explanation as a parenthetical', () => {
    const [finding] = appearanceUnusedMarkFindings([mark])
    expect(finding!.issue.zhCN).toContain('这几章只写了他的绸褂')
  })

  it('gives the English side too', () => {
    const [finding] = appearanceUnusedMarkFindings([mark])
    expect(finding!.issue.enUS).toContain('distinctive mark')
    expect(finding!.suggestion.enUS).toContain('remove it from the card')
  })

  it('says nothing when the model found no unused mark', () => {
    expect(appearanceUnusedMarkFindings([])).toEqual([])
  })
})