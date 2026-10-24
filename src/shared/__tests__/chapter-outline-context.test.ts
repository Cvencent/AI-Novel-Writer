import { describe, expect, it } from 'vitest'
import { chapterOutlineArcDirective, chapterOutlineCoreContract } from '../plot-outline-contract'

const arcs = [
  { fromChapter: 1, toChapter: 120, title: '零号档案', summary: '第一段剧情。', beat: 'setup', status: 'confirmed' },
  { fromChapter: 121, toChapter: 300, title: '低一格', summary: '第二段剧情。', beat: 'escalation', status: 'confirmed' },
  { fromChapter: 301, toChapter: 430, title: '错账', summary: '第三段剧情。', beat: 'reversal', status: 'confirmed' },
]

describe('chapter outline context contract', () => {
  it('puts the owning arc segment and the whole arc index in every chapter prompt', () => {
    const prompt = chapterOutlineArcDirective(arcs, 1, 'zh-CN')
    expect(prompt).toContain('第1–120章')
    expect(prompt).toContain('第一段剧情。')
    expect(prompt).toContain('第121–300章')
    expect(prompt).toContain('第121–300章（escalation）低一格');expect(prompt).toContain('第301–430章（reversal）错账');expect(prompt).not.toContain('第三段剧情。')
    expect(prompt).not.toContain('当前章必须服从：\n第三段剧情。')
  })

  it('includes the core outline before chapter facts', () => {
    const prompt = chapterOutlineCoreContract({ coreOutline: '全城倒计时六十天。', premise: '前提事实', charactersArch: '角色事实', worldbuilding: '世界观事实', globalGuidance: '克制叙事' }, 'zh-CN')
    expect(prompt.indexOf('全城倒计时六十天。')).toBeGreaterThan(-1)
    expect(prompt.indexOf('全城倒计时六十天。')).toBeLessThan(prompt.indexOf('前提事实'))
    expect(prompt).toContain('角色事实')
    expect(prompt).toContain('世界观事实')
    expect(prompt).toContain('克制叙事')
  })
})
