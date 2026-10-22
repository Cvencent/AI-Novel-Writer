import { describe, expect, it } from 'vitest'
import {
  buildOutlineRetrievalContext,
  parseOutlineChapters,
  extractCharacterNames,
  rollupDigestBlocks,
  DEFAULT_OUTLINE_CONTEXT_BUDGET,
} from '../outline-retrieval-context'

function makeOutline(count: number, bodyChars = 240): string {
  const parts = ['# 细纲', '']
  for (let i = 1; i <= count; i += 1) {
    parts.push('## 第' + i + '章：第' + i + '章标题')
    parts.push('')
    parts.push(('第' + i + '章正文。').repeat(Math.ceil(bodyChars / 8)).slice(0, bodyChars))
    parts.push('')
  }
  parts.push('> 本大纲已覆盖至第 ' + count + ' 章（全书 3000 章），其余章节将在后续批次继续生成。')
  return parts.join('\n')
}

describe('parseOutlineChapters', () => {
  it('解析中文章标题与正文，忽略尾部进度行', () => {
    const outline = makeOutline(3)
    const entries = parseOutlineChapters(outline)
    expect(entries.map(e => e.chapter)).toEqual([1, 2, 3])
    expect(entries[0]!.title).toBe('第1章标题')
    expect(entries[2]!.body).toContain('第3章正文')
    expect(entries[2]!.body).not.toContain('本大纲已覆盖至')
  })

  it('解析英文章标题', () => {
    const outline = '# Plot Outline\n\n## Chapter 5: Title Five\n\nBody five.\n'
    const entries = parseOutlineChapters(outline)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.chapter).toBe(5)
    expect(entries[0]!.title).toBe('Title Five')
  })

  it('重复章号只保留首次出现', () => {
    const outline = '## 第1章：A\n\nx\n\n## 第1章：B\n\ny\n'
    expect(parseOutlineChapters(outline).map(e => e.chapter)).toEqual([1])
  })
})

describe('buildOutlineRetrievalContext', () => {
  it('全文在预算内时原样返回，不做压缩', () => {
    const outline = makeOutline(2, 100)
    const result = buildOutlineRetrievalContext(outline, { budgetChars: 20000 })
    expect(result.stats.compacted).toBe(false)
    expect(result.text).toBe(outline.trim())
  })

  it('超长时输出被压到预算内，且最近章节保留全文', () => {
    const outline = makeOutline(300, 600)
    expect(outline.length).toBeGreaterThan(150000)
    const result = buildOutlineRetrievalContext(outline, { budgetChars: DEFAULT_OUTLINE_CONTEXT_BUDGET, recentFullChapters: 5 })
    expect(result.stats.compacted).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(Math.ceil(DEFAULT_OUTLINE_CONTEXT_BUDGET * 1.15))
    // 最近 5 章必须逐字保留
    for (const chapter of [296, 297, 298, 299, 300]) {
      expect(result.text).toContain('## 第' + chapter + '章：第' + chapter + '章标题')
      expect(result.text).toContain('第' + chapter + '章正文。')
    }
    // 最早章节必须以摘要形式仍可追溯（骨架不丢）
    expect(result.text).toContain('第 1')
  })

  it('输出规模随章数增长保持有界', () => {
    const sizes = [100, 400, 1200, 3000].map(count => buildOutlineRetrievalContext(makeOutline(count, 600), { budgetChars: DEFAULT_OUTLINE_CONTEXT_BUDGET }).text.length)
    for (const size of sizes) expect(size).toBeLessThanOrEqual(Math.ceil(DEFAULT_OUTLINE_CONTEXT_BUDGET * 1.2))
    // 3000 章相对 100 章不应显著增长（对数式滚卷）
    expect(sizes[3]! / sizes[0]!).toBeLessThan(1.6)
  })

  it('人物索引列出首次与最近出现章节', () => {
    const head = '## 第1章：起\n\n林越出场。\n\n## 第2章：承\n\n林越与沈星澜同行。\n\n'
    const filler = Array.from({ length: 40 }, (_v, i) => '## 第' + (i + 3) + '章：续\n\n' + '填充正文内容用来撑爆预算。'.repeat(20) + '\n').join('\n')
    const tail = '## 第50章：转\n\n沈星澜独自行动。\n'
    const result = buildOutlineRetrievalContext(head + filler + tail, { budgetChars: 2000, recentFullChapters: 1, characterNames: ['林越', '沈星澜'] })
    expect(result.stats.compacted).toBe(true)
    expect(result.text).toContain('林越：第 1 章 → 第 2 章')
    expect(result.text).toContain('沈星澜：第 2 章 → 第 50 章')
  })

  it('人物关系索引把稳定关系与最近共同出场章节一起注入', () => {
    const head = '## 第1章：起\n\n林越出场。\n\n## 第2章：承\n\n林越与沈星澜同行。\n\n'
    const filler = Array.from({ length: 40 }, (_v, i) => '## 第' + (i + 3) + '章：续\n\n' + '填充正文内容用来撑爆预算。'.repeat(20) + '\n').join('\n')
    const tail = '## 第50章：转\n\n沈星澜独自行动。\n'
    const result = buildOutlineRetrievalContext(head + filler + tail, {
      budgetChars: 2400,
      recentFullChapters: 1,
      characterNames: ['林越', '沈星澜'],
      characterRelations: [{ source: '林越', target: '沈星澜', relation: '互相试探的盟友；源核与源族线索交汇' }],
    })
    expect(result.text).toContain('【关键人物关系】')
    expect(result.text).toContain('林越 → 沈星澜：互相试探的盟友；源核与源族线索交汇')
    expect(result.text).toContain('第 2 章')
  })
})

describe('extractCharacterNames', () => {
  it('从角色名单粗提人物名', () => {
    const arch = '# 角色图谱\n\n## 主角：林越\n- 性别：男\n\n## 配角：沈星澜\n- 性别：女\n'
    const names = extractCharacterNames(arch)
    expect(names).toContain('林越')
    expect(names).toContain('沈星澜')
  })
})

describe('rollupDigestBlocks', () => {
  it('把摘要块数量压到上限', () => {
    const blocks = Array.from({ length: 40 }, (_v, i) => ({ from: i + 1, to: i + 1, title: 'T' + (i + 1), brief: 'b' }))
    const rolled = rollupDigestBlocks(blocks, 8)
    expect(rolled.length).toBeLessThanOrEqual(8)
    expect(rolled[0]!.from).toBe(1)
    expect(rolled[rolled.length - 1]!.to).toBe(40)
  })
})
