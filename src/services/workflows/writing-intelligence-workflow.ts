import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { workflowResourceKey, type WorkflowDefinition } from '../../stores/workflow-store'
import { localize } from '../../i18n/core'
import type { Locale } from '../../i18n/types'
import { randomUUID } from '../../utils/id'
import { normalizeChapterWordsTarget } from './chapter-creation-parameters'

function localeOf(value?: Locale): Locale { return value === 'en-US' ? 'en-US' : 'zh-CN' }

export function createScenePlanWorkflow(params: {
  projectPath: string
  projectSession: ProjectSessionContext
  chapterNumber: number
  targetWords?: number
  locale?: Locale
  runId?: string
}): WorkflowDefinition {
  const locale = localeOf(params.locale)
  const targetWords = normalizeChapterWordsTarget(params.targetWords)
  return {
    runId: params.runId ?? randomUUID(),
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: Object.freeze({ ...params.projectSession }),
    uiLocale: locale,
    resourceKeys: [workflowResourceKey('blueprints'), workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: [workflowResourceKey('architecture'), workflowResourceKey('character-roster'), workflowResourceKey('novel-config')],
    title: localize(locale, `第 ${params.chapterNumber} 章 · AI 拆场景`, `Chapter ${params.chapterNumber} · Scene cards`),
    steps: [{
      name: localize(locale, '生成场景卡', 'Generate scene cards'),
      description: localize(locale, '把本章蓝图拆成目标—阻力—转折—结果明确的场景。', 'Split the chapter blueprint into goal–resistance–turn–outcome scenes.'),
      executor: async (step, context, callbacks) => {
        const { GenerateScenePlanCommand } = await import('./commands/generate-scene-plan.command')
        const scenes = await new GenerateScenePlanCommand({ chapterNumber: params.chapterNumber, targetWords }).execute({ step, context, callbacks })
        return JSON.stringify(scenes)
      },
    }],
    onComplete: { mode: 'silent', message: localize(locale, '场景卡已生成。', 'Scene cards generated.') },
  }
}

export function createEditorialPanelWorkflow(params: {
  projectPath: string
  projectSession: ProjectSessionContext
  chapterNumber: number
  draftId: number
  draftVersion: number
  locale?: Locale
  runId?: string
}): WorkflowDefinition {
  const locale = localeOf(params.locale)
  return {
    runId: params.runId ?? randomUUID(),
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: Object.freeze({ ...params.projectSession }),
    uiLocale: locale,
    resourceKeys: [workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: [workflowResourceKey('architecture'), workflowResourceKey('blueprints'), workflowResourceKey('character-roster'), workflowResourceKey('continuity')],
    title: localize(locale, `第 ${params.chapterNumber} 章 · 编辑部评审`, `Chapter ${params.chapterNumber} · Editorial panel`),
    steps: [{
      name: localize(locale, '五角色评审', 'Five-role review'),
      description: localize(locale, '情节、连续性、角色、文风、节奏分别评分并给出证据。', 'Score plot, continuity, character, style, and pacing with evidence.'),
      executor: async (step, context, callbacks) => {
        const { EditorialPanelCommand } = await import('./commands/editorial-panel.command')
        return JSON.stringify(await new EditorialPanelCommand(params).execute({ step, context, callbacks }))
      },
    }],
    onComplete: { mode: 'silent', message: localize(locale, '编辑部评审完成。', 'Editorial review completed.') },
  }
}

export function createCandidateTournamentWorkflow(params: {
  projectPath: string
  projectSession: ProjectSessionContext
  chapterNumber: number
  candidates: readonly { draftId: number; version: number }[]
  locale?: Locale
  runId?: string
}): WorkflowDefinition {
  if (params.candidates.length < 2 || params.candidates.length > 6) throw new Error('候选评审需要 2–6 份草稿')
  const locale = localeOf(params.locale)
  return {
    runId: params.runId ?? randomUUID(),
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: Object.freeze({ ...params.projectSession }),
    uiLocale: locale,
    resourceKeys: [workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: [workflowResourceKey('architecture'), workflowResourceKey('blueprints'), workflowResourceKey('character-roster'), workflowResourceKey('continuity')],
    title: localize(locale, `第 ${params.chapterNumber} 章 · 候选锦标赛`, `Chapter ${params.chapterNumber} · Candidate tournament`),
    steps: params.candidates.map(candidate => ({
      name: localize(locale, `评审草稿 v${candidate.version}`, `Review draft v${candidate.version}`),
      description: localize(locale, '使用同一套五角色标准独立评分。', 'Score independently with the same five-role rubric.'),
      executor: async (step, context, callbacks) => {
        const { EditorialPanelCommand } = await import('./commands/editorial-panel.command')
        return JSON.stringify(await new EditorialPanelCommand({ chapterNumber: params.chapterNumber, draftId: candidate.draftId, draftVersion: candidate.version }).execute({ step, context, callbacks }))
      },
    })),
    onComplete: { mode: 'silent', message: localize(locale, '候选锦标赛完成，可在版本历史查看排名。', 'Tournament completed. See the ranking in version history.') },
  }
}

export function createVoiceProfileWorkflow(params: {
  projectPath: string
  projectSession: ProjectSessionContext
  chapterNumber: number
  draftId: number
  draftVersion: number
  locale?: Locale
  runId?: string
}): WorkflowDefinition {
  const locale = localeOf(params.locale)
  return {
    runId: params.runId ?? randomUUID(),
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: Object.freeze({ ...params.projectSession }),
    uiLocale: locale,
    resourceKeys: [workflowResourceKey('character-roster')],
    readResourceKeys: [workflowResourceKey('chapter', params.chapterNumber), workflowResourceKey('continuity')],
    title: localize(locale, `第 ${params.chapterNumber} 章 · 角色声音`, `Chapter ${params.chapterNumber} · Character voices`),
    steps: [{
      name: localize(locale, '提取角色声音', 'Extract character voices'),
      description: localize(locale, '从本章正文提取可复用、可追溯的角色对白特征。', 'Extract reusable, evidence-backed dialogue traits from this chapter.'),
      executor: async (step, context, callbacks) => {
        const { ExtractVoiceProfilesCommand } = await import('./commands/extract-voice-profiles.command')
        return JSON.stringify(await new ExtractVoiceProfilesCommand(params).execute({ step, context, callbacks }))
      },
    }],
    onComplete: { mode: 'silent', message: localize(locale, '角色声音档案已更新。', 'Character voice profiles updated.') },
  }
}
