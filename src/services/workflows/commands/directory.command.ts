import { parsePlanningTargetUnits, planningTargetInstruction, assertPlanningActionRange, DEFAULT_PLANNING_ACTION_CHAPTERS } from '../../../shared/plot-outline-contract'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import type { BlueprintRangeCommitReceipt } from '../../../../electron/repositories/blueprint-repository'
import { composePromptSystemRole, resolvePromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import { type GenerationTask } from '../../generation/generation-harness'
import {
  createStructuredBatchExecutor,
  type StructuredBatchContract,
  type StructuredBatchFailure,
} from '../structured-batch-executor'
import {
  DirectoryWorkflowParams,
  ChapterBlueprint,
  commitDirectoryBlueprintRange,
  parseTextBlueprintsStrict,
  type DirectoryWorkflowProjectSnapshot,
} from '../directory-workflow'
import {
  blueprintSemanticGenerationContract,
  closingShotOf,
  stagingOf,
  validateBlueprintSemanticItem,
} from '../../../shared/blueprint-semantic-contract'
// 时点标注（issue #84）：读法与 #28 的收束、#32 的装置同源。
import { timeAnchorOf } from '../../../shared/chapter-time-anchor'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import { blueprintBoundedInput, outlineBatchSliceForBlueprint } from '../../../shared/blueprint-input'
import { promptLanguageText } from '../../prompt-language'
import { retryDirectoryCharacterSync } from '../directory-character-sync-recovery'
export {
  retryDirectoryCharacterSync,
  type DirectoryCharacterSyncReceipt,
} from '../directory-character-sync-recovery'
import {
  MAX_BLUEPRINT_ITEMS_PER_BATCH,
  MAX_BLUEPRINT_CHAPTERS_PER_TASK,
  planBlueprintGenerationCost,
} from '../blueprint-batch-policy'
import { readAuthoritativeNextChapter } from '../../authoritative-chapter-sequence'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import { normalizeChapterWordsTarget } from '../chapter-creation-parameters'
import { countDraftUnits, draftTargetUnitRange } from '../../../shared/draft-units'
import {
  blueprintKeyEventsBudget,
  blueprintKeyEventsProseText,
  countBlueprintKeyEventsUnits,
} from '../../../shared/blueprint-length'
import { HOOK_FORM_TEXT, hookFormOf } from '../../../shared/chapter-ending'
import {
  foreshadowingDueAt,
  parseForeshadowingCommitments,
  renderForeshadowingDue,
} from '../../../shared/foreshadowing-commitments'

type CreateDirectoryGenerationRuntime = NonNullable<WorkflowGenerationRuntimeDependencies['createRuntime']>

export interface GenerateDirectoryCommandDependencies {
  createRuntime?: CreateDirectoryGenerationRuntime
}

/** A failed run may still have one atomically adopted, fully validated prefix. */
export class DirectoryPartialCommitError extends Error {
  readonly code = 'DIRECTORY_PARTIAL_COMMIT'
  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt, readonly remainingRange: { startChapter: number; endChapter: number }, readonly generationFailure: StructuredBatchFailure, message: string) {
    super(message)
    this.name = 'DirectoryPartialCommitError'
  }
}

export class DirectoryPostCommitSyncError extends Error {
  readonly retryOperationId: string

  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt) {
    super(
      `章节蓝图已提交（第 ${commitReceipt.startChapter}–${commitReceipt.endChapter} 章），`
      + '但角色候选同步失败；可安全重试角色同步。',
    )
    this.name = 'DirectoryPostCommitSyncError'
    this.retryOperationId = commitReceipt.characterSyncOperation.operationId
  }
}

export class DirectoryPostCommitCancellationError extends Error {
  readonly retryOperationId: string

  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt) {
    super(
      `章节蓝图已提交（第 ${commitReceipt.startChapter}–${commitReceipt.endChapter} 章），`
      + '随后任务被取消；角色候选同步尚未确认完成。',
    )
    this.name = 'DirectoryPostCommitCancellationError'
    this.retryOperationId = commitReceipt.characterSyncOperation.operationId
  }
}

export class DirectoryCostLimitError extends Error {
  readonly code = 'DIRECTORY_TASK_COST_LIMIT' as const

  constructor(readonly chapterCount: number) {
    super(
      `本次目录范围共 ${chapterCount} 章，超过单次任务 ${MAX_BLUEPRINT_CHAPTERS_PER_TASK} 章的安全成本上限；`
      + `请拆成每段不超过 ${MAX_BLUEPRINT_CHAPTERS_PER_TASK} 章的范围分别生成。`,
    )
    this.name = 'DirectoryCostLimitError'
  }
}

