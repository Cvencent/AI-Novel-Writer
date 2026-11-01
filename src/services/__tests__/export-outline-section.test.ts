import { describe, expect, it } from 'vitest'

import { renderOutlineSection } from '../export-service'

// issue #57：21 章定稿的书，synopsis 只有第 1–3 章，却被原样贴在正文前面，
// 同一文件里第 1–3 章各出现两个标题（大纲 `## 第1章：…` / 正文 `# 第1章 …`）。
describe('renderOutlineSection (issue #57)', () => {
  const synopsis = [
    '## 第1章：多出来的一名乘客',
    '周叙在开船前核对夜航船票根。',
    '',
    '## 第2章：靛蓝短褂',
    '周叙追问温珩为什么二十年只穿那一件靛蓝短褂。',
    '',
    '## 第3章：记录簿',
    '周叙撬开工间的旧铁柜。',
  ].join('\n')

  it('段首写明大纲实际覆盖范围与已定稿章数', () => {
    const out = renderOutlineSection(synopsis, 21, 'zh-CN')
    expect(out.startsWith('## 故事大纲 （第 1–3 章；全书已定稿 21 章）')).toBe(true)
  })

  it('大纲条目降成三级标题：同一文件里不再有两个同名同级的标题', () => {
    const out = renderOutlineSection(synopsis, 21, 'zh-CN')
    expect(out).toContain('### 第1章：多出来的一名乘客')
    expect(out).not.toMatch(/^## 第1章：/mu)
    // 除段标题「## 故事大纲」外，段内不再有其它二级标题；也不占用一级标题
    const headings = out.split('\n').filter(line => /^#{1,3} /u.test(line))
    // 四条标题：段标题 + 三条降级后的三级标题
    expect(headings[0]).toBe('## 故事大纲 （第 1–3 章；全书已定稿 21 章）')
    expect(headings.slice(1)).toEqual([
      '### 第1章：多出来的一名乘客',
      '### 第2章：靛蓝短褂',
      '### 第3章：记录簿',
    ])
  })

  it('大纲没覆盖到时直说「之后的章节没有对应大纲条目」', () => {
    const out = renderOutlineSection(synopsis, 21, 'zh-CN')
    expect(out).toContain('大纲只覆盖到第 3 章，之后的章节没有对应大纲条目')
    // 已覆盖全书时不加这句
    expect(renderOutlineSection(synopsis, 3, 'zh-CN')).not.toContain('大纲只覆盖到')
  })

  it('英文写作语言下用英文措辞', () => {
    const out = renderOutlineSection('## Chapter 1: Test\nBody.', 9, 'en-US')
    expect(out).toContain('## Story outline (chapters 1-1; 9 chapters are finalized)')
    expect(out).toContain('The outline only covers chapters 1-1')
  })

  it('空大纲返回空串（导出时不产生空段）', () => {
    expect(renderOutlineSection('', 21, 'zh-CN')).toBe('')
    expect(renderOutlineSection('   \n  ', 21, 'zh-CN')).toBe('')
  })

  it('大纲里没有按章条目时也说明，不静默贴一段无标题文字', () => {
    const out = renderOutlineSection('这是一段没有章条目的全书走向说明。', 5, 'zh-CN')
    expect(out).toContain('（大纲里没有按章条目）')
  })
})
