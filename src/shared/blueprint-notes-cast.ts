/**
 * 蓝图 `notes` 里「角色动态」表的角色名（issue #204）。
 *
 * 现场：一位演了 9 章、58 段台词的配角，名字**只写在 notes 的角色动态表**里，
 * `characters` 数组一次都没有。于是「未登记角色」判据看不见他，预检一个字都不报；
 * 而 `notes` 恰恰是**唯一逐角色列名字**的字段（由定稿后处理生成、结构固定）。
 *
 * 数据形状（`src/services/builtin-prompt-templates.ts` 的要点模板）：
 *
 * ```
 * ## 角色动态
 * | 角色 | 本章变化/状态 |
 * |------|-------------|
 * | 灰褂 | 在送检附件登记单添「复写层随件送检」…… |
 * ```
 *
 * ⚠️ 这里只做**格式解析**（§1.7.1 允许的那一层）：找 `## 角色动态` 这一节、
 * 按 Markdown 表格取**第一列**、去掉括注。**不判断这些名字是不是同一个人**，
 * 也不认任何题材词——节名是模板约定的 schema 键。
 */
/**
 * ⚠️ 这一条进过 `literal-tables.baseline.json`（等于一次**显式决定**），理由：
 * 「角色动态」不是题材词，而是**我们自己提示词模板里的小节名**
 * （`src/services/builtin-prompt-templates.ts` 的要点模板：`## 角色动态`）。
 * 它是一层 schema 键——和 JSON 字段名同类，落在 §1.7.1「schema / 格式解析」那一格。
 * 本模块不判断任何名字是不是同一个人，只按这个节名找到表格、取第一列。
 */
const CAST_SECTION = /^#{1,6}\s*角色动态\s*$/u

/** 去掉括注（「灰褂（稽核组）」→「灰褂」）与空白。 */
function bareName(cell: string): string {
  return String(cell ?? '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/\*\*|__/gu, '')
    .replace(/\s+/gu, '')
    .trim()
}

/**
 * 从一张蓝图的 `notes` 里抽出「角色动态」表的角色名（按出现顺序，去重）。
 *
 * 解析失败（没有这一节、表格不合法）时返回空数组——**不猜、不报错**：
 * notes 由模型生成，形状可能漂；拿不到就当没有，别把解析失败变成假提醒。
 */
export function notesCastNames(notes: string | null | undefined): string[] {
  const lines = String(notes ?? '').split(/\r?\n/u)
  const names: string[] = []
  const seen = new Set<string>()
  let inside = false
  /** 本节里见过的表格行数：第 1 行是**表头**（位置判定，不靠认「角色」这两个字）。 */
  let tableRows = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^#{1,6}\s/u.test(trimmed)) {
      inside = CAST_SECTION.test(trimmed)
      tableRows = 0
      continue
    }
    if (!inside) continue
    // 只认表格行；空行与正文段落（「（用表格记录…）」这类说明）直接跳过。
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|')
    tableRows += 1
    // 第 1 行是表头（模板固定写成 `| 角色 | 本章变化/状态 |`），分隔行 `|---|` 也跳过。
    // ⚠️ 只按**位置**判，不去认「角色」「角色名」这些字——那会变成一张内容词表
    // （用户 2026-11-05 的定规：内容判断不许词表；本仓的 literal-table 守卫也会拦）。
    if (tableRows === 1) continue
    const first = bareName(cells[0] ?? '')
    if (/^[-:\s]+$/u.test(cells[0] ?? '') || !first) continue
    if (seen.has(first)) continue
    seen.add(first)
    names.push(first)
  }
  return names
}

/**
 * 把「数组 ∪ notes 表」合成同一个出场名单（issue #204）。
 *
 * `characters` 数组是作者/模型填的；notes 是定稿后处理对**已发生**的记述。
 * 两者不一致时（本书 41/91 张蓝图），只有后者能看见「正文里真的演了但数组里没写」的人。
 */
/**
 * 名单里**只来自 notes 表**的条目（issue #214）。
 *
 * 与 `mergedBlueprintCast` 同源，但只返回「数组里没有、表里有」的那些——
 * 判据据此把两处来源分开对待（来源是可断言的事实；「它是不是人名」才是内容判断）。
 */
export function notesOnlyCast(characters: readonly string[] | undefined, notes: string | null | undefined): string[] {
  const declared = new Set((characters ?? []).map(name => String(name ?? '').trim()).filter(Boolean))
  return notesCastNames(notes).filter(name => !declared.has(name))
}

export function mergedBlueprintCast(characters: readonly string[] | undefined, notes: string | null | undefined): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const raw of [...(characters ?? []), ...notesCastNames(notes)]) {
    const name = String(raw ?? '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    merged.push(name)
  }
  return merged
}