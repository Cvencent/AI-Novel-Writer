import { describe, expect, it } from 'vitest'
import {
  ARC_MAX_CHAPTERS, ARC_MIN_CHAPTERS,
  findCharacterNames, validateArcNoProperNames, validateArcSpan, validateBeatDiversity,
} from '../arc-outline-contract'

describe('validateArcSpan', () => {
  it('接受区间内跨度', () => {
    expect(validateArcSpan(1, 30, 3000)).toEqual({ ok: true })
    expect(validateArcSpan(1, ARC_MIN_CHAPTERS, 3000)).toEqual({ ok: true })
    expect(validateArcSpan(1, ARC_MAX_CHAPTERS, 3000)).toEqual({ ok: true })
  })
  it('拒绝小于下限', () => {
    expect(validateArcSpan(1, 10, 3000)).toEqual({ ok: false, code: 'ARC_SPAN_TOO_SMALL' })
  })
  it('拒绝大于上限', () => {
    expect(validateArcSpan(1, 500, 3000)).toEqual({ ok: false, code: 'ARC_SPAN_TOO_LARGE' })
  })
  it('拒绝越界', () => {
    expect(validateArcSpan(1, 3001, 3000)).toEqual({ ok: false, code: 'ARC_SPAN_OUT_OF_BOUNDS' })
    expect(validateArcSpan(0, 30, 3000)).toEqual({ ok: false, code: 'ARC_SPAN_OUT_OF_BOUNDS' })
    expect(validateArcSpan(30, 20, 3000)).toEqual({ ok: false, code: 'ARC_SPAN_OUT_OF_BOUNDS' })
  })
})

describe('findCharacterNames', () => {
  it('找出正文中的角色名', () => {
    expect(findCharacterNames('林越进入学院', ['林越', '苏婉'])).toEqual(['林越'])
  })
  it('角色名不在正文时返回空数组', () => {
    expect(findCharacterNames('无名者走入雨中', ['林越'])).toEqual([])
  })
  it('忽略过短的名字并去重', () => {
    expect(findCharacterNames('林越与林越', ['林越', '林越', '越'])).toEqual(['林越'])
  })
})

describe('validateArcNoProperNames', () => {
  it('有人名时不通过并返回命中名单', () => {
    expect(validateArcNoProperNames('林越追查父亲下落', ['林越'])).toEqual({ ok: false, found: ['林越'] })
  })
  it('无人名时通过', () => {
    expect(validateArcNoProperNames('主角追查父亲下落', ['林越'])).toEqual({ ok: true })
  })
})

describe('validateBeatDiversity', () => {
  it('最近 3 段同 beat 时不通过', () => {
    expect(validateBeatDiversity('setup', ['setup', 'setup', 'setup'])).toEqual({ ok: false, code: 'ARC_BEAT_REPEATED' })
  })
  it('beat 不同时通过', () => {
    expect(validateBeatDiversity('reversal', ['setup', 'setup', 'setup'])).toEqual({ ok: true })
  })
  it('历史不足窗口时通过', () => {
    expect(validateBeatDiversity('setup', ['setup', 'setup'])).toEqual({ ok: true })
  })
})