export class DirectoryBlueprintContractError extends Error {
  constructor(
    readonly diagnostic: {
      code: string
      path: string
      field: string
      actualCharacters?: number
      maxCharacters?: number
    },
    readonly generationSummary?: string,
    uiLocale: CommandExecuteParams['context']['uiLocale'] = 'zh-CN',
  ) {
    const characterCounts = diagnostic.actualCharacters !== undefined
      && diagnostic.maxCharacters !== undefined
      ? ` actualCharacters=${diagnostic.actualCharacters} maxCharacters=${diagnostic.maxCharacters}`
      : ''
    super(
      uiLocale === 'en-US'
        ? `Structured contract diagnostic code=${diagnostic.code} path=${diagnostic.path} field=${diagnostic.field}${characterCounts}`
          + (generationSummary ? `; ${generationSummary}` : '')
        : `结构化合同诊断 code=${diagnostic.code} path=${diagnostic.path} field=${diagnostic.field}${characterCounts}`
          + (generationSummary ? `；${generationSummary}` : ''),
    )
    this.name = 'DirectoryBlueprintContractError'
  }
}

function directoryGenerationFailureSummary(
  attempts: readonly { purpose?: string; finishReason: string; budget: { requestedOutputTokens: number } }[],
): string {
  if (attempts.length === 0) return 'generationAttempts=none'
  return attempts.map((attempt, index) => (
    `attempt=${index + 1} purpose=${attempt.purpose ?? 'unknown'} `
    + `finishReason=${attempt.finishReason} requestedTokens=${attempt.budget.requestedOutputTokens}`
  )).join('; ')
}

// Match the existing protected structured-planning input envelope. Main still
// checks the actual model context before dispatch; no source facts are clipped.
const COMPACT_RECENT_BLUEPRINTS = 3

function blueprintCapacityGenerationContract(
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
  targetWords: number,
): string {
  const { minimum: lowerBound, maximum: upperBound } = draftTargetUnitRange(targetWords)
  // 长度口径排在容量合同**之前**：容量合同是这条提示的收尾（既有测试与调用口径都要求
  // 它落在最后一句），而长度口径属于「怎么写这个字段」，先说完再收束更自然。
  return `${blueprintKeyEventsLengthContract(writingLanguage, targetWords)}\n\n${promptLanguageText(
    writingLanguage,
    `【章节容量合同】\n每章正文目标约 ${targetWords} 字，可接受范围 ${lowerBound}–${upperBound} 字；据此控制情节点容量。作者指定事件与字数目标均为权威事实，不得删除、改写或擅自调整。合并 role、purpose、keyEvents、架构与前章列表中对同一事件的重复表述，只计一个语义事件；不擅自增加独立事件，也不为凑字数补事件。背景设定只作为约束和参考；除非作者指定事件明确要求，不得把全部背景逐项演成场景。JSON 输出合同不变；容量兼容时，keyEvents 只写能在上述范围内完整演绎的推进与结果。若语义去重后仍不兼容，保留作者指定事件，并在现有 keyEvents 字符串中简短指出“容量冲突：…”供作者调整；不新增字段、不代替作者取舍，也不写章节正文。`,
    `[Chapter capacity contract]\nTarget about ${targetWords} words per chapter, with an acceptable range of ${lowerBound}-${upperBound}; size the plot-point load accordingly. Author-specified events and the word target are authoritative facts: do not delete, rewrite, or adjust them. Merge duplicate descriptions of the same event across role, purpose, keyEvents, architecture, and the preceding chapter list, counting them as one semantic event; do not invent independent events or add events to fill space. Background facts are constraints and references, not a requirement to dramatize every fact as a scene unless an author-specified event requires it. Keep the JSON output contract unchanged. When capacity is compatible, keyEvents should state only the progression and outcome that can be fully dramatized within this range. If semantic deduplication still leaves an incompatible load, preserve the author-specified events and briefly state "Capacity conflict: ..." in the existing keyEvents string for the author to adjust; add no field, make no choice for the author, and do not write chapter prose.`,
  )}`
}

