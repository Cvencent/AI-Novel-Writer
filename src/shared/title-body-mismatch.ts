/**
 * 章节标题点名的东西本章没写（issue #144）。
 *
 * 现场（本书 67 章实测）：
 *
 *   第 66 章 标题「**指印**比名字早一笔」
 *            正文全章「印」字 **0** 次；蓝图 keyEvents 里也没有。
 *            正文实际写的是「指腹按在徐汐名字的末一笔上」，读出「未登船」。
 *   第 34 章 标题「水隔上的**凿痕**」
 *            正文全章「凿痕」0 次、蓝图也 0 次；正文写的是「斧口，两指宽」。
 *   第 67 章 标题「**温珩**按住了那一角布」
 *            该章正文里温珩没有这个动作（布角是周叙自己按在舵板上读的）。
 *
 * 全仓此前**没有任何一处**把 `blueprints.title` 与它自己那一章的正文/蓝图比过——
 * 标题的唯一约束是「非空 + 全书唯一」。已知的三条标题判据管的是别的：
 * #106 管句式同构、#110 管同题加尾复用、#16 管重名与场景重演；
 * 本模块管的是「**标题说的东西本章有没有**」。
 *
 * 判据（结构性，**不写题材词表**）：
 * 1. 从标题里取**内容词**：按连续汉字串滑窗取 **2 字**片段，剔除含**封闭虚字类**
 *    （的/了/着/不/是/我/你/他…）的片段。这保证只把实词性的二字组合当候选。
 * 2. 候选在**本章正文**或**本章蓝图 keyEvents** 里任一处出现即算命中（作者可能把
 *    它写在正文、也可能只写在蓝图计划里）。
 * 3. **一个候选都不命中**才报——只要标题里有一个词在本章落了地，就不算空标题。
 *
 * ⚠️ 刻意**不做**「标题里的动作安到了别人头上」那一档（issue 建议 2）：要判「谁做了
 * 这个动作」需要把动作与施事绑定，而本仓已有 `#94` 段落起手主语、`#102` 角色名漂移
 * 等判据在读施事；再叠一条容易与它们重叠且误报率未知。本模块只报**最硬的一档**：
 * 标题点到的**在册角色**在本章正文与其蓝图里都没有出现。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 标题里的**在册人名**（issue #144 建议 2 的那一档：可枚举、误报低）。
 *
 * 为什么不按「标题里的内容词」判：实测切词不可靠。以「按虚字/标点切分后取片段」
 * 为口径时，本书 66 章里有 25 章（38%）判成「标题内容词没落地」，其中
 * 「记录簿」「日期比名字先写」这类**明显写到了**的章也被报——因为中文短标题的
 * 切分本身有歧义（`水隔上的凿痕` 切出 `水隔上`，而正文写的是「斧口」；
 * `日期比名字先写` 切出 `先写`，正文用的是别的措辞）。误报率高到作者会整条无视。
 *
 * 而**人名**是封闭集合（名册），且标题点某个人却全章没提这个人，是**确定的**缺陷：
 * 第 67 章标题「温珩按住了那一角布」，而该章正文里温珩没有任何动作。
 */

export interface TitleChapterInput {
  chapterNumber: number
  /** `blueprints.title`。空标题不判。 */
  title: string
  /** 本章**正文**（尚未定稿时给空串）。 */
  content: string
  /** 本章蓝图 `keyEvents`（作者可能只把内容写在计划里）。 */
  keyEvents?: string
  /** 在册角色名。标题点到的人必须在本章出现过。 */
  castNames?: readonly string[]
}

/**
 * 「标题点到的角色，本章一次都没出场」→ 一致性发现。
 *
 * 只报这一档（issue #144 的建议 2），理由见文件头：按「内容词」判会大面积误报。
 * 这一档是**确定的**：标题写了某个在册角色名，而本章正文与其蓝图里都没有他。
 *
 * 两条收窄：
 * - 本章**必须有正文**才判（正文还没写时「没提到」是必然的，不是缺陷）；
 * - 标题里的名字必须是**名册里的人**（否则「温」「徐」这类单字或未建档的人名会误命中）。
 */
export function findTitleBodyMismatchFindings(
  chapters: readonly TitleChapterInput[],
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  for (const chapter of [...chapters].sort((left, right) => left.chapterNumber - right.chapterNumber)) {
    const title = String(chapter.title ?? '').trim()
    // 只有本章**已经有正文**时才判：正文还没写时「标题没点到的人没出现」是必然的。
    const body = String(chapter.content ?? '')
    if (!title || !body.trim()) continue
    const plan = String(chapter.keyEvents ?? '')
    const castNames = (chapter.castNames ?? []).map(name => String(name ?? '').trim()).filter(Boolean)
    if (castNames.length === 0) continue
    const missing = castNames.filter(name => title.includes(name) && !body.includes(name) && !plan.includes(name))
    if (missing.length === 0) continue
    findings.push({
      // 章号是既成事实，不随写作推进而变（#86/#89/#98/#108）。
      stableFactKey: `chapter-title:unmet:${chapter.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: chapter.chapterNumber,
      evidence: `第${chapter.chapterNumber}章标题「${title}」点到了 ${missing.join('、')}，但本章正文与其蓝图里都没有出现`,
      issue: {
        zhCN: `本章标题点了名，人却没到场：标题「${title}」写的是 ${missing.join('、')}，而本章正文与蓝图里都没有这个名字。标题会进目录页与导出文件名，读者按它回忆情节；把它挂在一个人没出场的章上，目录和内容就对不上了。`,
        enUS: `This chapter's title names ${missing.join(', ')}, but they appear nowhere in the chapter's prose or its blueprint. Titles go into the table of contents and export file names; naming someone who never shows up makes the contents disagree with the chapter.`,
      },
      suggestion: {
        zhCN: `二选一：把标题改成真正在场的人或那件物（本章实际写到的主角动作 / 物证）；或者若标题才是本意，把这个人写进这一章。`,
        enUS: `Either retitle it after who is actually on the page (or the object the chapter really turns on), or write this character into the chapter.`,
      },
    })
  }
  return findings
}
