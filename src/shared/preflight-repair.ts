/**
 * 预检提醒的**字段级补丁**这一层（issue #137 第二层）。
 *
 * 第一层（`preflight-route.ts`）已经回答了两个能断言的问题：这条提醒属于**哪一层**、
 * 写前这一刻**能不能改**。剩下的那一半是「按建议把它改掉」——
 *
 * ## 为什么这一半必须交给模型（用户 2026-11-04 定规）
 *
 * 判据给出的 `suggestion` 是**自然语言改法**（「换一个动作落点」「在角色名单里补一段外貌」
 * 「把这一句日界改成蓝图声明的第 3 日」）。规则无法把它落到具体字段：没有任何正则可以
 * 从「换一个动作落点」推出应该改 `keyEvents` 里的哪几个字。照句式用正则去改，等于换个
 * 地方写词表——只对这一本书成立。
 *
 * 所以本模块**只做能断言的四件事**，生成那一格留给模型：
 * 1. **可写字段表**（`LAYER_FIELDS`）：每层到底能改哪几个字段，封闭目录；
 * 2. **组装输入**（`buildRepairPrompt`）：一次调用带**同层的一批**提醒 + 该层现有全文
 *    + 判据原话（issue/evidence/suggestion），并明确要求「只输出变化的字段」；
 * 3. **校验输出**（`parseRepairPatch`）：只接受表里有的字段、只接受字符串值、
 *    与原文相同的字段一律剔除（空 patch = 模型认为无需改动，这也是合法结果）；
 * 4. **差异**（`diffRepairPatch`）：逐字段给出「原文 → 改写后」，供作者确认后才落库。
 *
 * ⚠️ 刻意**不做**「自动采纳」：差异必须由作者点（`applyRepairPatch` 只是接口，
 * 由界面在确认后调用现成写通道）。也**不做**整篇重写——整篇重写会让模型顺手改掉
 * 与提醒无关的段落，而作者看不到那些改动。
 *
 * ⚠️ 旧章（已定稿正文）**不在这里**：改旧章要走「新版本 + 重新定稿」，
 * 那是另一个动作（`preflightRoute` 标 `needs-finalized-prose` 的都在门外）。
 */
import type { ConsistencyFinding } from './consistency-preflight'
import type { PreflightLayer } from './preflight-route'

/**
 * 每层**可写字段**的封闭目录（字段名与该层写通道的载荷一致）。
 *
 * ⚠️ 世界观层的字段名与 `ProjectCoreData` 对齐；`charactersArch` **不在**表里 ——
 * 它由角色名单自动生成，直写会被 `project-core-repository.ts` 拒绝（issue #137 约束 2）。
 * ⚠️ 蓝图层故意**不含** `chapterNumber`：章号是身份，不是可改写内容。
 */
export const LAYER_FIELDS: Readonly<Record<PreflightLayer, readonly string[]>> = Object.freeze({
  world: ['worldbuilding', 'premise', 'coreOutline', 'goldenFinger', 'globalGuidance', 'writingStyle'],
  cast: ['name', 'role', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'relationships', 'arc', 'notes'],
  outline: ['title', 'summary', 'beat'],
  blueprint: ['title', 'role', 'purpose', 'keyEvents', 'characters', 'suspenseHook', 'costsAndTurns', 'foreshadowing', 'userGuidance', 'notes'],
  // 正文层只能「新版本 + 重新定稿」，不走字段级 patch。
  prose: [],
})

/** 一次修复调用的输入：同一层的一批提醒 + 该层现有全文。 */
export interface RepairRequest {
  layer: PreflightLayer
  /** 涉及哪一章（蓝图层/细纲层用；世界观层可以为 null）。 */
  chapterNumber: number | null
  /** 该层现有的字段全文（字段名 → 原文）。只放 `LAYER_FIELDS[layer]` 里的字段。 */
  current: Readonly<Record<string, string>>
  /** 同层的一批提醒（一次调用处理一批，不要每条一次）。 */
  findings: ReadonlyArray<Pick<ConsistencyFinding, 'stableFactKey' | 'evidence' | 'issue' | 'suggestion'>>
}

/** 模型给出的**字段级**改写结果。 */
export interface RepairPatch {
  /** 字段名 → 新值；只含与原文不同的字段。 */
  fields: Record<string, string>
  /** 模型对每处改动的说明（按字段），供差异视图展示。 */
  reasons: Record<string, string>
}