/**
 * 蓝图「冲突与转折」（keyEvents）的长度口径（issue #64）。
 *
 * 实测这本书写 25 章后，keyEvents 从均值 253 字涨到 429 字（第 25 章 510 字，
 * 而同章正文只有 630 汉字）——蓝图里已经排好台词与动作顺序，起草只剩扩写，
 * 「蓝图 → 正文」这一层就没了。批量路径此前只有 JSON 形状注释里的「100字左右」，
 * 单章模板又写「100-150 字」，两条口径还不一致。
 *
 * 这里只做**生成侧目标**（与单章模板同一口径），不设落库硬闸：不可变合同里有
 * 「作者指定事件为权威、不得删除」的条款，一个硬上限会把它推翻，也会让长事件的
 * 章节反复被拒稿。真正的长度上限仍然由合同层保留为空（见
 * BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST），长度问题走可见性提示（写前预检）。
 */
function blueprintKeyEventsLengthContract(
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
  targetWords: number,
): string {
  const budget = blueprintKeyEventsBudget(targetWords)
  return promptLanguageText(
    writingLanguage,
    `【蓝图长度口径】每章 keyEvents（冲突与转折）控制在约 ${budget.target} 字以内（上限 ${budget.max} 字），信息密度必须极高：写清谁做了什么、结果如何、代价是什么，不写台词原文、不写动作顺序、不写感官细节——那些是正文的活。作者明确指定的事件不得删除；确实放不下时按语义合并同一事件，不要另起小节，也不要在字段里写解释。costsAndTurns、foreshadowing 同样各控制在两句以内。`,
    `[Blueprint length] Keep each chapter's keyEvents (conflict and turn) within about ${budget.target} characters (hard ceiling ${budget.max}) and make every clause carry information: who acts, what the outcome is, what it costs. Do not transcribe dialogue, sequence of actions, or sensory detail — that is the prose's job. Never delete an author-specified event; if space is tight, merge descriptions of the same event rather than adding a new beat, and never write an explanation inside the field. Keep costsAndTurns and foreshadowing to at most two sentences each.`,
  )
}

/**
 * 把「上一章的蓝图」按长度口径截断后再进上下文（issue #64）。
 *
 * 只用于 references/有界事实里的历史蓝图，不碰任何落库内容。两个标注
 * （`【收束：…】`/`【装置：…】`）不进截断计数，但必须原样留在尾部——下游读它们
 * 做轮换判断（issue #28/#32），丢了下一次生成就会以为上一章「未标注」。
 * 截断点是句末，尽量不切在句子中间。
 */
function clipBlueprintKeyEventsForContext(keyEvents: string, targetWordsPerChapter: number): string {
  const budget = blueprintKeyEventsBudget(targetWordsPerChapter)
  const full = String(keyEvents ?? '')
  if (countBlueprintKeyEventsUnits(full) <= budget.max) return full
  const prose = blueprintKeyEventsProseText(full)
  const labels = (String(full).match(/【\s*(?:收束|装置)\s*[:：][^】]{0,60}】/gu) ?? []).join('')
  const parts = prose.split(/(?<=[。！？；])/u).filter(part => part.trim())
  let kept = ''
  for (const part of parts) {
    if (countDraftUnits(kept + part) > budget.max) break
    kept += part
  }
  const clipped = kept.trim() || Array.from(prose).slice(0, budget.max).join('')
  return labels ? `${clipped}${labels}` : clipped
}

