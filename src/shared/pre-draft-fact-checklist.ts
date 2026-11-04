/**
 * 起草前的**确定性对账清单**（issue #128）。
 *
 * issue 的观察：本项目已经有比 Story Bible 更硬的东西——`chapter_commits.facts_json`
 * （每章事实账本）、`characters`（角色卡）、`project_core.worldbuilding`（世界观）——
 * 但历轮挖出的问题（#113 纸角在谁手里 / #102 陆敬堂写成穆敬堂 / #115 用时对不上 /
 * #116 同一句台词换人说）全部是**账本里记对了，落笔时没拿来自查**。
 *
 * 项目里已有一份 `draft-reconciliation`，但它是**一次模型调用**：产出「冲突清单」
 * 仍然依赖模型这次的判断，所以模型漏看的东西它也会漏。本模块补的是另一半——
 * **不调模型、可逐字核对**的那一份：把库里的正名与时点状态原样摊开，
 * 让「谁叫什么、上一章末在哪、什么时辰」在落笔前就有确定答案。
 *
 * 三条都来自已有数据、不需要新表：
 * 1. **正名**：本章蓝图点到、且在名册里的角色 → 学名 +「不得出现变体」；
 *    名册里记过的旧名（`character_aliases`）一并列出，标为「旧名，已改」。
 * 2. **上一章末状态**：角色的 `cs_location` / `cs_physical_state` / `cs_recent_events`，
 *    只在**来源章号早于本章**时采信（重写旧章不得把后续终态当起点，与
 *    `generate-draft` 的 `readCharacterProfiles` 同一口径）。
 * 3. **本章时点**：蓝图 `keyEvents` 的【时点：…】标注。
 *
 * 刻意不做：**道具在谁手里**。本仓没有道具账本（`cs_key_items` 是自由文本、多数角色
 * 只写最近一件），从正文猜归属正是 #113/#122 反复踩过的坑。这一条留给
 * `draft-reconciliation` 的模型对账，不在这里假装确定。
 */
import type { WritingLanguage } from './writing-language'
import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateTextField } from './character-roster'

/** shared 层不依赖 services：只按写作语言二选一。 */
const pick = (language: WritingLanguage, zh: string, en: string): string => language === 'en-US' ? en : zh

/** 名册里一个角色在「上一章末」的可核对状态。 */
export interface PreDraftCastEntry {
  name: string
  role?: string
  /** 每个字段的取值与它来自哪一章。 */
  state: Partial<Record<CharacterStateTextField, { value: string; chapterNumber: number }>>
  /** 名册记过的旧名（已改）；这些写法不应再出现在正文里。 */
  formerNames?: readonly string[]
}

export interface PreDraftFactChecklistInput {
  chapterNumber: number
  /** 本章蓝图点到的角色名（`blueprints.characters`）。 */
  blueprintCharacters: readonly string[]
  cast: readonly PreDraftCastEntry[]
  /** 本章蓝图 `keyEvents`（读【时点：…】标注）。 */
  keyEvents?: string
  writingLanguage: WritingLanguage
}

/** 蓝图里那段【时点：…】标注（与本仓 `timeAnchorOf` 同一形态，但这里只读不判）。 */
const TIME_ANCHOR = /【\s*时点\s*[:：]\s*([^】]{1,40})】/gu

/** 一章里要摆到作者/模型面前的确定事实。空清单返回空串（调用方按「无清单」处理）。 */
export function preDraftFactChecklist(input: PreDraftFactChecklistInput): string {
  const english = input.writingLanguage === 'en-US'
  const blueprintNames = [...new Set(input.blueprintCharacters.map(name => String(name ?? '').trim()).filter(Boolean))]
  const inScene = blueprintNames.length > 0
    ? input.cast.filter(entry => blueprintNames.includes(entry.name))
    : []
  // 蓝图没点到任何人时退回名册全体？不——那会把整本书的人名都塞进提示。
  // 只有「蓝图点名 + 名册里有」的角色才是本章要写的。
  const anchor = [...String(input.keyEvents ?? '').matchAll(TIME_ANCHOR)].at(-1)?.[1]?.trim() ?? ''
  if (inScene.length === 0 && !anchor) return ''

  const lines: string[] = []
  if (inScene.length > 0) {
    const castLines = inScene.map(entry => {
      const facts: string[] = []
      for (const field of CHARACTER_STATE_TEXT_FIELDS) {
        const value = entry.state[field]
        // 只采信**早于本章**的时点状态（与 readCharacterProfiles 同一口径）。
        if (!value || value.chapterNumber >= input.chapterNumber || !value.value.trim()) continue
        facts.push(`${field}@ch${value.chapterNumber}: ${value.value.trim()}`)
      }
      const former = (entry.formerNames ?? []).filter(name => name && name !== entry.name)
      const suffix = former.length > 0
        ? (english ? ` (former spelling(s) recorded: ${former.join(', ')}; do not reuse)` : `（名册记过的旧写法：${former.join('、')}；不得再用）`)
        : ''
      return `- ${entry.name}${entry.role ? ` (${entry.role})` : ''}${facts.length ? ` | ${facts.join(' | ')}` : ''}${suffix}`
    })
    lines.push(pick(input.writingLanguage,
      '【本章角色正名与上一章末状态（确定性事实，落笔前先对一遍）】',
      '[Canonical names and end-of-previous-chapter state for this chapter (deterministic; check before writing)]'))
    lines.push(pick(input.writingLanguage,
      '下列写法是唯一正确写法，不得出现同音、同义或后缀变体；括号里的旧写法已经改过，不得再用。状态后的 @chN 是该值出自第 N 章，只作为本章起点，不要重新叙述已发生的事。',
      'These spellings are the only correct ones; do not use homophone, synonym, or suffixed variants. Former spellings in parentheses were corrected and must not return. @chN marks the chapter a value comes from; treat it as this chapter\'s starting point, not as events to replay.'))
    lines.push(...castLines)
  }
  if (anchor) {
    lines.push(pick(input.writingLanguage,
      `【本章时点（来自蓝图，必须落实）】${anchor}`,
      `[Time anchor for this chapter (from the blueprint; must be realized)] ${anchor}`))
  }
  return lines.join('\n')
}