/** 组装模型输入（纯函数，可直测）。 */
export function buildRepairPrompt(
  request: RepairRequest,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): { system: string; user: string } {
  const allowed = LAYER_FIELDS[request.layer]
  const system = locale === 'en-US'
    ? [
      'You revise ONE layer of a novel project so that specific consistency reminders no longer hold.',
      `Only these fields may change: ${allowed.join(', ')}.`,
      'Output a single JSON object: {"fields": {"<field>": "<new full text>"}, "reasons": {"<field>": "<what changed and why>"}}.',
      'Rules: (1) include ONLY fields you actually changed — omit every unchanged field;',
      '(2) each value must be the COMPLETE new text of that field, not a fragment or a diff;',
      '(3) do not invent facts that are absent from the reminders and the current text;',
      '(4) do not touch fields unrelated to the reminders;',
      '(5) if no change is warranted, output {"fields": {}, "reasons": {}}.',
      '(6) no commentary outside the JSON.',
    ].join('\n')
    : [
      '你的任务是改**其中一层**的内容，使下面这几条一致性提醒不再成立。',
      `只允许改这些字段：${allowed.join('、')}。`,
      '输出一个 JSON 对象：{"fields": {"<字段>": "<改写后的完整文本>"}, "reasons": {"<字段>": "<改了什么、为什么>"}}。',
      '规则：(1) 只输出**真正改动**的字段，没改的字段一律不出现；',
      '(2) 每个值是该字段**改写后的完整文本**，不是片段、不是 diff；',
      '(3) 不得添加提醒与现有文本中都没有的事实；',
      '(4) 不要顺手动与提醒无关的字段；',
      '(5) 若确实无需改动，输出 {"fields": {}, "reasons": {}}；',
      '(6) JSON 之外不要写任何解释。',
    ].join('\n')

  const currentText = allowed
    .map(field => {
      const value = String(request.current[field] ?? '')
      return `### ${field}\n${value.trim() || '（空）'}`
    })
    .join('\n\n')
  const reminderText = request.findings.map((finding, index) => {
    const title = locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN
    const advice = locale === 'en-US' ? finding.suggestion.enUS : finding.suggestion.zhCN
    return [
      `${index + 1}. [${finding.stableFactKey}]`,
      `${locale === 'en-US' ? 'Problem' : '问题'}：${title}`,
      `${locale === 'en-US' ? 'Evidence' : '证据'}：${finding.evidence}`,
      `${locale === 'en-US' ? 'Suggested fix' : '建议改法'}：${advice}`,
    ].join('\n')
  }).join('\n\n')

  const user = locale === 'en-US'
    ? [
      request.chapterNumber === null ? '' : `Chapter: ${request.chapterNumber}`,
      '## Current text of this layer',
      currentText,
      '## Reminders to resolve (all of them are in this same layer)',
      reminderText,
    ].filter(Boolean).join('\n\n')
    : [
      request.chapterNumber === null ? '' : `第 ${request.chapterNumber} 章`,
      '## 这一层的现有文本',
      currentText,
      '## 要消掉的提醒（都在这一层）',
      reminderText,
    ].filter(Boolean).join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（纯函数，可直测）。
 *
 * 五道收窄，全部是「能断言」的：
 * - 不是合法 JSON → null（由调用方当成一次失败，不静默采纳）；
 * - 出现**表外字段** → 整条拒绝（模型试图改别的层/别的字段，宁可不采纳）；
 * - 值不是字符串 → 该字段丢弃；
 * - 值与原文**逐字相同** → 剔除（那是「没改」，不该出现在差异里）；
 * - 结果为空 → 返回空 patch（**合法**：模型认为无需改动）。
 */
export function parseRepairPatch(
  raw: string,
  request: Pick<RepairRequest, 'layer' | 'current'>,
): RepairPatch | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as { fields?: unknown; reasons?: unknown }
  if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) return null
  const allowed = new Set(LAYER_FIELDS[request.layer])
  const reasonRecord = (record.reasons && typeof record.reasons === 'object' && !Array.isArray(record.reasons)
    ? record.reasons : {}) as Record<string, unknown>
  const fields: Record<string, string> = {}
  const reasons: Record<string, string> = {}
  for (const [field, value] of Object.entries(record.fields as Record<string, unknown>)) {
    // 表外字段：模型想改不属于这一层的东西 —— 整条拒绝，不做「只采纳合法部分」的补救
    // （那样作者会以为全都改了）。
    if (!allowed.has(field)) return null
    if (typeof value !== 'string') continue
    const next = value.trim()
    if (!next) continue
    if (next === String(request.current[field] ?? '').trim()) continue
    fields[field] = value
    const reason = reasonRecord[field]
    if (typeof reason === 'string' && reason.trim()) reasons[field] = reason.trim()
  }
  return { fields, reasons }
}

