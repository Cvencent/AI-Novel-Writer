/**
 * 工作流前置校验工具
 *
 * 每个生成步骤启动前需要校验上游数据是否就绪，
 * 以防用户在配置不完整的状态下浪费 AI Token。
 *
 * 校验失败时返回 GuardResult { ok: false, message }，
 * 由调用方选择展示方式（弹窗提示 / 日志输出）。
 */

import { useProjectStore } from '../stores/project-store'
import { useLocaleStore } from '../stores/locale-store'
import { ipc } from './ipc-client'
import type { ProjectData, ProjectSessionContext } from '../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { localize } from '../i18n/core'
import { ARCH_STEP_NAMES } from './architecture-step-selection'
import type { Locale } from '../i18n/types'

import { readPostProcessStatus, getChapterFinalizeScope, getFailedStepLabels } from './workflows/workflow-utils'

export interface GuardResult {
  ok: boolean
  /** 失败时的提示语（给用户看） */
  message?: string
  /** 用于跳转引导的目标动作标识 */
  action?: 'open-config' | 'open-world-building' | 'open-blueprint'
}

function captureGuardProject(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): { project: ProjectData; projectPath: string; projectSession: ProjectSessionContext } | null {
  const project = useProjectStore.getState().currentProject
  const projectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !projectSession
    || (expectedProjectPath && !sameProjectPathKey(project.path, expectedProjectPath))
    || (expectedProjectSession && !sameProjectSessionContext(expectedProjectSession, projectSession))
  ) return null
  return { project, projectPath: expectedProjectPath ?? project.path, projectSession }
}

// ===== Guard 1：生成故事架构前 → 校验小说配置 =====

/**
 * 生成故事架构（架构文件）前的前置校验：
 * 要求「核心大纲」或「主角人设」至少填写其中之一。
 */
export function guardArchitectureGeneration(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale: Locale = useLocaleStore.getState().locale,
): GuardResult {
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(uiLocale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { project } = captured
  const { coreOutline, protagonistProfile, worldSetting, genre } = project.novelConfig

  // 校验：小说配置是否有实质内容
  const hasConfig = !!(
    coreOutline?.trim() ||
    protagonistProfile?.trim() ||
    worldSetting?.trim()
  )

  if (!hasConfig) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        `请先填写「小说配置」中的核心大纲或主角人设，AI 才能据此生成故事架构。\n\n当前类型：${genre || '未设置'}`,
        `Fill in the core outline or protagonist profile in Novel Configuration before generating the story architecture.\n\nCurrent genre: ${genre || 'Not set'}`,
      ),
      action: 'open-config',
    }
  }

  return { ok: true }
}

// ===== Guard 1.5：生成细纲前 → 粗纲必须铺满且全部确认 =====

/**
 * 生成细纲（细纲）前的前置校验：粗纲必须先铺满全书、并且每一段都已确认。
 *
 * 为什么要有这条：粗纲是细纲的方向来源。粗纲没铺满、或还有没确认的段时直接生成细纲，
 * 等于在没有方向的情况下往下写——写歪了也没法回头对齐，而作者发现走偏时常常已经写了几十章。
 * 确认过的粗纲段是作者明确认可的走向，所以「按某段生成细纲」那条路径不会经过这里
 * （它带着 arcContext，调用方见 guardIntent）。
 *
 * 判不出来时不拦：总章数还没设（0）或台账读不到，都不该因为一次读取失败挡住作者。
 */
/**
 * 这次细纲生成要不要走粗纲闸门。
 *
 * 不走闸门的两种情况：
 * - 不是只生成细纲（比如整套架构生成，粗纲本来就不在那条链上）；
 * - 带着 arcContext：这是「按某个已确认的粗纲段生成细纲」，那一段就是作者认可的走向，
 *   不需要全书粗纲先铺满。
 *
 * 抽成纯函数是为了让这个例外本身可测，而不是埋在启动流程里。
 */
