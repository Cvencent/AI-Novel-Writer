/**
 * 预检提醒「该去哪一层改」（issue #137）。
 *
 * 现场：写前预检弹 13 条提醒，每条下面只有「保存安排 / 我已知 / 带提醒继续写」，
 * **没有任何「修复」出口**。作者只能自己判断每条该去哪一层、退出弹层、翻页面、
 * 手工改、再回来重检——13 条就是 13 次往返。
 *
 * issue 的调研结论（本轮复核一致）：提醒指向的层远不止蓝图，而且**每层的可写性不同**：
 *
 * | 层 | 写通道 | 可写性 |
 * |---|---|---|
 * | 世界观 / 故事前提 / 核心大纲 | `db:project-core-update`（逐字段） | 可写 |
 * | 角色卡 / 角色名单 | `db:character-roster-commit`（逐字段 diff + CAS） | 可写 |
 * | 细纲 / 粗纲 | `db:arc-outline-replace-segment` | 可写 |
 * | 本章蓝图 | `db:stage-review-apply-blueprint`（**唯一字段级 merge**） | 可写 |
 * | 人物群像 `charactersArch` | ⚠️ 被硬禁直写（由角色名单自动生成） | 须改角色名单 |
 * | 已定稿正文 | ⚠️ 只读（`status==='finalized'` 拒绝） | 只能「新版本 + 重新定稿」 |
 *
 * 本模块只做**分派**这一件事：用 `stableFactKey` 前缀映射到层（与
 * `acknowledgement-title.ts` 的键族同构，**不新增词表**），并给出「该去哪一页」。
 * 它不生成补丁、不改任何数据——「一键修复」的生成与差异确认是它的下游。
 *
 * `repairable` 的语义严格限定为「**在写前这个时刻、不需要正文、有现成写通道**」：
 * - `prose:*` / `chapter-ending:*` / `handwriting:*` 这类判据读的是**已定稿正文**，
 *   写前那一刻改不了（本章正文还不存在）→ 不在本轮；
 * - `charactersArch` 只能通过角色名单改 → 指向角色层，但标注理由。
 */
import type { ResourcePage, WorkStage } from '../stores/navigation/navigation-intents'

/** 提醒指向的层。 */
export type PreflightLayer = 'world' | 'cast' | 'outline' | 'blueprint' | 'prose'

export interface PreflightRoute {
  layer: PreflightLayer
  /** 该去哪一页（`stage` 与 `resource` 二选一，与 NavigationIntent 同形）。 */
  destination: { kind: 'stage'; stage: WorkStage } | { kind: 'resource'; page: ResourcePage }
  /**
   * 写前这一刻能否直接修（有现成写通道、且不需要本章正文）。
   * `false` 时 `blockedBy` 说明原因，界面据此显示「为什么现在改不了」而不是一个点了没反应的按钮。
   */
  repairable: boolean
  /** 不可修时给作者的一句话（可读原因）。 */
  blockedBy?: 'needs-finalized-prose' | 'characters-arch-readonly' | 'unknown-layer'
}

/**
 * 键族 → 层。键族取自 `src/shared/*.ts` 里各判据实际发出的 `stableFactKey` 前缀。
 *
 * ⚠️ 与 `acknowledgement-title.ts` 一样，这是**封闭前缀目录**；新增判据时必须同时补在这里
 * ——`preflight-route-coverage.test.ts` 会穷举仓库里所有 `stableFactKey` 字面量并断言
 * 每个前缀都能被分派（漏了会红），避免新判据静默落到 `unknown-layer`。
 */