function buildCompactBlueprintTask(input: {
  chapterNumber: number
  targetUnits: number
  architecture: string
  previous: readonly ChapterBlueprint[]
  totalChapters: number
  wordsPerChapter: number
  genre: string
  globalGuidance: string
  pacingGuidance: string
  systemRole: string
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>
  diagnostic?: { code: string; path: string; field: string }
}): GenerationTask {
  const facts = {
    targetChapterNumber: input.chapterNumber,
    totalChapters: input.totalChapters,
    targetWordsPerChapter: input.wordsPerChapter,
    genre: input.genre,
    architecture: input.architecture,
    recentBlueprints: input.previous.slice(-COMPACT_RECENT_BLUEPRINTS).map(chapter => ({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      // 上一章的规划文本按长度口径截断（issue #64）：实测最近 3 章的 keyEvents 全文
      // （后段每章 400–500 字）会整段进入下一次生成，成本逐章累积；而「上一章发生了什么」
      // 由标题、钩子、代价、收束、装置这几个短字段已经表达得足够。标注保留（下游要读）。
      keyEvents: clipBlueprintKeyEventsForContext(chapter.keyEvents, input.wordsPerChapter),
      // 上一章付过的代价也要给模型看：代价桥段跨章照抄的根因就是它不可见（issue #14）。
      costs: chapter.costsAndTurns,
      suspenseHook: chapter.suspenseHook,
      // 最近落幅同看：收束方式跨章同构的根因同样是不可见（issue #28）。
      closingShot: closingShotOf(chapter.keyEvents) || undefined,
      // 场景装置同看：同一套「地点＋起手动作」反复搭的根因也是不可见（issue #32）。
      staging: stagingOf(chapter.keyEvents) || undefined,
      // 时点同看（issue #84）：上一章发生在什么时候不给模型看，它就没有依据判断本章
      // 该不该跨日——而链路上没有别处产出时点，起草契约的「同一天紧接」默认会永远生效。
      timeAnchor: timeAnchorOf(chapter.keyEvents) || undefined,
      // 钩子形态同看（issue #66）：最近几章的钩子全写成条件/警告句时，正文只能照着
      // 收成通牒——这个分布不进去，模型就没有依据去轮换。
      hookForm: chapter.suspenseHook
        ? HOOK_FORM_TEXT[hookFormOf(chapter.suspenseHook)][input.writingLanguage === 'en-US' ? 'enUS' : 'zhCN']
        : undefined,
    })),
    globalGuidance: input.globalGuidance,
    pacingGuidance: input.pacingGuidance,
    // 早先章节点名本章的承诺（issue #68）：原来只带「最近 3 章」，于是写在第 13 章
    // 的「与第 22 夜接榫」永远送不到第 22 章。这里按**承诺**取数，不只是按位置。
    foreshadowingDue: foreshadowingDueAt(
      parseForeshadowingCommitments(input.previous),
      input.chapterNumber,
      { alreadyInContextChapters: COMPACT_RECENT_BLUEPRINTS },
    ).map(commitment => ({ plantsAt: commitment.plantsAt, text: commitment.text })),
  }
  const prompt = [
    promptLanguageText(input.writingLanguage, '仅根据下列有界事实生成该章完整蓝图。', 'Build the complete chapter blueprint from only the bounded facts below.'),
    promptLanguageText(input.writingLanguage, '【有界事实】', '[Bounded facts]'),
    JSON.stringify(facts),
    promptLanguageText(input.writingLanguage, '【输出合同】', '[Output contract]'),
    blueprintSemanticGenerationContract(input.writingLanguage),
    promptLanguageText(
      input.writingLanguage,
      `【精确 JSON 形状】{"blueprints":[{"chapterNumber":${input.chapterNumber},"title":"短标题","role":"简短结构标签","purpose":"一句简洁陈述","keyEvents":"简洁事件摘要","characters":["完整姓名"],"relationships":[],"suspenseHook":"一句简洁陈述"}]}`,
      `[Exact JSON shape] {"blueprints":[{"chapterNumber":${input.chapterNumber},"title":"short title","role":"short structural label","purpose":"one concise sentence","keyEvents":"concise event summary","characters":["full name"],"relationships":[],"suspenseHook":"one concise sentence"}]}`,
    ),
    ...(input.diagnostic
      ? [promptLanguageText(
          input.writingLanguage,
          `【上次合同违规】code=${input.diagnostic.code} path=${input.diagnostic.path} field=${input.diagnostic.field}。丢弃上次输出，按上述合同完整重建。`,
          `[Previous contract violation] code=${input.diagnostic.code} path=${input.diagnostic.path} field=${input.diagnostic.field}. Discard the previous output and rebuild the complete item under the contract above.`,
        )]
      : []),
    promptLanguageText(input.writingLanguage, `必须且只能返回 chapterNumber=${input.chapterNumber} 的一项。`, `Return exactly one item whose chapterNumber is ${input.chapterNumber}.`),

    // 早先章节点名本章的承诺（issue #68）：写在 facts 里是给模型看的结构化数据，
    // 这里再单独成段，让它不会被 JSON 的噪声盖住。
    renderForeshadowingDue({
      commitments: foreshadowingDueAt(
        parseForeshadowingCommitments(input.previous),
        input.chapterNumber,
        { alreadyInContextChapters: COMPACT_RECENT_BLUEPRINTS },
      ),
      targetChapter: input.chapterNumber,
      language: input.writingLanguage === 'en-US' ? 'en-US' : 'zh-CN',
    }),

    blueprintCapacityGenerationContract(input.writingLanguage, input.wordsPerChapter),
  ].join('\n')
  const systemRole = composePromptSystemRole({
    systemRole: input.systemRole
      || promptLanguageText(input.writingLanguage, '你是一位经验丰富的章节架构师。', 'You are an experienced chapter architect.'),
  }, input.writingLanguage)
  return {
    purpose: `chapter-blueprint-directory:compact-single:chapter-${input.chapterNumber}`,
    output: 'structured-data',
    messages: [
      { role: 'system', content: `${systemRole}\n\n${planningTargetInstruction('blueprint', input.targetUnits, input.writingLanguage)}` },
      { role: 'user', content: prompt },
    ],

  }
}

