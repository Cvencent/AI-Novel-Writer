import { describe, expect, it } from 'vitest'

import {
  buildEntranceSelectionPrompt,
  entranceCandidateParagraphs,
  entranceSelectionToEntrances,
  entranceSelectionFindings,
  parseEntranceSelection,
} from '../entrance-selection-review'

const CHAPTERS = [
  { chapterNumber: 7, content: '开场白。\n\n温珩站在舱门口，赤脚，下摆滴水。\n\n有人在回忆里提到温珩说过「一直空着」。' },
  { chapterNumber: 9, content: '「原本不属于温珩。」全叔说。\n\n温珩站在那儿，湿着半身。' },
]
const request = { character: '温珩', chapters: CHAPTERS, language: 'zh-CN' as const }

/**
 * issue #163 第八批：登场段的**挑选**改由模型（旧 ENTRANCE_ACTION/ENTRANCE_DRESS
 * 两张词表下线——56 条本书服饰换本书即瞎）。规则只做：候选段抽取（名字出现即候选）
 * 与引文定位；「哪一段是实体登场」交模型。
 */
describe('entranceCandidateParagraphs', () => {
  it('extracts paragraphs mentioning the character, capped per chapter', () => {
    const candidates = entranceCandidateParagraphs(CHAPTERS[0]!.content, '温珩')
    expect(candidates).toHaveLength(2)
    expect(candidates[0]!.index).toBe(2)
  })

  it('returns nothing for a character who does not appear', () => {
    expect(entranceCandidateParagraphs(CHAPTERS[1]!.content, '不存在的人')).toEqual([])
  })

  it('caps candidates at the per-chapter limit', () => {
    const content = Array.from({ length: 6 }, (_, index) => `温珩第 ${index} 段。`).join('\n\n')
    expect(entranceCandidateParagraphs(content, '温珩', 3)).toHaveLength(3)
  })
})

describe('buildEntranceSelectionPrompt (issue #163 第八批)', () => {
  it('hands the candidates to the model and excludes non-entrance mentions', () => {
    const { system, user } = buildEntranceSelectionPrompt(request)
    expect(system).toContain('实体登场')
    expect(system).toContain('不要挑')
    expect(system).toContain('回忆')
    expect(user).toContain('温珩')
    expect(user).toContain('温珩站在舱门口')
    // 词表痕迹不许出现。
    expect(system).not.toContain('短褂|长衫')
    expect(system).not.toContain('ENTRANCE_DRESS')
  })

  it('has the same rule on the English side', () => {
    const { system } = buildEntranceSelectionPrompt({ ...request, language: 'en-US' })
    expect(system).toContain('PHYSICAL ENTRANCE')
    expect(system).toContain('verbatim')
  })
})

describe('parseEntranceSelection (issue #163 第八批)', () => {
  const raw = (selections: unknown) => JSON.stringify({ selections })
  const good = {
    chapterNumber: 7,
    paragraph: '温珩站在舱门口，赤脚，下摆滴水。',
  }

  it('keeps a selection whose paragraph locates verbatim in that chapter', () => {
    const parsed = parseEntranceSelection(raw([good]), request)
    expect(parsed).toEqual([{ chapterNumber: 7, paragraph: good.paragraph, index: 2 }])
  })

  it('drops a selection the model rewrote (must be verbatim)', () => {
    const parsed = parseEntranceSelection(
      raw([{ chapterNumber: 7, paragraph: '温珩站在舱门口，湿着脚。' }]),
      request,
    )
    expect(parsed).toEqual([])
  })

  it('drops selections about chapters outside the request', () => {
    expect(parseEntranceSelection(raw([{ chapterNumber: 999, paragraph: '温珩。' }]), request)).toEqual([])
  })

  it('rejects malformed output instead of silently adopting nothing', () => {
    expect(parseEntranceSelection('{not json', request)).toBeNull()
    expect(parseEntranceSelection(JSON.stringify({ entrance: [] }), request)).toBeNull()
  })
})

describe('entranceSelectionToEntrances / entranceSelectionFindings', () => {
  it('maps to the entrance-shot comparison input shape', () => {
    const entrances = entranceSelectionToEntrances(
      [{ chapterNumber: 7, paragraph: '温珩站在舱门口。', index: 2 }],
      '温珩',
    )
    expect(entrances).toEqual([
      { character: '温珩', chapterNumber: 7, sentence: '温珩站在舱门口。', sentenceIndex: 2 },
    ])
  })

  it('wraps issues as findings keyed on character + chapter', () => {
    const findings = entranceSelectionFindings([
      { chapterNumber: 7, character: '温珩', quote: '温珩站在舱门口。', explanation: '确认登场段' },
    ])
    expect(findings[0]!.stableFactKey).toBe('entrance-selection:温珩:7')
  })
})