export function needsConfirmedArcGate(intent: {
  selectedSteps?: readonly string[]
  arcContext?: unknown
}): boolean {
  return (intent.selectedSteps ?? []).includes('synopsis') && !intent.arcContext
}

export async function guardSynopsisNeedsConfirmedArc(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale: Locale = useLocaleStore.getState().locale,
): Promise<GuardResult> {
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(uiLocale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }
  const { projectPath, projectSession } = captured
  const [arcs, core] = await Promise.all([
    ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-list', projectPath).catch(() => null),
    ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath).catch(() => null),
  ])
  // 读不到就当判不了：不能因为一次读取失败挡住作者。
  if (!Array.isArray(arcs) || !core) return { ok: true }
  const totalChapters = Number(core.totalChapters) || 0
  if (totalChapters <= 0) return { ok: true }

  const list = arcs as { fromChapter: number; toChapter: number; status: string }[]
  if (list.length === 0) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        '还没有粗纲。粗纲决定整本书的方向，细纲要按它来写。\n\n请先在「故事架构 → 粗纲」里生成粗纲（可以点「一键生成全部粗纲」一次铺满全书），确认后再生成细纲。',
        'There is no arc outline yet. The arc outline sets the direction for the whole book, and chapter outlines follow it.\n\nGenerate the arc outline first in Story Architecture, then Arc outline (the "Generate all arc segments" button fills the whole book in one go), and confirm it before creating chapter outlines.',
      ),
      action: 'open-world-building',
    }
  }

  const coveredTo = list.reduce((max, arc) => Math.max(max, arc.toChapter), 0)
  if (coveredTo < totalChapters) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        `粗纲还没有铺满全书：目前覆盖到第 ${coveredTo} 章，全书共 ${totalChapters} 章。\n\n请先把粗纲补到全书末章并确认，再生成细纲——否则后面的章节会在没有方向的情况下往下写。`,
        `The arc outline does not cover the whole book yet: it reaches chapter ${coveredTo} of ${totalChapters}.\n\nExtend the arc outline to the final chapter and confirm it before creating chapter outlines, otherwise later chapters are written without a direction.`,
      ),
      action: 'open-world-building',
    }
  }

  const unconfirmed = list.filter(arc => arc.status !== 'confirmed')
  if (unconfirmed.length > 0) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        `粗纲还有 ${unconfirmed.length} 段没有确认（第 ${unconfirmed[0]!.fromChapter}–${unconfirmed[0]!.toChapter} 章起）。\n\n请先在「故事架构 → 粗纲」里确认这些段，再生成细纲。`,
        `The arc outline still has ${unconfirmed.length} segment(s) awaiting confirmation (starting at chapters ${unconfirmed[0]!.fromChapter}-${unconfirmed[0]!.toChapter}).\n\nConfirm them in Story Architecture, then Arc outline, before creating chapter outlines.`,
      ),
      action: 'open-world-building',
    }
  }

  return { ok: true }
}

// ===== Guard 2：生成章节蓝图前 → 校验故事架构完成度 =====

/**
 * 生成章节蓝图前的前置校验：
 * 要求至少有 1 个架构信息（故事前提）已生成，
 * 建议 4 个都完成，但允许继续（仅提示警告）。
 */
