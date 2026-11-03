/**
 * 章节标题的**唯一性**（issue #110 / #16）。
 *
 * `#16` 的修复在蓝图合同里加了标题唯一性校验（`decodeBlueprintSemanticPayload` 的
 * `duplicate_title`），但它只判**精确相等**，而且只在**生成那一批**时生效——
 * 两件事因此都漏掉了：
 *
 * ① **「同题加尾」不是精确同名**：实测那本 24 章的书有两对——
 *    ch15「压印」/ ch21「压印的」、ch18「无人认领」/ ch22「无人认领，一并化浆」。
 *    字面不同，但读者在目录里读到的是同一章被写了两遍（「无人认领」本身已是完整断语）。
 * ② **已定稿的旧章节**不会再过一遍合同——作者改不了、也不会被提醒。
 *
 * 判据与合同侧**同一套**：标题剥掉尾部标点后，与任一其它标题**互为前缀（含相等）**
 * 即视为复用；两侧都要求 ≥`TITLE_UNIQUENESS_MIN_CHARS` 字（单字标题会互相吞）。
 * 由 issue #110 的建议收窄：
 *   - **双向**判（`startsWith` 两边都要），否则只挡「新标题更长」那种顺序；
 *   - **剥尾部标点**，避免「无人认领，」这种纯标点差异漏过；
 *   - **长度下限**，否则单字标题互相吞（本仓 #87 的教训）。
 */

import { TITLE_UNIQUENESS_MIN_CHARS } from './blueprint-semantic-contract'

export interface TitledChapter {
  chapterNumber: number
  title: string
}

export interface DuplicateTitleHit {
  /** 归一化后的标题（相互复用）。 */
  title: string
  /** 出现该标题的所有章号（升序）。 */
  chapters: number[]
}

/** 标题唯一性比对的归一化（与合同侧同一口径）：剥掉首尾空白与尾部标点。 */
export function normalizeTitleForUniqueness(title: unknown): string {
  return String(title ?? '').trim().replace(/[\s，,。.、；;：:！!？?…]+$/u, '')
}

/**
 * 找出「同一个标题被用到多章」的章（issue #110）。
 *
 * 判据 = 剥尾标点后**互为前缀（含相等）**，两侧都 ≥2 字。
 * 按归一化标题归并（同一词族的两章合成一条），章号升序。
 */
export function findDuplicateChapterTitles(chapters: readonly TitledChapter[]): DuplicateTitleHit[] {
  const usable = chapters
    .filter(item => Number.isSafeInteger(item.chapterNumber) && normalizeTitleForUniqueness(item.title))
    .map(item => ({ chapterNumber: item.chapterNumber, title: normalizeTitleForUniqueness(item.title) }))
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  if (usable.length < 2) return []
  // 归并：把「互为前缀」的标题并进同一组（用并查集式的两两合并，章节量级小、无性能顾虑）。
  const groups: Array<{ title: string; chapters: number[] }> = []
  for (const entry of usable) {
    if (entry.title.length < TITLE_UNIQUENESS_MIN_CHARS) continue
    const group = groups.find(candidate => candidate.chapters.length > 0
      && candidate.title.length >= TITLE_UNIQUENESS_MIN_CHARS
      && (candidate.title.startsWith(entry.title) || entry.title.startsWith(candidate.title)))
    if (group) {
      // 组内保留**最短**的那个标题作为代表（它是其它写法共同的前缀）。
      if (entry.title.length < group.title.length) group.title = entry.title
      group.chapters.push(entry.chapterNumber)
    } else {
      groups.push({ title: entry.title, chapters: [entry.chapterNumber] })
    }
  }
  return groups
    .filter(group => group.chapters.length >= 2)
    .map(group => ({ title: group.title, chapters: [...group.chapters].sort((left, right) => left - right) }))
}

/**
 * 重复标题 → 一致性发现（issue #110）。
 *
 * `stableFactKey` 锚在**归一化标题**上、**不带章号**（#86/#89/#98/#108 的教训：
 * 带章号的 key 会随章滚动，作者点「我已知」永远关不掉）。
 * `sourceChapter` 指向**首次使用该标题的章**（这是旧账，不是正在写的那一章）。
 */
export function findDuplicateChapterTitleFindings(input: {
  chapters: readonly TitledChapter[]
}): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  return findDuplicateChapterTitles(input.chapters).map(hit => {
    const chapterList = hit.chapters.join('、')
    const titles = hit.chapters.map(chapter => {
      const entry = input.chapters.find(item => item.chapterNumber === chapter)
      return `第${chapter}章「${entry ? String(entry.title).trim() : ''}」`
    }).join('、')
    return {
      // key 锚在「哪个标题被复用了」上，不含章号。
      stableFactKey: `chapter-title:duplicate:${hit.title}`,
      severity: 'warning' as const,
      sourceChapter: hit.chapters[0]!,
      evidence: `第 ${chapterList} 章用了同一个标题：${titles}`,
      issue: {
        zhCN: `第 ${chapterList} 章的标题实际上是**同一个**（${titles}）——后一个只是在前一个后面补了一个「的」或一个分句。目录是长篇读者最常回看的一屏，也是导出文件的第一个门面；同一章标题出现两次，读者第一反应是「文件出错了」，而不是「这两章有承接」。`,
        enUS: `Chapters ${chapterList} effectively share one title (${titles}) — the later one merely appends a particle or a clause to the earlier. The table of contents is the screen long-form readers revisit most and the first thing an export shows; seeing the same title twice reads as a corrupted file, not as a deliberate link between chapters.`,
      },
      suggestion: {
        zhCN: `给其中一章换一个**有区分度**的标题——承接上一章是合理的写法，但要在目录里能分辨：换一个有自己身份的措辞（点出这一章独有的那件事、那个人或那个转折），而不是在原标题后面加「的」或补一个分句。如果两章本来讲的就是同一件事，那就合并它们，或把其中一章的标题改成它真正的内容。`,
        enUS: `Rename one of them so each title has its own identity. Carrying a chapter forward is a fair move, but it must be legible in the contents: name the one thing, person, or turn that belongs to that chapter, instead of appending a particle or a clause to the old title. If the two chapters really cover the same event, merge them or retitle one to what it actually contains.`,
      },
    }
  })
}
