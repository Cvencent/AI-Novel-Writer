/**
 * 连续大纲生成驱动（Continuous Outline Runner）
 *
 * 作用：把「一批 5/10 章」的手动续批，变成「一次点击，一直生成到全书完成」，
 * 并提供可视化进度、暂停/继续、失败自动重试。
 *
 * 设计要点：
 * - 复用既有单批工作流（launchCreativeWorkflow + generate_architecture），
 *   不新增主进程契约，因此对现有项目数据与校验规则零影响；
 * - 每一批结束（成功或失败）后重新读取真实进度（DB 大纲 + 检查点），
 *   以「实际已覆盖章数」为准推进，避免乐观计数导致跳章或重复；
 * - 连续失败达上限即安全停止（进度不丢，可稍后继续）；
 * - 全程只在渲染进程编排，取消即调用既有 cancelWorkflow。
 */

import { ipc } from '../ipc-client'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { launchCreativeWorkflow } from './creative-workflow-launcher'
import { outlineProgress, type OutlineProgress } from '../../shared/plot-outline-checkpoint'
import { parseOutlineChapters } from '../../shared/outline-retrieval-context'
import { PLANNING_ACTION_CHAPTER_LIMIT } from '../../shared/plot-outline-contract'
import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../../components/project-session-gate'

export type ContinuousOutlineStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface ContinuousOutlineProgress {
  status: ContinuousOutlineStatus
  totalChapters: number
  coveredChapters: number
  percent: number
  batchesCompleted: number
  consecutiveFailures: number
  currentBatch: { from: number; to: number } | null
  batchPercent: number
  message: string
  remainingChapters: number
  startedAt: string | null
  updatedAt: string | null
}

const MAX_CONSECUTIVE_FAILURES = 3
const IDLE_PROGRESS: ContinuousOutlineProgress = Object.freeze({
  status: 'idle', totalChapters: 0, coveredChapters: 0, percent: 0,
  batchesCompleted: 0, consecutiveFailures: 0, currentBatch: null, batchPercent: 0,
  message: '', remainingChapters: 0, startedAt: null, updatedAt: null,
})

type Listener = (progress: ContinuousOutlineProgress) => void

let progress: ContinuousOutlineProgress = { ...IDLE_PROGRESS }
const listeners = new Set<Listener>()
let loopToken = 0
let pauseRequested = false
let cancelRequested = false

function emit(next: Partial<ContinuousOutlineProgress>): void {
  progress = { ...progress, ...next, updatedAt: new Date().toISOString() }
  for (const listener of listeners) listener(progress)
}

export function subscribeContinuousOutline(listener: Listener): () => void {
  listeners.add(listener)
  listener(progress)
  return () => { listeners.delete(listener) }
}

export function getContinuousOutlineProgress(): ContinuousOutlineProgress {
  return progress
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
interface ProjectSnapshotInfo {
  session: ProjectSessionContext
  totalChapters: number
  coveredChapters: number
  progressKind: OutlineProgress['kind']
  outlineText: string
}

const OUTLINE_INDEX_BATCH_CHAPTERS = 20
const OUTLINE_INDEX_SUFFIX = '细纲.md'

function outlineIndexFileName(from: number, to: number): string {
  return `第${from}–${to}章 ${OUTLINE_INDEX_SUFFIX}`
}

/**
 * 把已生成的大纲补进项目检索库。每 20 章一份文档；同名文档由知识库
 * 原子替换，因此重复启动不会无限累积旧副本。
 */
async function ensureOutlineIndexed(
  session: ProjectSessionContext,
  outlineText: string,
  onProgress: (message: string) => void,
): Promise<void> {
  const chapters = parseOutlineChapters(outlineText)
  if (chapters.length === 0) return
  const listed = await ipc.invokeWithProjectSession(
    session,
    'kb:list-documents',
    session.projectPath,
  ).catch(() => null)
  const documents = Array.isArray(listed) ? listed : []
  const existing = new Set(documents.map(document => document.fileName))
  let imported = 0
  const groups: Array<typeof chapters> = []
  for (let index = 0; index < chapters.length; index += OUTLINE_INDEX_BATCH_CHAPTERS) {
    groups.push(chapters.slice(index, index + OUTLINE_INDEX_BATCH_CHAPTERS))
  }
  for (const [index, group] of groups.entries()) {
    const first = group[0]!.chapter
    const last = group[group.length - 1]!.chapter
    const fileName = outlineIndexFileName(first, last)
    if (existing.has(fileName)) continue
    onProgress(`正在补建大纲检索索引：${index + 1} / ${groups.length}（第 ${first}–${last} 章）…`)
    const content = group.map(entry => `## 第${entry.chapter}章：${entry.title}\n\n${entry.body.trim()}`).join('\n\n')
    const result = await ipc.invokeWithProjectSession(
      session,
      'kb:import-text',
      content,
      fileName,
      session.projectPath,
    ).catch(() => null)
    if (result?.success) {
      imported += 1
      existing.add(fileName)
    }
  }
  if (imported > 0) onProgress(`大纲检索索引已补齐：新增 ${imported} 份、共 ${chapters.length} 章。`)
}

/** 读取项目真实进度：以 DB 大纲与检查点为准。 */
async function readProjectProgress(session: ProjectSessionContext): Promise<ProjectSnapshotInfo | null> {
  const { projectPath } = session
  const [core, partial] = await Promise.all([
    ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath).catch(() => null),
    ipc.invokeWithProjectSession(session, 'fs:read-json', projectPath + '/' + CANONICAL_PROJECT_DIRECTORY + '/partial_arch.json', projectPath)
      .catch(() => null),
  ])
  if (!core) return null
  const checkpoint = partial && partial.success === true ? (partial as { data?: unknown }).data : undefined
  const language = core.writingLanguage === 'en-US' ? 'en-US' : 'zh-CN'
  const totalChapters = Number(core.totalChapters) || 0
  const prog = outlineProgress(core.synopsis ?? '', checkpoint, language, totalChapters)
  const checkpointCovered = Number((checkpoint as Record<string, unknown> | undefined)?.synopsis_covered_to) || 0
  const coveredChapters = prog.kind === 'complete'
    ? totalChapters
    : prog.kind === 'partial'
      ? prog.coveredTo
      : checkpointCovered
  return { session, totalChapters, coveredChapters, progressKind: prog.kind, outlineText: core.synopsis ?? '' }
}

