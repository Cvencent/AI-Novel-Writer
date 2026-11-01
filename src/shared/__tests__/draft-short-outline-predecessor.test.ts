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
// issue #38：第 16 章短细纲把蓝图里「温珩推过来的油纸包」当成「前驱已完成」，
// 但第 15 章正文里温珩明确拒绝交出、结尾仍在温珩身上——短细纲替正文断言了没发生的事实，
// 起草于是直接写「从怀里摸出油纸包」。
describe('道具交接不得由短细纲断言 (issue #38)', () => {
  it('生成指令只允许把上一章正文真实发生的动作写进「前驱已完成」', () => {
    const zh = draftShortOutlinePrompt('zh-CN', '源材料')
    expect(zh).toContain('「前驱已完成」只能写上一章正文里真实发生的动作')
    expect(zh).toContain('蓝图或计划声称的交接、夺取、移交')
    expect(zh).toContain('绝不能记成已经在本章视角人物手里')
    const en = draftShortOutlinePrompt('en-US', 'source')
    expect(en).toContain('Only actions that actually happen in the previous chapter')
    expect(en).toContain('never be described as already with the current viewpoint character')
  })

  it('注入块要求交接有动作，并把无依据的交接当待办', () => {
    const zh = draftShortOutlineBlock('zh-CN', '前驱已完成：温珩推过来的油纸包。')
    expect(zh).toContain('【道具交接必须有动作（issue #38）】')
    expect(zh).toContain('必须先写出交接动作')
    expect(zh).toContain('一律当作待办，不得当作既成事实')
    // 短细纲原文仍逐字保留
    expect(zh).toContain('前驱已完成：温珩推过来的油纸包。')
    const en = draftShortOutlineBlock('en-US', 'Predecessor: the paper packet pushed over.')
    expect(en).toContain('[Object handoff must be earned (issue #38)]')
    expect(en).toContain('treat it as a task, never as fact')
  })

  it('剥块仍然幂等（带新增条款后不能破坏恢复路径的逐字比对）', () => {
    for (const language of ['zh-CN', 'en-US'] as const) {
      const block = draftShortOutlineBlock(language, '短细纲正文。')
      expect(stripDraftShortOutlineBlock(`前缀。\n\n${block}`, '短细纲正文。')).toBe('前缀。')
    }
  })
})
