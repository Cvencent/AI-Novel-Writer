import { describe, expect, it } from 'vitest'
import {
  ARC_MAX_CHAPTERS, ARC_MIN_CHAPTERS,
  findCharacterNames, parseArcOutlineDocument, parseArcSegment, sanitizeArcProperNames,
  validateArcNoProperNames, validateArcSpan, validateBeatDiversity,
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

describe('sanitizeArcProperNames', () => {
  it('把主角名换成「主角」，其余正文原样保留', () => {
    const input = '林越在学院竞赛中获胜，却失去了对母亲的记忆。'
    const { text, replaced } = sanitizeArcProperNames(input, ['林越'], new Map([['林越', 'protagonist']]))
    expect(text).toBe('主角在学院竞赛中获胜，却失去了对母亲的记忆。')
    expect(replaced).toEqual(['林越'])
  })

  it('按名单里的角色定位选身份词：反派 → 对手，配角 → 配角，未知 → 某位角色', () => {
    const roles = new Map([['林越', 'protagonist'], ['沈砚', 'antagonist'], ['苏婉', 'supporting'], ['无名', 'other']])
    const { text, replaced } = sanitizeArcProperNames('林越、沈砚、苏婉与无名相遇。', ['林越', '沈砚', '苏婉', '无名'], roles)
    expect(text).toBe('主角、对手、配角与某位角色相遇。')
    expect(replaced).toEqual(['林越', '沈砚', '苏婉', '无名'])
  })

  it('英文作品用英文身份词', () => {
    const { text } = sanitizeArcProperNames('Lin Yue wins the contest.', ['Lin Yue'], new Map([['Lin Yue', 'protagonist']]), 'en-US')
    expect(text).toBe('the protagonist wins the contest.')
  })

  it('没有命中时不改动正文', () => {
    const { text, replaced } = sanitizeArcProperNames('主角在学院竞赛中获胜。', ['林越'], new Map([['林越', 'protagonist']]))
    expect(text).toBe('主角在学院竞赛中获胜。')
    expect(replaced).toEqual([])
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

describe('parseArcSegment', () => {
  it('解析合法的粗纲段', () => {
    const result = parseArcSegment(`## 第1–40章：学院觉醒
beat: setup
主角觉醒异常能力，被迫进入学院。`)
    expect(result).toEqual({ ok: true, segment: {
      fromChapter: 1, toChapter: 40, title: '学院觉醒', beat: 'setup',
      summary: '主角觉醒异常能力，被迫进入学院。',
    } })
  })

  it('未知 beat 判非法', () => {
    expect(parseArcSegment(`## 第1–40章：标题
beat: 铺垫
正文。`)).toEqual({ ok: false, code: 'ARC_PARSE_ILLEGAL_BEAT' })
  })

  it('缺少 beat 时用中性形态兜底，不再整段作废', () => {
    const result = parseArcSegment(`## 第1–40章：标题
正文。`)
    expect(result).toMatchObject({ ok: true, segment: { beat: 'escalation', summary: '正文。' } })
  })

  it('正文为空判不合格', () => {
    expect(parseArcSegment(`## 第1–40章：标题
beat: setup`)).toEqual({ ok: false, code: 'ARC_PARSE_EMPTY_SUMMARY' })
  })

  it('完全没有标题行时判无段', () => {
    expect(parseArcSegment('随便一段文字')).toEqual({ ok: false, code: 'ARC_PARSE_NO_SEGMENT' })
  })

  it('容忍标题前有说明，也容忍没有井号、没有冒号、第二段带「第」', () => {
    const result = parseArcSegment(`好的，下面是这一段：
第 1 - 40 章 学院觉醒
beat: setup
主角觉醒异常能力。`)
    expect(result).toMatchObject({ ok: true, segment: { fromChapter: 1, toChapter: 40, title: '学院觉醒', beat: 'setup' } })
  })

  it('模型多吐后续段时，只保留当前这一段', () => {
    const result = parseArcSegment(`## 第1–40章：第一段
beat: setup
第一段正文。

## 第41–90章：第二段
beat: escalation
第二段正文。`)
    expect(result).toMatchObject({ ok: true, segment: { toChapter: 40, summary: '第一段正文。' } })
  })

  it('段落为空判不合格', () => {
    expect(parseArcSegment('')).toEqual({ ok: false, code: 'ARC_PARSE_NO_SEGMENT' })
  })
})

describe('parseArcOutlineDocument', () => {
  it('parses a rendered arc document back into segments without losing text', () => {
    const markdown = [
      '## 第 1–120 章：零号档案',
      'beat: setup · 状态: confirmed',
      '',
      '第一段的正文，讲主角怎么被读成零。',
      '',
      '## 第 121–300 章：低一格',
      'beat: escalation · 状态: draft',
      '',
      '第二段的正文。',
    ].join(String.fromCharCode(10))
    const segments = parseArcOutlineDocument(markdown)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ fromChapter: 1, toChapter: 120, title: '零号档案', beat: 'setup', status: 'confirmed' })
    expect(segments[0]!.summary).toContain('读成零')
    expect(segments[1]).toMatchObject({ fromChapter: 121, toChapter: 300, title: '低一格', beat: 'escalation', status: 'draft' })
    expect(segments[1]!.summary).toBe('第二段的正文。')
  })

  it('keeps edited titles and missing beat lines usable', () => {
    const segments = parseArcOutlineDocument(['## 第 1–30 章：改过的标题', '', '正文。'].join(String.fromCharCode(10)))
    expect(segments).toHaveLength(1)
    expect(segments[0]!.title).toBe('改过的标题')
    // 缺 beat 时用中性形态兜底，不丢这一段。
    expect(segments[0]!.beat).toBe('escalation')
    expect(segments[0]!.status).toBeNull()
  })
})