/** 等待某一批工作流结束；期间把本批章级进度回传给调用方。 */
async function waitForRun(
  runId: string,
  onTick: (percent: number) => void,
  token: number,
): Promise<{ ok: boolean; error?: string }> {
  for (;;) {
    if (token !== loopToken) return { ok: false, error: 'cancelled' }
    const state = useWorkflowStore.getState()
    const run: WorkflowRun | undefined = state.history.find(candidate => candidate.id === runId)
      ?? state.activeRuns.find(candidate => candidate.id === runId)
    if (run) {
      const step = run.steps[run.currentStepIndex] ?? run.steps[0]
      onTick(step?.progress ?? 0)
      if (run.status === 'completed') return { ok: true }
      if (run.status === 'failed' || run.status === 'cancelling') return { ok: false, error: run.error ?? run.status }
    }
    await sleep(1200)
  }
}
/** 启动连续生成。返回时循环已在后台运行；用 subscribeContinuousOutline 观察进度。 */
export function startContinuousOutline(targetUnits?: number): void {
  const project = useProjectStore.getState().currentProject
  const session = project ? captureProjectSession(project) : null
  if (!session) {
    emit({ status: 'failed', message: '找不到当前项目会话，无法开始连续生成。' })
    return
  }
  if (progress.status === 'running') return
  loopToken += 1
  const token = loopToken
  pauseRequested = false
  cancelRequested = false
  void runLoop(session, token, targetUnits)
}

export function pauseContinuousOutline(): void {
  if (progress.status !== 'running') return
  pauseRequested = true
  emit({ message: '将在当前批次完成后暂停…' })
}

export function resumeContinuousOutline(targetUnits?: number): void {
  if (progress.status === 'paused' || progress.status === 'failed') startContinuousOutline(targetUnits)
}

