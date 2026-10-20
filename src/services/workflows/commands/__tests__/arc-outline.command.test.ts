import { describe, expect, it } from 'vitest'

import { assertArcSegmentAcceptable } from '../arc-outline.command'

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

  it('拒绝连续复用同一 beat 的段', () => {
    expect(() => assertArcSegmentAcceptable(
      `## 第1–40章：形态重复
beat: setup
主角觉醒。`,
      1, 3000, [], ['setup', 'setup', 'setup'],
    )).toThrow('ARC_BEAT_REPEATED')
  })

  it('拒绝缺少 beat 的段', () => {
    expect(() => assertArcSegmentAcceptable(
      `## 第1–40章：无 beat
主角觉醒。`,
      1, 3000, [], [],
    )).toThrow('ARC_PARSE_MISSING_BEAT')
  })
})
