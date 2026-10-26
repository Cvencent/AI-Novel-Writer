import { plotOutlineChapterSpans } from '../../../shared/plot-outline-contract'

/**
 * 世界观重生成时注入的「已确立事实」。
 *
 * 世界观改版不能当从零写：已定稿正文里实际发生的规则/势力/物件、粗纲方向、
 * 已写细纲与蓝图安排都是既成事实。缺资料或超预算的部分如实标注省略。
 */
export interface EstablishedContinuityInput {
  finalizedChapters: ReadonlyArray<{ chapterNumber: number; title?: string; content: string }>
  arcs: ReadonlyArray<{ fromChapter: number; toChapter: number; title: string; beat: string; summary: string; status: string }>
  synopsis: string
  blueprints: ReadonlyArray<{ chapterNumber: number; role: string; purpose: string; keyEvents: string }>
  currentWorldbuilding: string
}

export interface EstablishedContinuityBudget {
  /** 每章定稿正文进入提示词的最大字符数（保留开头与结尾）。 */
  perChapterChars: number
  /** 全部正文加总的最大字符数。 */
  totalContentChars: number
  /** 蓝图每章要点字段的最大字符数。 */
  perBlueprintChars: number
}

export const DEFAULT_CONTINUITY_BUDGET: EstablishedContinuityBudget = {
  perChapterChars: 2400,
  totalContentChars: 24000,
  perBlueprintChars: 400,
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const head = Math.ceil(limit * 0.6)
  const tail = limit - head
  return `${trimmed.slice(0, head)}\n…（中段省略）…\n${trimmed.slice(-tail)}`
}

function languageText(language: 'zh-CN' | 'en-US', zh: string, en: string): string {
  return language === 'en-US' ? en : zh
}

/**
 * 拼装「已确立事实」上下文块。返回 null 表示没有任何可参考材料（纯新项目），
 * 调用方此时保持与旧版完全相同的提示词。
 */
export function buildEstablishedContinuityContext(
  input: EstablishedContinuityInput,
  language: 'zh-CN' | 'en-US',
  budget: EstablishedContinuityBudget = DEFAULT_CONTINUITY_BUDGET,
): string | null {
  const sections: string[] = []

  const finalized = [...input.finalizedChapters].sort((a, b) => a.chapterNumber - b.chapterNumber)
  if (finalized.length > 0) {
    const perChapter = finalized.map(chapter => {
      const title = chapter.title?.trim() ? ` ${chapter.title.trim()}` : ''
      return languageText(language, `第 ${chapter.chapterNumber} 章${title}：`, `Chapter ${chapter.chapterNumber}${title}:`)
        + '\n' + clip(chapter.content, budget.perChapterChars)
    })
    const joined: string[] = []
    let used = 0
    for (const entry of perChapter) {
      if (used + entry.length > budget.totalContentChars) {
        joined.push(languageText(language, `（还有 ${finalized.length - joined.length} 章定稿正文因长度预算省略）`, `(${finalized.length - joined.length} more finalized chapters omitted for length budget)`))
        break
      }
      joined.push(entry)
      used += entry.length
    }
    sections.push(languageText(language, '【已定稿正文（最高权威：与世界观冲突时以正文为准）】', '[Finalized prose (highest authority; where it conflicts with the worldbuilding, the prose wins)]') + '\n' + joined.join('\n\n'))
  }

  if (input.arcs.length > 0) {
    const arcs = input.arcs
      .slice()
      .sort((a, b) => a.fromChapter - b.fromChapter)
      .map(arc => languageText(language, `第 ${arc.fromChapter}–${arc.toChapter} 章（${arc.beat}，${arc.status === 'confirmed' ? '已确认' : '草稿'}）：${arc.title}\n${clip(arc.summary, 600)}`, `Ch. ${arc.fromChapter}-${arc.toChapter} (${arc.beat}, ${arc.status}): ${arc.title}\n${clip(arc.summary, 600)}`))
    sections.push(languageText(language, '【粗纲方向】', '[Arc outline direction]') + '\n' + arcs.join('\n\n'))
  }

  const spans = plotOutlineChapterSpans(input.synopsis)
  if (spans.length > 0) {
    const outline = spans.map(span => {
      const raw = input.synopsis.slice(span.index, span.end).trim()
      return clip(raw, 500)
    })
    sections.push(languageText(language, '【已写细纲（逐章）】', '[Existing chapter outline]') + '\n' + outline.join('\n\n'))
  }

  if (input.blueprints.length > 0) {
    const points = input.blueprints
      .slice()
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
      .map(blueprint => languageText(language, `第 ${blueprint.chapterNumber} 章`, `Chapter ${blueprint.chapterNumber}`)
        + languageText(language, '｜定位：', ' | role: ') + clip(blueprint.role, budget.perBlueprintChars)
        + languageText(language, '｜目的：', ' | purpose: ') + clip(blueprint.purpose, budget.perBlueprintChars)
        + languageText(language, '｜关键事件：', ' | key events: ') + clip(blueprint.keyEvents, budget.perBlueprintChars))
    sections.push(languageText(language, '【已生成蓝图要点】', '[Generated blueprint points]') + '\n' + points.join('\n'))
  }

  if (input.currentWorldbuilding.trim()) {
    sections.push(languageText(language, '【现有世界观（修订基础：保留其中仍成立的部分，修正与上述事实矛盾的部分）】', '[Current worldbuilding (the revision base: keep what still holds, fix what contradicts the facts above)]') + '\n' + clip(input.currentWorldbuilding, 6000))
  }

  if (sections.length === 0) return null
  return sections.join('\n\n')
}

/** 修订模式的追加指令：告诉模型这是「参考既成事实的修订」，而不是自由创作。 */
export function establishedContinuityDirective(hasFacts: boolean, language: 'zh-CN' | 'en-US'): string {
  if (!hasFacts) return ''
  return languageText(
    language,
    [
      '★【修订模式（本次为参考既成事实的修订生成）】★：',
      '已确立事实（定稿正文、粗纲、细纲、蓝图）是既成约束：新世界观必须与它们一致，或给出自洽的补充解释；正文与世界观冲突时，以正文为准修订世界观。',
      '不要推翻正文里已经发生且生效的规则与事件；只把世界观里过时、缺失或矛盾的部分更新到位，并在保留原结构的前提下输出完整修订版。',
    ].join('\n'),
    [
      '★[Revision mode: this run revises the worldbuilding against established facts]★:',
      'Established facts (finalized prose, arc outline, chapter outline, blueprints) are binding: the new worldbuilding must stay consistent with them or add a self-consistent explanation; where the prose conflicts with the worldbuilding, revise the worldbuilding to match the prose.',
      'Do not overturn rules and events that already took effect in the finalized prose; update only the outdated, missing, or contradictory parts and output the complete revised version with the original structure preserved.',
    ].join('\n'),
  )
}
