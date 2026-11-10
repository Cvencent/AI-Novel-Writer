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
  /**
   * 这条提醒**要改哪一章**（issue #212）。
   *
   * 「来源章」不等于「要改的章」：`cast:absent:叶九:89` 的来源是第 89 章（他上次出现的地方），
   * 而它的出路「安排一次登场」要改的是**当前这一章**的蓝图；反过来
   * `chapter-time:undated:42`（第 42–55 章连着没跨日）的来源是第 42 章，要改的却是那一整段。
   * 旧实现只拿「来源章」当判据，于是前者被误判成「旧章改不了」（同屏写着「要去重开第 89 章」，
   * 而真正该改的是本章），后者被误判成「现在就能改」（拿第 95 章的蓝图去改第 42–55 章的问题，
   * 模型只能回「不需要改」）。
   */
  targetChapter?: number
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
  // entrance-selection-review.ts：角色登场段确认——修在当前章正文。
  'entrance-selection': 'prose',
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
  // 同一事件的日期跨章不一致（issue #216）：日期落在正文，但**改法是改正文**（或蓝图时点），
  // 而区间型与「旧章」的处置由 targetChapter 那套判据接管。
  'date': 'blueprint',
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

/**
 * 「要改的是**当前这一章**」的键族（issue #212）。
 *
 * 判据的**来源章**在旧章、但出路落在本章：`cast:absent:*` 说「这个角色已连续 N 章没进蓝图」，
 * 它的两个出路（让他登场 / 写明退场）做的都是本章的事。这类不该因为来源章早于当前章而被判死。
 *
 * ⚠️ 这是**分派约定**（键族 → 目标章），与 `PREFIX_LAYERS` 同族，属 §1.7.1 允许的那一层；
 * 不是「内容判断」。新增判据要落进这张目录时，必须同时想清楚「它的出路在哪一章」。
 */
const CURRENT_CHAPTER_TARGETS: ReadonlySet<string> = new Set(['cast:absent'])

/**
 * 「要改的是**一整段多章**」的键族，目标章 = key 里那个章号（区间首章）（issue #212）。
 *
 * `chapter-time:undated:42` = 「第 42–55 章连着 14 章没跨日」：key 锚在首章，而它的
 * `sourceChapter` 报的是**当前章**（`chapter-time-anchor.ts` 里写的是 `currentChapter`）。
 * 于是旧口径 `sourceChapter >= currentChapter` 恰好成立 → 被判成「现在就能修」，
 * 而「修复」固定用当前章读层文本 → 拿第 95 章的蓝图去改第 42–55 章的问题，
 * 模型只能回「不需要改」（现场 387 tok 的回复就是这句）。
 *
 * 这类**写前那一刻改不了**：要改的是 N 张已定稿蓝图的时点。
 */
const INTERVAL_TARGETS: ReadonlySet<string> = new Set(['chapter-time:undated'])

/**
 * 「读的是**设定层**、没有真实章号」的键族（issue #226）。
 *
 * `timeline:design-anchor:*` 的判据读的是前提/世界观/人物群像三段（`designSections`），
 * 不读任何正文——它的 `sourceChapter` 只是 findings 记账的**占位章号**（判据里写死 1，
 * 「架构阶段没有章号」）。旧口径拿它当真章号去比：占位 1 恒小于当前章 N → 被判成
 * 「旧章、写前改不了」，卡片渲染「去第 1 章出新版本」；点过去落在第 1 章正文重写页，
 * 与要改的设定层文本毫无关系（用户原话：「跳过了跳到第一章，然后呢，然后就没有然后了呀」）。
 * 「去设定改」「修复」两颗按钮因此永远不出现。
 *
 * 设定层文本**不按章存储**——改设定页就是全书的权威，没有「旧章」概念。
 * 这类键族**不进旧章拦截**：`sourceChapter` 是占位值时整个「源章 < 当前章」的合取不成立，
 * 走默认分支 = 可修（destination 是设定页）。
 */
const PLACEHOLDER_CHAPTER_SOURCES: ReadonlySet<string> = new Set(['timeline:design-anchor'])

/** key 末尾的章号（`chapter-time:undated:42` → 42）；读不到时 undefined。 */
function trailingChapterOf(stableFactKey: string): number | undefined {
  const last = String(stableFactKey ?? '').split(':').at(-1)
  const value = Number(last)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 键族（前两段）能截出来时返回它，否则退回第一段。 */
function familyOf(stableFactKey: string): string {
  const segments = String(stableFactKey ?? '').split(':')
  return segments.slice(0, Math.min(2, segments.length)).join(':')
}

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
  /**
   * 区间型提醒（issue #212）：目标章是 key 里那个首章，**写前改不了**。
   * 必须在下面那条「当前章」判断之前拦下——否则它会被判成可修（见 INTERVAL_TARGETS 注释）。
   */
  if (INTERVAL_TARGETS.has(familyOf(stableFactKey))) {
    return { layer, destination, repairable: false, blockedBy: 'needs-finalized-prose',
      ...(trailingChapterOf(stableFactKey) === undefined ? {} : { targetChapter: trailingChapterOf(stableFactKey) }) }
  }
  // 旧章（已定稿）的提醒：写前改不动，与 `prose` 层同一处置。
  const { currentChapter, sourceChapter } = options
  // 占位章号不参与「旧章」判断（issue #226）：设定层判据没有真实章号，sourceChapter 只是
  // 记账占位——拿它当真章号会把「去设定改」错杀成「去第 1 章出新版本」。
  if (PLACEHOLDER_CHAPTER_SOURCES.has(familyOf(stableFactKey))) {
    return { layer, destination, repairable: true, ...(typeof currentChapter === 'number' ? { targetChapter: currentChapter } : {}) }
  }
  if (typeof currentChapter === 'number' && typeof sourceChapter === 'number'
    && Number.isSafeInteger(currentChapter) && Number.isSafeInteger(sourceChapter)
    && sourceChapter < currentChapter) {
    /**
     * 但要改的是**本章**时不算旧章（issue #212）：`cast:absent:*` 的来源是「他上次出现的章」，
     * 出路（让他回来 / 写明退场）落在本章蓝图上。旧实现把它判死，同一张卡片上
     * 建议写「安排一次登场」、阻断文案写「去重开第 89 章」——两句话互相矛盾。
     */
    if (CURRENT_CHAPTER_TARGETS.has(familyOf(stableFactKey))) {
      return { layer, destination, repairable: true, targetChapter: currentChapter }
    }
    return { layer, destination, repairable: false, blockedBy: 'needs-finalized-prose', targetChapter: sourceChapter }
  }
  return { layer, destination, repairable: true, ...(typeof currentChapter === 'number' ? { targetChapter: currentChapter } : {}) }
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