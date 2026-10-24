import { describe, expect, it } from 'vitest'
import {
  buildOutlineReviewPrompt,
  buildBlueprintReviewPrompt,
  normalizeStageReviewFindings,
  OUTLINE_REVIEW_CATEGORIES,
  BLUEPRINT_REVIEW_CATEGORIES,
} from '../stage-review-contract'
import { OUTLINE_SECTIONS } from '../plot-outline-contract'

describe('outline review contract', () => {
  it('builds a prompt that carries the whole direction stack', () => {
    const prompt = buildOutlineReviewPrompt({
      chapters: [{ chapter: 1, title: '入学', body: '## 第1章：入学\n场景与出场人物：……' }],
      selected: [1],
      coreOutline: '全书方向：零号档案',
      premise: '前提',
      worldbuilding: '世界观',
      arcDirective: '【当前章所属粗纲段】',
      language: 'zh-CN',
    })
    expect(prompt).toContain('全书方向：零号档案')
    expect(prompt).toContain('前提')
    expect(prompt).toContain('世界观')
    expect(prompt).toContain('当前章所属粗纲段')
    expect(prompt).toContain('入学')
    expect(prompt).toContain('plot_logic')
    for (const section of OUTLINE_SECTIONS) expect(prompt).toContain(section)
  })

  it('asks for a complete chapter replacement, not a fragment', () => {
    const prompt = buildOutlineReviewPrompt({
      chapters: [{ chapter: 1, title: '入学', body: 'x' }], selected: [1],
      coreOutline: '', premise: '', worldbuilding: '', arcDirective: '', language: 'zh-CN',
    })
    expect(prompt).toContain('完整替换')
  })

  it('keeps only findings inside the selected range with a known category', () => {
    const findings = normalizeStageReviewFindings([
      { chapter: 2, category: 'pacing', severity: 'error', problemText: '流水账。', expectedText: '## 第2章：x' },
      { chapter: 9, category: 'pacing', severity: 'warning', problemText: '越界。', expectedText: 'y' },
      { chapter: 1, category: 'nonsense', severity: 'warning', problemText: '未知类别。', expectedText: 'z' },
      { chapter: 1, category: 'plot_logic', severity: 'warning', problemText: '  ', expectedText: 'z' },
    ], [1, 2], OUTLINE_REVIEW_CATEGORIES)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.targetIndex).toBe(2)
    expect(findings[0]!.severity).toBe('error')
  })

  it('accepts snake_case field spellings from the model', () => {
    const findings = normalizeStageReviewFindings([
      { target_index: 1, category: 'pacing', severity: 'warning', problem_text: '太赶。', expected_text: '放慢。' },
    ], [1], OUTLINE_REVIEW_CATEGORIES)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.problemText).toBe('太赶。')
    expect(findings[0]!.expectedText).toBe('放慢。')
  })
})

describe('blueprint review contract', () => {
  it('builds a prompt that compares blueprints against the source outline', () => {
    const prompt = buildBlueprintReviewPrompt({
      chapters: [{
        chapter: 3, title: '试探', role: 'rising', purpose: '试探对手', keyEvents: '潜入',
        characters: ['沈砚'], suspenseHook: '被发现了吗', costsAndTurns: '失去一条线索', foreshadowing: '埋下钥匙',
      }],
      selected: [3],
      outlineSlices: '## 第3章：试探\n场景与出场人物：沈砚',
      charactersArch: '沈砚：主角',
      worldbuilding: '世界观',
      language: 'zh-CN',
    })
    expect(prompt).toContain('失去一条线索')
    expect(prompt).toContain('埋下钥匙')
    expect(prompt).toContain('沈砚：主角')
    expect(prompt).toContain('第3章：试探')
    expect(prompt).toContain('field_completeness')
  })

  it('lists the blueprint categories for normalization', () => {
    expect(BLUEPRINT_REVIEW_CATEGORIES).toContain('outline_consistency')
    expect(BLUEPRINT_REVIEW_CATEGORIES).toContain('cost_and_foreshadowing_continuity')
    expect(BLUEPRINT_REVIEW_CATEGORIES).toContain('hook_repetition')
  })
})