const PREFIX_LAYERS: Readonly<Record<string, PreflightLayer>> = Object.freeze({
  // —— 世界观 / 设定层 ——
  'ability-limit': 'world',
  // `ability-limit-bypass.ts` 实际发的是 `ability:limit-bypassed`（≈#100）：限制从世界观取，改要回世界观。
  'ability': 'world',
  'timeline': 'world',
  'world': 'world',
  'design': 'world',
  // —— 角色层 ——
  'cast': 'cast',
  'character': 'cast',
  'handwriting': 'cast',
  'cast-name-drift': 'cast',
  'blueprint-cast': 'cast',
  // 正文里写了年龄却归不到人（≈#149）：修法是在角色名单里点名建卡，或改写那句不依赖年龄的表述。
  'character-age': 'cast',
  // 身体标志换侧（#153）：卡上的「右小指」与正文的「左手」对账，改卡或改正文都在角色层/正文层。
  'character:body-mark-side': 'prose',
  // —— 细纲 / 粗纲层 ——
  'arc': 'outline',
  'plot-outline': 'outline',
  'synopsis-cast': 'outline',
  // —— 蓝图层（本章及后续的可写计划）——
  'architecture': 'outline',
  'continuity': 'prose',
  'entrance': 'blueprint',
  'prop-handover': 'blueprint',
  'ability-budget': 'blueprint',
  'prose-flavor': 'prose',
  'revocation': 'blueprint',
  'chapter-title': 'blueprint',
  'chapter-opening': 'blueprint',
  'chapter-time': 'blueprint',
  'chapter-ending': 'blueprint',
  'blueprint': 'blueprint',
  'deadline': 'blueprint',
  'foreshadowing': 'blueprint',
  'thread': 'blueprint',
  'repeated-revocation': 'blueprint',
  // —— 正文层（已定稿只读）——
  'prose': 'prose',
  'prop': 'prose',
  'motif': 'prose',
  'glyph': 'prose',
  'numbering': 'prose',
  'declared-count': 'prose',
  'inventory': 'prose',
  'gauge': 'prose',
  'promise': 'prose',
  'assertion-reversal': 'prose',
  'quote-style': 'prose',
  'loss-restatement': 'prose',
  'stale-state': 'prose',
  'entrance-shot': 'prose',
  'paragraph-opener': 'prose',
})

/** 各层的落点页面。 */
const LAYER_DESTINATIONS: Readonly<Record<PreflightLayer, PreflightRoute['destination']>> = Object.freeze({
  world: { kind: 'stage', stage: 'setup' },
  cast: { kind: 'stage', stage: 'setup' },
  outline: { kind: 'stage', stage: 'architecture' },
  blueprint: { kind: 'stage', stage: 'blueprint' },
  prose: { kind: 'stage', stage: 'manuscript' },
})

/** 前缀最长匹配（与 `acknowledgementFamilyTitle` 同一手法：先比两段，再比一段）。 */
function layerOf(stableFactKey: string): PreflightLayer | null {
  const segments = String(stableFactKey ?? '').split(':')
  for (const length of [2, 1]) {
    if (segments.length < length) continue
    const candidate = segments.slice(0, length).join(':')
    const layer = PREFIX_LAYERS[candidate]
    if (layer) return layer
  }
  return null
}

/**
 * 一条提醒该去哪一层、能不能现在就改。
 *
 * 读已定稿正文的判据（`prose`）在写前那一刻改不了——但第 137 号 issue 要求的
 * 「旧章修复 + 自动重新定稿」是第二步，本轮先把 `repairable: false` 与原因如实标出来，
 * 界面据此显示「需要正文，先写完这一章再来」而不是给一个空按钮。
 *
 * ⚠️ `sourceChapter` 是**第二个独立维度**（本模块第一版漏掉的那一问）：
 * 有些判据虽被分派到计划层，但它们读的是**已定稿正文**（`chapter-ending` / `anchor-unmet`
 * 的 on-prose 侧、`deadline` / `chapter-title:duplicate` / `handwriting` 等），
 * 只有「问题章 ≥ 即将写的那一章」才在写前改得动。实测那本书 39 条里，有 30 条被旧实现
 * 标成 `repairable: true`，而它们的 `sourceChapter` 全部早于当前章——照那个标记做
 * 「一键修复」，改的是**已定稿的旧章**，而旧章本轮改不了。
 *
 * 所以本函数接受可选的两章号；给了就按「源章 ≥ 当前章」再合取一次，
 * 早于当前章的统一标成 `needs-finalized-prose`（旧章只能新版本 + 重新定稿，属第二步）。
 * 不给时保持原行为（只看层），供只关心「去哪一层」的调用方使用。
 */
