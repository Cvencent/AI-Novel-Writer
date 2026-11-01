import { describe, expect, it } from 'vitest'

import { draftShortOutlineBlock, draftShortOutlinePrompt, stripDraftShortOutlineBlock } from '../draft-short-outline'

// issue #35：短细纲已经把「第 15 章末温珩提出『明晚我不上船了，你替我上』」列为「前驱已完成」，
// 但第 16 章正文对替班 0 命中（`不上船/替我上/替班/顶班/明晚` 一个都没有），
// 仅用「周叙没接温珩那句」一笔带过。只有登记在案的 suspenseHook 有下游通道，其余悬置承诺没人管。
describe('短细纲块：前驱条目必须落地 (issue #35)', () => {
  it('中文块把「前驱已完成」的条目声明为必须落地，并点明「没接那句」不算落点', () => {
    const block = draftShortOutlineBlock('zh-CN', '前驱已完成：温珩提出「明晚我不上船了，你替我上」。')
    expect(block).toContain('前驱条目必须落地')
    expect(block).toContain('推进它、反转它，或明确写出搁置与理由')
    expect(block).toContain('没接那句')
    // 短细纲原文仍逐字保留（它的身份是「计划，不是事实依据」，不能被规则块挤掉）
    expect(block).toContain('前驱已完成：温珩提出「明晚我不上船了，你替我上」。')
    expect(block).toContain('【生成短细纲结束】')
  })

  it('英文块有对应条款', () => {
    const block = draftShortOutlineBlock('en-US', 'Predecessor: Wen Heng offers to let Zhou take the shift.')
    expect(block).toContain('Predecessor items are binding')
    expect(block).toContain('advance it, twist it, or defer it explicitly')
    expect(block).toContain('[End generated short outline]')
  })

  it('stripDraftShortOutlineBlock 仍能把带新条款的块整块剥掉（幂等边界不变）', () => {
    for (const language of ['zh-CN', 'en-US'] as const) {
      const block = draftShortOutlineBlock(language, '短细纲正文。')
      const prompt = `前缀。\n\n${block}`
      expect(stripDraftShortOutlineBlock(prompt, '短细纲正文。')).toBe('前缀。')
    }
  })

  it('空文本仍然抛错（生成失败不能被规则块掩盖）', () => {
    expect(() => draftShortOutlineBlock('zh-CN', '   ')).toThrow('GENERATION_DRAFT_SHORT_OUTLINE_FAILED')
  })
})

describe('短细纲生成指令 (issue #35)', () => {
  it('「前驱已完成」仍是要求分清的条目之一（落地约束靠块底部的条款兑现）', () => {
    expect(draftShortOutlinePrompt('zh-CN', '源材料')).toContain('前驱已完成的事')
    expect(draftShortOutlinePrompt('en-US', 'source')).toContain('what the predecessor already completed')
  })
})