function observeWorkflowCancellation(context: CommandExecuteParams['context']): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  if (context.cancelled) controller.abort()
  const interval = setInterval(() => {
    if (context.cancelled) controller.abort()
  }, 25)
  return {
    signal: controller.signal,
    dispose: () => clearInterval(interval),
  }
}

export class GenerateDirectoryCommand extends BaseWorkflowCommand<ChapterBlueprint[]> {

  constructor(
    private params: DirectoryWorkflowParams,
    private projectSnapshot: DirectoryWorkflowProjectSnapshot,
    dependencies: GenerateDirectoryCommandDependencies = {},
  ) {
    super(dependencies.createRuntime ? { createRuntime: dependencies.createRuntime } : undefined)
  }

  async execute({ context, callbacks, step }: CommandExecuteParams): Promise<ChapterBlueprint[]> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const architecture = context.data.architecture as string
    const existingBlueprints = (context.data.existingBlueprints || []) as ChapterBlueprint[]
    const { expectedProjectPath, novelConfig } = this.projectSnapshot
    const modelFacts = localizeNovelConfigFacts(novelConfig, writingLanguage)
    const totalChapters = novelConfig.totalChapters
    const wordsPerChapter = normalizeChapterWordsTarget(novelConfig.wordsPerChapter)
    const authoritativeNextChapter = await readAuthoritativeNextChapter(
      projectSession,
      writingLanguage,
    )
    let startChapter = 1
    if (!context.data.directoryResumeHandle && this.params.count !== undefined
      && (!Number.isSafeInteger(this.params.count) || this.params.count < 1)) throw new Error('GENERATION_PLANNING_RANGE_INVALID')
    if (!context.data.directoryResumeHandle && this.params.count !== undefined)
      assertPlanningActionRange({ from: 1, to: this.params.count })
    const targetUnits = parsePlanningTargetUnits(this.params.targetUnits)
    let endChapter = Math.min(totalChapters, DEFAULT_PLANNING_ACTION_CHAPTERS)
    if (this.params.mode === 'append') {
      startChapter = this.params.startChapter || authoritativeNextChapter
      endChapter = Math.min(totalChapters, startChapter + DEFAULT_PLANNING_ACTION_CHAPTERS - 1)
      if (this.params.count && this.params.count > 0) {
        endChapter = Math.min(totalChapters, startChapter + this.params.count - 1)
      }
    } else if (this.params.count && this.params.count > 0) {
      endChapter = Math.min(this.params.count, totalChapters)
    }
    if (
      !Number.isInteger(startChapter)
      || !Number.isInteger(endChapter)
      || startChapter < 1
      || startChapter > totalChapters
      || endChapter < startChapter
    ) {
      throw new Error(`章节范围无效：第 ${startChapter}–${endChapter} 章`)
    }

    if (!context.data.directoryResumeHandle) assertPlanningActionRange({ from: startChapter, to: endChapter })
    this.assertNotCancelled(context)
    callbacks.log(workflowUiText(
      context,
      `生成第 ${startChapter}–${endChapter} 章蓝图...`,
      `Generating blueprints for chapters ${startChapter}–${endChapter}...`,
    ))
    const chapterCount = endChapter - startChapter + 1
    const costPlan = planBlueprintGenerationCost(chapterCount)
    const chapterNumbers = Array.from(
      { length: chapterCount },
      (_, index) => startChapter + index,
    )
    const template = await resolvePromptTemplate('chapter_blueprint_chunk', projectSession, writingLanguage)
    if (!template) throw new Error('模板丢失')

