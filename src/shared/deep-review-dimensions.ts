/**
 * 定稿审稿的「深度检查」维度（issue #229）。
 *
 * 用户定规：模型判据的正确家是**定稿时的审稿**（上一章写完时自动做、可勾选），
 * 不是「写新一章的预检」——「上一章的作业不该摊在下一章的门口」。
 *
 * 这 13 个维度与原写前预检的「核对…」按钮一一对应（搬家，不是新判据）；
 * 审稿入口默认全勾，作者可按书按阶段取消，勾选状态持久化在项目目录的
 * `deep_review_preferences.json`（与 chapter_creation_log 同一 fs 通道）。
 *
 * ⚠️ 这里**只有簿记**（键、文案、持久化）；每个维度的模型调用实现仍在
 * `preflight-repair.ts` 的 `reviewXxx` ——审稿完成后逐维调用，findings 并进审稿报告。
 */

export interface DeepReviewDimension {
  /** 稳定键（持久化用），与原 `onCheck*` 回调一一对应。 */
  key: DeepReviewDimensionKey
  zh: string
  en: string
  /** 勾选说明（弹层里的一行小字）。 */
  zhDesc: string
  enDesc: string
}

export type DeepReviewDimensionKey =
  | 'memory'
  | 'ability'
  | 'style'
  | 'content'
  | 'sensory'
  | 'appearance'
  | 'blueprintFacts'
  | 'evidence'
  | 'handwriting'
  | 'blueprintInternal'
  | 'lossRestatement'
  | 'deadline'
  | 'dateConflict'

/** 顺序即原预检按钮的顺序（作者已经熟悉这个排布）。 */
export const DEEP_REVIEW_DIMENSIONS: readonly DeepReviewDimension[] = Object.freeze([
  { key: 'memory', zh: '记忆回指', en: 'Remembered scenes', zhDesc: '回忆的事在前文找不找得到', enDesc: 'remembered scenes have an earlier anchor' },
  { key: 'ability', zh: '能力限制', en: 'Ability limits', zhDesc: '世界观声明的限制有没有被绕过、用尽后有没有再用', enDesc: 'declared limits bypassed; used after exhaustion' },
  { key: 'style', zh: '文风', en: 'Prose style', zhDesc: '意象反复承担情绪、模板化写法', enDesc: 'recurring motifs and templated wording' },
  { key: 'content', zh: '跨章重复与状态', en: 'Repeated moves & status', zhDesc: '同一种反应/装置跨章复现、道具与状态漂移', enDesc: 'same reactions/staging across chapters; prop and status drift' },
  { key: 'sensory', zh: '感官通道', en: 'Sensory coverage', zhDesc: '感官描写有没有写错通道', enDesc: 'sensory channels used correctly' },
  { key: 'appearance', zh: '角色外观', en: 'Appearance vs cards', zhDesc: '正文描写与角色卡是否相悖', enDesc: 'prose against character cards' },
  { key: 'blueprintFacts', zh: '蓝图与前文', en: 'Blueprint vs prose', zhDesc: '蓝图把没发生的事说成一向如此', enDesc: 'blueprint claims habits the prose denies' },
  { key: 'evidence', zh: '物证形态', en: 'Evidence objects', zhDesc: '物证形态/成因/保管链是否成立', enDesc: 'evidence shape, cause and custody hold' },
  { key: 'handwriting', zh: '笔迹特征', en: 'Handwriting traits', zhDesc: '同一书写者有没有两套互斥特征', enDesc: 'one writer with two contradicting traits' },
  { key: 'blueprintInternal', zh: '蓝图自洽', en: 'Plan consistency', zhDesc: '同一章蓝图自己有没有两套值', enDesc: 'one chapter plan contradicting itself' },
  { key: 'lossRestatement', zh: '代价重述', en: 'Re-charged costs', zhDesc: '同一笔损失被再次宣告', enDesc: 'the same loss declared twice' },
  { key: 'deadline', zh: '期限结算', en: 'Deadline settlement', zhDesc: '宣告的期限有没有结算', enDesc: 'declared deadlines get settled' },
  { key: 'dateConflict', zh: '日期一致', en: 'Date consistency', zhDesc: '同一件事的日期跨章一致', enDesc: 'dates consistent across chapters' },
])

/** 与 chapter_creation_log 同一目录约定：项目数据目录下的设置文件。 */
export const DEEP_REVIEW_PREFS_REL = `.ai-novel/deep_review_preferences.json`

/** 持久化文件形状：只记**取消**的键（升级安全——未来新增维度默认勾选）。 */
export interface DeepReviewPreferences {
  version: 1
  disabled: DeepReviewDimensionKey[]
}

/** 全勾（缺省）。未知键（未来新增维度）也视为勾选——只记录**取消**的键，升级安全。 */
export function defaultDeepReviewSelection(): Record<DeepReviewDimensionKey, boolean> {
  return Object.fromEntries(DEEP_REVIEW_DIMENSIONS.map(dimension => [dimension.key, true])) as Record<DeepReviewDimensionKey, boolean>
}

/** 从持久化的「取消清单」还原勾选；没有文件/坏 JSON → 全勾。 */
export function deepReviewSelectionFromDisabled(disabled: unknown): Record<DeepReviewDimensionKey, boolean> {
  const selection = defaultDeepReviewSelection()
  if (Array.isArray(disabled)) {
    for (const key of disabled) {
      if (typeof key === 'string' && key in selection) selection[key as DeepReviewDimensionKey] = false
    }
  }
  return selection
}