export async function guardDirectoryGeneration(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale: Locale = useLocaleStore.getState().locale,
): Promise<GuardResult> {
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(uiLocale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { projectPath, projectSession } = captured
  const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
  const missing: string[] = []

  const checkHasContent = (text: string | null | undefined) => text && text.length > 50 && !text.includes('> 待生成')

  const premiseLabel = localize(uiLocale, '故事前提', 'Story premise')
  if (!core || !checkHasContent(core.premise)) missing.push(premiseLabel)
  if (!core || !checkHasContent(core.charactersArch)) {
    missing.push(localize(uiLocale, ...ARCH_STEP_NAMES.characters))
  }
  if (!core || !checkHasContent(core.worldbuilding)) {
    missing.push(localize(uiLocale, '世界观', 'Worldbuilding'))
  }
  if (!core || !checkHasContent(core.synopsis)) {
    missing.push(localize(uiLocale, '细纲', 'Plot outline'))
  }

  // 故事前提是必须的（第一个大块）
  if (missing.includes(premiseLabel)) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        '「故事前提」尚未生成，它是章节蓝图的基础。\n\n请先在「故事架构」中点击「AI 生成架构」，生成故事前提后再来生成章节蓝图。',
        'The story premise has not been generated, and chapter blueprints depend on it.\n\nGenerate the story premise in Story Architecture before generating chapter blueprints.',
      ),
      action: 'open-world-building',
    }
  }

  // 检查角色卡是否存在（不变量 1 的反向约束）
  const chars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
  if (chars.length === 0) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        '角色卡不存在（数据库中没有角色记录）。\n\n请先在架构里生成角色名单（会同时建立角色卡），或手动添加角色。',
        'No character cards exist (the database has no character records).\n\nGenerate the cast in the architecture (this creates the cards), or add characters manually.',
      ),
    }
  }

  // 其他部分缺失：警告但允许继续
  if (missing.length > 0) {
    return {
      ok: true, // 允许继续，但携带警告信息
      message: localize(
        uiLocale,
        `注意：以下架构信息尚未生成，蓝图质量可能受影响：\n${missing.map(m => `• ${m}`).join('\n')}\n\n建议先生成完整架构，或继续使用现有内容。`,
        `The following architecture sections have not been generated, which may affect blueprint quality:\n${missing.map(m => `• ${m}`).join('\n')}\n\nGenerate the complete architecture first, or continue with the available content.`,
      ),
    }
  }

  return { ok: true }
}

// ===== Guard 3：章节写稿前 → 校验章节蓝图存在 =====

/**
 * 章节写稿前的前置校验：
 * 1. 要求 blueprints/ 目录中存在至少一个章节蓝图 JSON 文件。
 * 2. 如果指定了章节号且 > 1，要求前一章已定稿（存在于 manuscript/ 中），否则上下文会断裂。
 */
export async function guardChapterWriting(
  targetChapterNumber?: number,
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale: Locale = useLocaleStore.getState().locale,
): Promise<GuardResult> {
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(uiLocale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { projectPath, projectSession } = captured
  const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', projectPath)
  if (blueprints.length === 0) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        '尚未生成章节蓝图（数据库为空）。\n\n请先在「章节蓝图」中点击「AI 生成蓝图」，让 AI 规划每章内容后，再回来写稿。',
        'No chapter blueprints have been generated (the database is empty).\n\nGenerate chapter blueprints first, then return to draft the chapter.',
      ),
      action: 'open-blueprint',
    }
  }

  // 检查角色卡是否存在（不变量 1 的反向约束：无角色卡则阻断写稿）
  const chars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
  if (chars.length === 0) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        '角色卡不存在（数据库中没有角色记录）。\n\nAI 写稿需要角色状态作为上下文，请先在架构里生成角色名单，或手动添加角色。',
        'No character cards exist (the database has no character records).\n\nAI drafting needs character state as context. Generate the cast in the architecture, or add characters manually.',
      ),
    }
  }

  // 如果指定了且不是第一章，则必须保证前一章已经存在正文库（定稿状态）
  if (targetChapterNumber && targetChapterNumber > 1) {
    const prevChapter = targetChapterNumber - 1
    const prevDraftMeta = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-finalized', prevChapter, projectPath)
    if (!prevDraftMeta) {
      return {
        ok: false,
        message: localize(
          uiLocale,
          `上下文缺失：第 ${prevChapter} 章尚未定稿！\n\n为了保证 AI 写稿时能读取到连贯的上下文（前章结尾和剧情要点），请必须先前往草稿箱完成第 ${prevChapter} 章的定稿操作。`,
          `Missing context: Chapter ${prevChapter} has not been finalized.\n\nFinalize Chapter ${prevChapter} first so AI drafting can read a continuous context, including the previous ending and plot notes.`,
        ),
      }
    }

    // 不变量 2 的反向约束：前一章定稿后处理必须全部通过
    const prevScope = getChapterFinalizeScope(prevChapter)
    const prevStatus = await readPostProcessStatus(projectPath, prevScope, projectSession)
    if (prevStatus && !prevStatus.allCriticalPassed) {
      const failedLabels = getFailedStepLabels(prevStatus)
      return {
        ok: false,
        message: localize(
          uiLocale,
          `第 ${prevChapter} 章的定稿后处理未完成！\n\n以下关键步骤失败：\n${failedLabels.map(f => `• ${f}`).join('\n')}\n\n请先在草稿箱中点击「修复定稿」按钮补全数据，否则后续章节的 AI 上下文将不完整。`,
          `Chapter ${prevChapter} finalization post-processing is incomplete.\n\nFailed critical steps:\n${failedLabels.map(f => `• ${f}`).join('\n')}\n\nRepair the finalization from Drafts first, or later chapters will have incomplete AI context.`,
        ),
      }
    }
    // 如果状态文件不存在（旧版定稿）→ 兼容放行
  }

  return { ok: true }
}