export function preflightRouteOf(
  stableFactKey: string,
  options: { currentChapter?: number; sourceChapter?: number } = {},
): PreflightRoute {
  const layer = layerOf(stableFactKey)
  if (layer === null) {
    return { layer: 'blueprint', destination: LAYER_DESTINATIONS.blueprint, repairable: false, blockedBy: 'unknown-layer' }
  }
  const destination = LAYER_DESTINATIONS[layer]
  if (layer === 'prose') {
    return { layer, destination, repairable: false, blockedBy: 'needs-finalized-prose' }
  }
  // 旧章（已定稿）的提醒：写前改不动，与 `prose` 层同一处置。
  const { currentChapter, sourceChapter } = options
  if (typeof currentChapter === 'number' && typeof sourceChapter === 'number'
    && Number.isSafeInteger(currentChapter) && Number.isSafeInteger(sourceChapter)
    && sourceChapter < currentChapter) {
    return { layer, destination, repairable: false, blockedBy: 'needs-finalized-prose' }
  }
  return { layer, destination, repairable: true }
}

/**
 * 一组提醒的**分层归并**（供「全部修复」按层分组，避免 N 次模型调用）。
 *
 * 返回顺序固定（world → cast → outline → blueprint → prose），便于界面与测试比对。
 *
 * 每组只收**写前真能改**的键（与 `preflightRouteOf` 同一口径，含「源章 ≥ 当前章」这一问）：
 * 一组里混着旧章的键时，「全部修复」会去改已定稿的章——所以按**可修性**再分一档，
 * 不可修的进 `blocked` 并带着原因，界面据此显示「这一组里有 N 条要改旧章，先放着」。
 */
export interface PreflightRouteGroup {
  layer: PreflightLayer
  /** 写前真能改的键。 */
  ks: string[]
  /** 同一层里写前改不了（要正文 / 是旧章 / 群像只读 / 未知层）的键。 */
  blocked: string[]
  /** 整组（含 blocked 那部分）是否有可修的键。 */
  repairable: boolean
  blockedBy?: PreflightRoute['blockedBy']
}

export function groupPreflightRoutes(
  findings: ReadonlyArray<{ stableFactKey: string; sourceChapter?: number }>,
  options: { currentChapter?: number } = {},
): PreflightRouteGroup[] {
  const order: readonly PreflightLayer[] = ['world', 'cast', 'outline', 'blueprint', 'prose']
  const buckets = new Map<PreflightLayer, { ks: string[]; blocked: string[]; blockedBy?: PreflightRoute['blockedBy'] }>()
  for (const finding of findings) {
    const route = preflightRouteOf(finding.stableFactKey, {
      ...(options.currentChapter === undefined ? {} : { currentChapter: options.currentChapter }),
      ...(finding.sourceChapter === undefined ? {} : { sourceChapter: finding.sourceChapter }),
    })
    const bucket = buckets.get(route.layer) ?? { ks: [], blocked: [] }
    if (route.repairable) bucket.ks.push(finding.stableFactKey)
    else {
      bucket.blocked.push(finding.stableFactKey)
      bucket.blockedBy ??= route.blockedBy
    }
    buckets.set(route.layer, bucket)
  }
  return order.flatMap(layer => {
    const bucket = buckets.get(layer)
    if (!bucket) return []
    return [{
      layer,
      ks: bucket.ks,
      blocked: bucket.blocked,
      repairable: bucket.ks.length > 0,
      ...(bucket.blockedBy ? { blockedBy: bucket.blockedBy } : {}),
    }]
  })
}