export function cancelContinuousOutline(): void {
  cancelRequested = true
  loopToken += 1
  const runs = useWorkflowStore.getState().activeRuns.filter(run => run.type === 'architecture_generation')
  for (const run of runs) useWorkflowStore.getState().cancelWorkflow(run.id)
  emit({ status: 'cancelled', currentBatch: null, batchPercent: 0, message: '已停止连续生成；已完成的大纲已保存。' })
}
async function runLoop(session: ProjectSessionContext, token: number, targetUnits?: number): Promise<void> {
  const text = useLocaleStore.getState().text
  let consecutiveFailures = 0
  let batchesCompleted = 0
  let lastRange = ''
  let sameRangeAttempts = 0
  const startedAt = new Date().toISOString()

  const initial = await readProjectProgress(session)
  if (!initial) {
    emit({ status: 'failed', message: '读取项目进度失败，无法开始连续生成。' })
    return
  }
  emit({
    status: 'running', startedAt,
    totalChapters: initial.totalChapters,
    coveredChapters: initial.coveredChapters,
    percent: initial.totalChapters > 0 ? Math.floor((initial.coveredChapters / initial.totalChapters) * 100) : 0,
    remainingChapters: Math.max(0, initial.totalChapters - initial.coveredChapters),
    batchesCompleted: 0, consecutiveFailures: 0, batchPercent: 0,
    message: text('开始连续生成细纲…', 'Starting continuous plot-outline generation…'),
  })
  await ensureOutlineIndexed(initial.session, initial.outlineText, message => emit({ message })).catch(() => {
    emit({ message: text('已有大纲补建检索索引失败；会继续生成，稍后可在知识库页重试。', 'Existing outlines could not be indexed; generation will continue and indexing can be retried later.') })
  })

  for (;;) {
    if (token !== loopToken || cancelRequested) return
    if (!isProjectSessionCurrent(session) || !isProjectSessionPath(session, session.projectPath)) {
      emit({ status: 'failed', message: '项目已切换，连续生成已停止。' })
      return
    }

    const current = await readProjectProgress(session)
    if (!current) {
      emit({ status: 'failed', message: '读取项目进度失败，连续生成已停止。' })
      return
    }
    const total = current.totalChapters
    const covered = current.coveredChapters

    if (total <= 0) {
      emit({ status: 'failed', message: '全书总章数无效，无法连续生成。' })
      return
    }
    if (covered >= total) {
      emit({
        status: 'completed', totalChapters: total, coveredChapters: total, percent: 100,
        remainingChapters: 0, currentBatch: null, batchPercent: 0, batchesCompleted,
        message: text('全书大纲已全部生成完成。', 'All chapters of the outline are complete.'),
      })
      return
    }

    const from = Math.max(1, covered + 1)
    const to = Math.min(total, from + PLANNING_ACTION_CHAPTER_LIMIT - 1)
    const rangeKey = from + '-' + to + '@' + covered
    if (rangeKey === lastRange) { sameRangeAttempts += 1 } else { lastRange = rangeKey; sameRangeAttempts = 1 }
    if (sameRangeAttempts > 3) {
      emit({ status: 'failed', currentBatch: null, batchPercent: 0, message: text('第 ' + from + '–' + to + ' 章连续多次未能完整保存（停在第 ' + covered + ' 章），已停止以避免无限循环；可调小每章字数或范围后重试。', 'Chapters ' + from + '-' + to + ' repeatedly failed to save completely (stalled at chapter ' + covered + '). Stopped to avoid an endless loop; try a smaller per-chapter length or range.') })
      return
    }
    emit({
      status: 'running', totalChapters: total, coveredChapters: covered,
      percent: Math.floor((covered / total) * 100),
      remainingChapters: total - covered,
      currentBatch: { from, to }, batchPercent: 0, batchesCompleted,
      message: text('正在生成第 ' + from + '–' + to + ' 章（全书 ' + total + ' 章）…', 'Generating chapters ' + from + '-' + to + ' of ' + total + '…'),
    })

    let runId: string
    try {
      const receipt = await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['synopsis'],
        synopsisRange: { from, to },
        targetUnits,
      }, session)
      runId = receipt.runId
    } catch (error) {
      consecutiveFailures += 1
      emit({
        consecutiveFailures,
        message: text('第 ' + from + '–' + to + ' 章提交失败：' + (error instanceof Error ? error.message : String(error)), 'Failed to submit chapters ' + from + '-' + to + '.'),
      })
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        emit({ status: 'failed', currentBatch: null, message: text('连续多次失败，已停止。已完成大纲已保存，可稍后继续。', 'Stopped after repeated failures. Completed chapters are saved; you can resume later.') })
        return
      }
      await sleep(3000)
      continue
    }

    const result = await waitForRun(runId, batchPercent => emit({ batchPercent }), token)
    if (token !== loopToken || cancelRequested) return

    const after = await readProjectProgress(session)
    const afterCovered = after?.coveredChapters ?? covered

    if (result.ok && afterCovered > covered) {
      consecutiveFailures = 0
      lastRange = ''
      sameRangeAttempts = 0
      batchesCompleted += 1
      emit({
        coveredChapters: afterCovered,
        percent: Math.floor((afterCovered / total) * 100),
        remainingChapters: Math.max(0, total - afterCovered),
        batchesCompleted, consecutiveFailures: 0, currentBatch: null, batchPercent: 0,
        message: text('已完成至第 ' + afterCovered + ' 章。', 'Progress saved through chapter ' + afterCovered + '.'),
      })
    } else {
      consecutiveFailures += 1
      emit({
        coveredChapters: afterCovered,
        percent: Math.floor((afterCovered / total) * 100),
        remainingChapters: Math.max(0, total - afterCovered),
        consecutiveFailures, currentBatch: null, batchPercent: 0,
        message: text(
          '第 ' + from + '–' + to + ' 章未完成' + (result.error ? '：' + result.error : '') + '。已完成部分已保存，正在重试…',
          'Chapters ' + from + '-' + to + ' did not complete. Saved parts are kept; retrying…',
        ),
      })
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        emit({
          status: 'failed',
          message: text(
            '连续 ' + MAX_CONSECUTIVE_FAILURES + ' 次失败，已安全停止。已完成 ' + afterCovered + ' / ' + total + ' 章，可稍后继续；原大纲不会被覆盖。',
            'Stopped safely after ' + MAX_CONSECUTIVE_FAILURES + ' consecutive failures. ' + afterCovered + ' / ' + total + ' chapters are done; resume later without overwriting the outline.',
          ),
        })
        return
      }
      await sleep(3000)
    }

    if (pauseRequested) {
      pauseRequested = false
      emit({ status: 'paused', currentBatch: null, batchPercent: 0, message: text('已暂停。点击继续可接着生成。', 'Paused. Click resume to continue.') })
      return
    }
    await sleep(800)
  }
}