// ===== Guard 4：角色卡重新生成前 → 检查蓝图是否为空 =====

/**
 * 角色卡重新生成/补齐的前置校验：
 * 不变量 1：角色卡仅允许在蓝图目录为空时重新生成，
 * 否则会破坏已有蓝图/章节的角色状态链。
 */
export async function guardCharacterRegeneration(
  expectedProjectSession?: ProjectSessionContext,
  uiLocale: Locale = useLocaleStore.getState().locale,
): Promise<GuardResult> {
  const captured = captureGuardProject(undefined, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(uiLocale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const blueprints = await ipc.invokeWithProjectSession(
    captured.projectSession,
    'db:blueprint-get-all',
    captured.projectPath,
  )
  if (blueprints.length > 0) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        '已有章节蓝图，角色卡不可重新生成。\n\n蓝图生成已依赖角色数据，重新生成角色卡会导致现有蓝图和已写章节全部失效。\n如需修改角色，请手动编辑现有角色卡。',
        'Character cards cannot be regenerated while chapter blueprints exist.\n\nThe blueprints already depend on character data. Regenerating the cards would invalidate existing blueprints and drafted chapters. Edit the existing character cards manually instead.',
      ),
    }
  }

  return { ok: true }
}

// ===== Guard 5：修复定稿后处理前 → 检查是否为最新定稿章节 =====

/**
 * 修复定稿后处理的前置校验：
 * 不变量 2：后处理只允许在最新定稿章节上执行，
 * 回溯重跑历史章节会覆盖后续章节的角色状态。
 */
export async function guardRepairPostProcess(
  chapterNumber: number,
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): Promise<GuardResult> {
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return { ok: false, message: '请先打开或新建一个项目。' }
  }

  // 从数据库获取最大的定稿章节号
  const maxFinalized = await ipc.invokeWithProjectSession(
    captured.projectSession,
    'db:draft-get-max-finalized-chapter',
    captured.projectPath,
  )

  if (maxFinalized === 0) {
    return { ok: false, message: '尚无已定稿章节，无法执行修复操作。' }
  }

  if (chapterNumber !== maxFinalized) {
    return {
      ok: false,
      message: `只允许修复最新定稿章节（第 ${maxFinalized} 章）的后处理。\n\n回溯修复第 ${chapterNumber} 章会破坏角色状态的线性演化链。`,
    }
  }

  return { ok: true }
}
