import { describe, expect, it } from 'vitest'
import { isRepairableDirectJsonSyntaxFailure, preservesStructuredJsonEvidence } from '../structured-syntax-repair'

// 修复稿：换行是转义序列（模型应当输出的合法形态），含中英文与多行字段。
const repaired = JSON.stringify({
  blueprints: [{
    chapterNumber: 10,
    title: '末页那一格',
    role: '推进',
    purpose: '查清涂改处',
    keyEvents: '周叙核完票根。但在船行账房。\r\n\r\n【校正】以上括号说明有误：涂改处其实在第 3 行。',
    characters: ['周叙', '柯有顺'],
    relationships: [],
    suspenseHook: '折角的那一页。',
    costsAndTurns: '溯读吞掉了他对林棠叮嘱的记忆。',
    foreshadowing: '折角。',
  }],
}, null, 2)

describe('保真校验把「换行转义」误判成「改写事实」(issue #23)', () => {
  it('唯一差异是字符串里的换行写成裸换行时，校验从通过翻成拒绝', () => {
    // 修复结果（模型应当输出的形态）：换行是转义序列 —— 校验通过
    expect(preservesStructuredJsonEvidence(repaired, repaired)).toBe(true)

    // 事件：模型在 JSON 字符串里写裸换行（CRLF），这正是「语法坏、该修」的形态
    const candidate = repaired.replace(/\\r\\n/gu, '\r\n')
    expect(isRepairableDirectJsonSyntaxFailure(candidate)).toBe(true)      // 判定为「可修」
    expect(() => JSON.parse(candidate.trim())).toThrow()                    // 确实语法坏

    // 修复后不再被误判：裸换行→转义属于标点与封装修复，不是改写事实
    expect(preservesStructuredJsonEvidence(candidate, repaired)).toBe(true)

    // 差异只有换行：把裸换行等价化为转义序列之后，两份文本逐字相同
    // 两份文本解析出的语义值逐字相同（唯一差异是换行的表示法）
    // candidate 的裸 CRLF 等价化为转义序列后即可解析，语义值与修复稿逐字相同
    const esc = (text: string) => text.replace(/\r\n/gu, '\\r\\n')
    expect(JSON.parse(esc(candidate))).toEqual(JSON.parse(repaired))
  })

  it('真改写内容的修复稿仍被拒绝', () => {
    const candidate = repaired.replace(/\\r\\n/gu, '\r\n')
    const tampered = repaired.replace('涂改处', '完全不同的内容')
    expect(preservesStructuredJsonEvidence(candidate, tampered)).toBe(false)
  })
})