    let activeRange = { startChapter, endChapter }
    const compactTaskFor = (
      item: number,
      validatedPrefix: readonly ChapterBlueprint[],
      diagnostic?: { code: string; path: string; field: string },
    ) => (
      buildCompactBlueprintTask({
        chapterNumber: item,
        targetUnits,
        architecture,
        previous: [...existingBlueprints, ...validatedPrefix],
        totalChapters,
        wordsPerChapter,
        genre: modelFacts.genre,
        globalGuidance: novelConfig.globalGuidance || '',
        pacingGuidance: (context.data.pacingGuidance as string) || '',
        systemRole: template.systemRole || promptLanguageText(writingLanguage, '你是一位经验丰富的小说架构师。', 'You are an experienced fiction architect.'),
        writingLanguage,
        diagnostic,
      })
    )
    const contract: StructuredBatchContract<number, ChapterBlueprint> = {
      buildTask: ({ items, validatedPrefix }) => {
        const batchStart = items[0]
        const batchEnd = items.at(-1)
        if (batchStart === undefined || batchEnd === undefined) {
          throw new Error('章节蓝图批次不能为空')
        }
        activeRange = { startChapter: batchStart, endChapter: batchEnd }
        callbacks.log(workflowUiText(
          context,
          `  正在生成第 ${batchStart}–${batchEnd} 章...`,
          `  Generating chapters ${batchStart}–${batchEnd}...`,
        ))
        callbacks.setProgress(Math.round(
          ((batchStart - startChapter) / chapterNumbers.length) * 90,
        ))
        const previous = [...existingBlueprints, ...validatedPrefix]
        // 上一章的章末钩子必须进这个列表（issue #20）：批块模板只有泛的「保持连贯」，
        // 若连钩子原文都不给，模型无从回应；单章路径的 recentBlueprints 早带了 suspenseHook，
        // 批量路径此前只带 keyEvents，两边不一致。收束方式同理（issue #28）。
        // 这里按长度口径截断每章（issue #64）：最近 100 章的 keyEvents 全文会整段进上下文，
        // 后段每章 400–500 字时仅这一项就是数万字，成本逐章累积。
        const chapterList = previous.slice(-100)
          .map(chapter => promptLanguageText(
            writingLanguage,
            `第${chapter.chapterNumber}章 ${chapter.title}：${clipBlueprintKeyEventsForContext(chapter.keyEvents, wordsPerChapter)}${chapter.suspenseHook ? `（章末钩子：${chapter.suspenseHook}）` : ''}`,
            `Chapter ${chapter.chapterNumber} — ${chapter.title}: ${clipBlueprintKeyEventsForContext(chapter.keyEvents, wordsPerChapter)}${chapter.suspenseHook ? ` (closing hook: ${chapter.suspenseHook})` : ''}`,
          ))
          .join('\n')
        // 最近 3 章的落幅单独列一段：收束方式轮换要求模型先看清刚用过什么（issue #28）。
        // 钩子的**语用形态**一并列出（issue #66）：后段 5 章的 suspenseHook 全写成
        // 「条件＋后果」两句，正文只能跟着收成通牒——模型看不见这个分布就无从轮换。
        const recentClosings = previous.slice(-COMPACT_RECENT_BLUEPRINTS)
          .map(chapter => promptLanguageText(
            writingLanguage,
            `第${chapter.chapterNumber}章收束：${closingShotOf(chapter.keyEvents) || '（未标注）'}；钩子形态：${HOOK_FORM_TEXT[hookFormOf(chapter.suspenseHook)].zhCN}`,
            `Chapter ${chapter.chapterNumber} closing shot: ${closingShotOf(chapter.keyEvents) || '(unlabelled)'}; hook form: ${HOOK_FORM_TEXT[hookFormOf(chapter.suspenseHook)].enUS}`,
          ))
          .join('\n')
        const prompt = new DirectoryPromptBuilder(template, writingLanguage)
          .withNovelArchitecture(blueprintBoundedInput({ coreOutline: (context.data.coreOutline as string) || '', 
            premise: (context.data.premise as string) || '', charactersArch: (context.data.charactersArch as string) || '', 
            worldbuilding: (context.data.worldbuilding as string) || '', 
            batchOutline: outlineBatchSliceForBlueprint((context.data.synopsisFull as string) || '', batchStart, batchEnd), 
            arcDirective: (context.data.arcDirective as string) || '', language: writingLanguage }))
          .withChapterList(
            (chapterList || promptLanguageText(writingLanguage, '（首批生成，尚无前置章节）', '(first batch; no preceding chapters)'))
            + (recentClosings ? `\n\n${promptLanguageText(writingLanguage, '【最近几章的收束方式与钩子形态（本章都不要重复；连续三章不得都以条件/警告句收尾）】', '[Recent closing shots and hook forms (repeat neither; never close three chapters in a row on a conditional or threatening line)]')}\n${recentClosings}` : ''),
          )
          .withNumberOfChapters(totalChapters)
          .withN(batchStart)
          .withM(batchEnd)
          .withChapterCount(batchEnd - batchStart + 1)
          .withGlobalGuidance(novelConfig.globalGuidance || '')
          .withGenre(modelFacts.genre)
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()
          + `\n\n${blueprintSemanticGenerationContract(writingLanguage)}`
          + `\n\n${blueprintCapacityGenerationContract(writingLanguage, wordsPerChapter)}`
          // 早先章节点名本批各章的承诺（issue #68）：这一批可能覆盖多章，逐章渲染。
          // 取数按**承诺**而非「最近 N 章」——写在十几章前的「留待第 15 章揭开」
          // 必须在这一批第 15 章生成时出现在上下文里。
          + (() => {
            const all = parseForeshadowingCommitments(previous)
            const blocks = chapterNumbers
              .map(chapterNumber => renderForeshadowingDue({
                commitments: foreshadowingDueAt(all, chapterNumber, { alreadyInContextChapters: COMPACT_RECENT_BLUEPRINTS }),
                targetChapter: chapterNumber,
                language: writingLanguage === 'en-US' ? 'en-US' : 'zh-CN',
              }))
              .filter(Boolean)
            return blocks.length > 0 ? `\n\n${blocks.join('\n\n')}` : ''
          })()

        return {
          purpose: 'chapter-blueprint-directory',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: composePromptSystemRole({
                systemRole: template.systemRole || promptLanguageText(writingLanguage, '你是一位经验丰富的小说架构师。', 'You are an experienced fiction architect.'),
              }, writingLanguage) + `\n\n${planningTargetInstruction('blueprint', targetUnits, writingLanguage)}`,
            },
            { role: 'user', content: prompt },
          ],
        }
      },
      buildCompactSingleTask: ({ item, validatedPrefix, diagnostic }) => (
        compactTaskFor(item, validatedPrefix, diagnostic)
      ),
      inputKey: chapterNumber => chapterNumber,
      outputKey: blueprint => blueprint.chapterNumber,
      decode: content => parseTextBlueprintsStrict(
        content,
        activeRange.startChapter,
        activeRange.endChapter,
        // 批内标题查重（existingTitles 默认空 → 只查本批同名）；跨章同名由合同与模板约束。
        'model',
      ),
      validateItem: validateBlueprintSemanticItem,
      syntaxRepairContract: ({ items }) => (
        `${blueprintSemanticGenerationContract(writingLanguage)}\n`
        + promptLanguageText(
          writingLanguage,
          `本次必须且只能完整返回以下 chapterNumber：${items.join('、')}。`,
          `Return complete items for exactly these chapterNumber values: ${items.join(', ')}.`,
        )
      ),
    }

    return this.executeWithGenerationRuntime('structured', { context, callbacks, step }, async () => {
    const cancellation = observeWorkflowCancellation(context)
    try {
      const batchResult = await (async () => {
        const session = this.requireGenerationExecution().session
        const planningSession = injectWritingSkillIntoSession(session, context, 'planning')
        if (context.writingSkills?.planning) {
          callbacks.log(workflowUiText(
            context,
            `本次 planning 阶段使用已冻结写作 Skill：${context.writingSkills.planning.name}`,
            `Using the workflow-start-frozen writing skill for planning: ${context.writingSkills.planning.name}`,
          ))
        }
        const executor = createStructuredBatchExecutor({
          contract,
          session: planningSession,
          writingLanguage,
          onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
        })
        return executor.execute({
          items: chapterNumbers,
          limits: {
            maxBatchItems: MAX_BLUEPRINT_ITEMS_PER_BATCH,
            maxCompactSingleFallbacks: costPlan.maxCompactSingleFallbacks,
          },
          signal: cancellation.signal,
        })
      })()
      if (!batchResult.ok) {
        this.assertNotCancelled(context)
        const prefix = [...batchResult.validatedItems]
        if (prefix.length) {
          if (prefix.some((item, index) => item.chapterNumber !== startChapter + index)) throw new Error('DIRECTORY_VALIDATED_PREFIX_NOT_CONTIGUOUS')
          const prefixEnd = startChapter + prefix.length - 1
          const receipt = await commitDirectoryBlueprintRange(prefix, expectedProjectPath,
            { mode: 'replace-range', startChapter, endChapter: prefixEnd },
            `directory-${context.runId}-${startChapter}-${prefixEnd}-partial`, context.projectSession, context.mainGenerationRunHandle, { startChapter, endChapter })
          context.data.blueprintCommitReceipt = receipt
          context.data.newBlueprints = [...receipt.snapshot]
          context.data.remainingBlueprintRange = { startChapter: prefixEnd + 1, endChapter }
          if (context.cancelled) throw new DirectoryPostCommitCancellationError(receipt)
          try {
            await retryDirectoryCharacterSync(receipt.characterSyncOperation.operationId, expectedProjectPath, context.projectSession)
          } catch { throw new DirectoryPostCommitSyncError(receipt) }
          throw new DirectoryPartialCommitError(receipt, { startChapter: prefixEnd + 1, endChapter }, batchResult.failure, workflowUiText(context,
            `已保存第 ${startChapter}–${prefixEnd} 章完整蓝图；第 ${prefixEnd + 1}–${endChapter} 章未完成。原运行的候选与失败原因已保留。`,
            `Saved complete blueprints for chapters ${startChapter}–${prefixEnd}; chapters ${prefixEnd + 1}–${endChapter} remain incomplete. The original run retains its candidates and failure reason.`,
          ))
        }
        const generationSummary = directoryGenerationFailureSummary(batchResult.receipt.attempts)
        callbacks.log(workflowUiText(
          context,
          `蓝图生成失败收据：${generationSummary}`,
          `Blueprint generation failure receipt: ${generationSummary}`,
        ))
        if (batchResult.failure.diagnostic) {
          throw new DirectoryBlueprintContractError(
            batchResult.failure.diagnostic,
            generationSummary,
            context.uiLocale,
          )
        }
        throw new Error(context.uiLocale === 'en-US'
          ? `Blueprint generation failed: code=${batchResult.failure.code} reason=${batchResult.failure.reason ?? 'unknown'}; ${generationSummary}`
          : `${batchResult.failure.message}；${generationSummary}`)
      }

      this.assertNotCancelled(context)
      const generatedBlueprints = [...batchResult.items]
      const commitReceipt = await commitDirectoryBlueprintRange(
        generatedBlueprints,
        expectedProjectPath,
        {
          mode: 'replace-range',
          startChapter,
          endChapter,
        },
        `directory-${context.runId}-${startChapter}-${endChapter}`,
        context.projectSession,
        context.mainGenerationRunHandle,
        { startChapter, endChapter },
      )
      const newBlueprints = [...commitReceipt.snapshot]
      context.data.blueprintCommitReceipt = commitReceipt

      if (context.cancelled) {
        throw new DirectoryPostCommitCancellationError(commitReceipt)
      }
      try {
        const syncReceipt = await retryDirectoryCharacterSync(
          commitReceipt.characterSyncOperation.operationId,
          expectedProjectPath,
          context.projectSession,
        )
        context.data.blueprintCharacterSyncReceipt = syncReceipt
      } catch {
        throw new DirectoryPostCommitSyncError(commitReceipt)
      }

      context.data.newBlueprints = newBlueprints
      context.data.existingBlueprints = existingBlueprints
      callbacks.log(workflowUiText(
        context,
        `共生成 ${newBlueprints.length} 章蓝图`,
        `Generated ${newBlueprints.length} chapter blueprint${newBlueprints.length === 1 ? '' : 's'}`,
      ))
      return newBlueprints
    } finally {
      cancellation.dispose()
    }
    }, {
      continueDirectoryOperationId: this.params.continueDirectoryOperationId,
      resumeHandle: context.data.directoryResumeHandle as MainGenerationRunHandle | undefined,
      restartHandle: this.params.restartFrom,
      selectedBlueprintChapterNumbers: [...new Set([...chapterNumbers, ...existingBlueprints.map(item => item.chapterNumber)])],
      operation: 'chapter-blueprint-directory', promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data',
      authorInputs: [{ id: 'planning:target-units', text: String(targetUnits) }, { id: 'directory:pacing-guidance', text: typeof context.data.pacingGuidance === 'string' ? context.data.pacingGuidance : '' }, { id: 'directory:author-config', text: JSON.stringify(novelConfig) }, { id: 'directory:requested-range', text: JSON.stringify({ mode: this.params.mode, startChapter, endChapter }) }],
    })
  }
}
