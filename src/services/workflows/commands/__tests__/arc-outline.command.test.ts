import { describe, expect, it } from 'vitest'

import { acceptArcSegmentWithNameFallback, assertArcSegmentAcceptable } from '../arc-outline.command'

/**
 * 粗纲验证闸门的契约测试。命令本体依赖工作流运行时，这里锁定
 * 逐层闸门的判定顺序与错误码：解析 → 段长 → 人名 → 形态。
 */

describe('assertArcSegmentAcceptable', () => {
  it('接受合规段并解析出全部字段', () => {
    const segment = assertArcSegmentAcceptable(
      `## 第1–40章：学院觉醒
beat: setup
主角觉醒异常能力，被学院破格录取，却发现代价是记忆。`,
      1, 3000, ['林越', '苏婉'], [],
    )
    expect(segment).toMatchObject({ fromChapter: 1, toChapter: 40, title: '学院觉醒', beat: 'setup' })
  })

  it('拒绝与期望起始章不一致的段', () => {
    expect(() => assertArcSegmentAcceptable(
      `## 第5–40章：错位
beat: setup
主角觉醒。`,
      1, 3000, [], [],
    )).toThrow('ARC_OUTLINE_RANGE_GAP')
  })

  it('拒绝段长越下限的段', () => {
    expect(() => assertArcSegmentAcceptable(
      `## 第1–5章：太短
beat: setup
主角觉醒。`,
      1, 3000, [], [],
    )).toThrow('ARC_SPAN_TOO_SMALL')
  })

  it('收官段不足下限但铺到末章时接受，别的段不行', () => {
    // 回归：一键生成全部粗纲要覆盖全书。40 章的书切到第 23 章起时只剩 18 章，
    // 模型按提示词收口到末章，这一步过去会被 ARC_SPAN_TOO_SMALL 判死，永远铺不满。
    expect(assertArcSegmentAcceptable(
      `## 第23–40章：终局收束
beat: climax
主角追查到最后，支线在此交汇，全书收束。`,
      23, 40, [], [],
    )).toMatchObject({ fromChapter: 23, toChapter: 40, beat: 'climax' })
    // 同样的短段只要没铺到末章，仍然拒绝。
    expect(() => assertArcSegmentAcceptable(
      `## 第23–30章：切碎了
beat: climax
主角追查。`,
      23, 40, [], [],
    )).toThrow('ARC_SPAN_TOO_SMALL')
  })

  it('拒绝段长越上限的段', () => {
    expect(() => assertArcSegmentAcceptable(
      `## 第1–500章：太长
beat: setup
主角觉醒。`,
      1, 3000, [], [],
    )).toThrow('ARC_SPAN_TOO_LARGE')
  })

  it('拒绝出现角色名的段并报出命中名单', () => {
    expect(() => assertArcSegmentAcceptable(
      `## 第1–40章：有人名
beat: setup
林越觉醒异常能力，苏婉病重。`,
      1, 3000, ['林越', '苏婉'], [],
    )).toThrow('ARC_OUTLINE_PROPER_NAME_FOUND:林越,苏婉')
  })

  it('出现人名时不再整段失败，而是按角色定位换成身份词后接受', () => {
    // 回归：模型偶尔会在「不许写人名」的规则下仍写出「林越」，过去这会让整段作废。
    const { segment, replacedNames } = acceptArcSegmentWithNameFallback(
      `## 第1–40章：学院觉醒
beat: setup
林越觉醒异常能力，被学院破格录取，却发现代价是记忆。`,
      1, 3000, ['林越'], [], new Map([['林越', 'protagonist']]),
    )
    expect(replacedNames).toEqual(['林越'])
    expect(segment.summary).toBe('主角觉醒异常能力，被学院破格录取，却发现代价是记忆。')
    expect(segment.summary).not.toContain('林越')
    expect(segment).toMatchObject({ fromChapter: 1, toChapter: 40, title: '学院觉醒', beat: 'setup' })
  })

  it('没有人名时原样接受，不做任何替换', () => {
    const { segment, replacedNames } = acceptArcSegmentWithNameFallback(
      `## 第1–40章：学院觉醒
beat: setup
主角觉醒异常能力。`,
      1, 3000, ['林越'], [], new Map([['林越', 'protagonist']]),
    )
    expect(replacedNames).toEqual([])
    expect(segment.summary).toBe('主角觉醒异常能力。')
  })

  it('换成身份词之后仍要过其余闸门（段长、beat 多样性不被放过）', () => {
    expect(() => acceptArcSegmentWithNameFallback(
      `## 第1–5章：太短
beat: setup
林越觉醒。`,
      1, 3000, ['林越'], [], new Map([['林越', 'protagonist']]),
    )).toThrow('ARC_SPAN_TOO_SMALL')
  })

  it('拒绝连续复用同一 beat 的段', () => {
    expect(() => assertArcSegmentAcceptable(
      `## 第1–40章：形态重复
beat: setup
主角觉醒。`,
      1, 3000, [], ['setup', 'setup', 'setup'],
    )).toThrow('ARC_BEAT_REPEATED')
  })

  it('缺少 beat 时用中性形态兜底，不再整段作废', () => {
    expect(assertArcSegmentAcceptable(
      `## 第1–40章：无 beat
主角觉醒。`,
      1, 3000, [], [],
    )).toMatchObject({ beat: 'escalation' })
  })
})