/** 去掉 ```json 围栏（模型常加，不影响语义）。 */
function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/** 一处字段级差异（供 `MergeView`/差异列表渲染，不给自动采纳）。 */
export interface RepairFieldDiff {
  field: string
  before: string
  after: string
  reason: string
}

/** 把 patch 变成逐字段差异（纯函数）。顺序跟 `LAYER_FIELDS` 一致，便于界面稳定。 */
export function diffRepairPatch(
  patch: RepairPatch,
  request: Pick<RepairRequest, 'layer' | 'current'>,
): RepairFieldDiff[] {
  return LAYER_FIELDS[request.layer]
    .filter(field => Object.hasOwn(patch.fields, field))
    .map(field => ({
      field,
      before: String(request.current[field] ?? ''),
      after: patch.fields[field]!,
      reason: patch.reasons[field] ?? '',
    }))
}

/**
 * 把一批提醒按**层**拆成若干次修复调用（一次一层，不要一条一次）。
 *
 * 与 `groupPreflightRoutes` 的分工：那边管「能不能改」，这边只管「怎么分批调用」。
 * 不可修的键由调用方在分组时就已经筛掉（`ks`），这里不做二次判断。
 */
export function planRepairCalls<T extends Pick<ConsistencyFinding, 'stableFactKey'> & { layer: PreflightLayer }>(
  findings: readonly T[],
): Array<{ layer: PreflightLayer; findings: T[] }> {
  const order: readonly PreflightLayer[] = ['world', 'cast', 'outline', 'blueprint']
  const buckets = new Map<PreflightLayer, T[]>()
  for (const finding of findings) {
    if (finding.layer === 'prose') continue
    const list = buckets.get(finding.layer) ?? []
    list.push(finding)
    buckets.set(finding.layer, list)
  }
  return order.flatMap(layer => {
    const list = buckets.get(layer)
    return list && list.length > 0 ? [{ layer, findings: list }] : []
  })
}
/**
 * 「全部修复」的**跨层排队**（issue #137）。
 *
 * 现状的缺口：`planRepairCalls` 会把可修的提醒按层排好序，但界面只取了第一批
 * （`calls[0]`）——于是「全部修复」实际只修**一层**，其余层的提醒原样留着，
 * 而按钮上写的是「全部」。这不是判据问题，是排队没做。
 *
 * 排队的两条规则（都可断言，所以放在这里而不是界面里）：
 * 1. **一层一次确认**：每层的差异必须由作者点过（不能连跑三层后一次性丢给作者看）；
 * 2. **同一层不重复排队**：一层要么一次修完，要么失败后由作者重来——
 *    否则「模型说这层不用改」会让队列原地打转。
 *
 * ⚠️ 组内键的顺序保持 `planRepairCalls` 给出的顺序（world → cast → outline → blueprint），
 * 这样「先修设定、再修蓝图」这件事对作者是可预期的。
 */
export interface RepairQueueGroup<T> {
  layer: PreflightLayer
  findings: readonly T[]
}

/** 推进排队：去掉刚处理完的那一层，返回剩余队列（不改原数组）。 */
export function advanceRepairQueue<T extends RepairQueueGroup<unknown>>(
  queue: readonly T[],
  /** 刚处理完的层；null 表示这一层没成（不推进，由作者决定重来还是跳过）。 */
  done: PreflightLayer | null,
): T[] {
  if (done === null) return [...queue]
  return queue.filter(group => group.layer !== done)
}

/** 队列里还剩哪几层（供界面告诉作者「还有 N 层」）。 */
export function remainingRepairLayers<T extends RepairQueueGroup<unknown>>(queue: readonly T[]): PreflightLayer[] {
  return [...new Set(queue.map(group => group.layer))]
}

/**
 * 作者放弃当前这一组（「都不改」）时该不该继续下一层。
 *
 * 判据：**没有改动就没推进**——这一层的提醒仍然成立，队列保持原样，
 * 但它会挡住后续层（`advanceRepairQueue(queue, null)` 返还原队列）。
 * 所以放弃时必须显式结束整条链，否则界面会反复提出同一组。
 */
export function shouldContinueRepairChain(options: {
  /** 作者是否采纳了至少一处改动。 */
  appliedChanges: boolean
  /** 队列里是否还有别的层。 */
  hasOtherLayers: boolean
}): boolean {
  return options.appliedChanges && options.hasOtherLayers
}
