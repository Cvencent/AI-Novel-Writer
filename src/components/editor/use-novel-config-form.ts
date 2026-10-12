import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import type { NovelConfig, ProjectData } from '../../shared/ipc-channels'
import { resolveWritingLanguage } from '../../shared/writing-language'
import type { GeneratableField } from '../../services/workflows/commands/generate-field.command'
import { randomUUID } from '../../utils/id'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import type { SaveOutcome } from './save-feedback'

export const NOVEL_GENRES = ['玄幻', '仙侠', '都市', '科幻', '历史', '军事', '游戏', '末世', '悬疑', '灵异', '言情', '古言', '现言', '奇幻', '武侠', '轻小说', '同人', '职场']

/** 同路径项目重新打开时用新的 key 重挂载表单，避免旧会话的保存、生成状态泄漏到新 lease。 */
export function novelConfigSessionKey(currentProject: ProjectData | null, projectKey: string): string {
  const projectSession = captureProjectSession(currentProject)
  return projectSession && isProjectSessionPath(projectSession, projectKey)
    ? `${projectSession.projectId}:${projectSession.leaseId}`
    : `inactive:${projectKey}`
}

/**
 * 小说配置表单的数据逻辑：读写 project-store 里的配置、保存到磁盘、退出前保存、单字段与整体 AI 填充。
 * 旧外壳的小说配置页与新外壳的设定页共用；调用方按 novelConfigSessionKey 挂载。
 */
export function useNovelConfigForm(projectKey: string) {
  const currentProject = useProjectStore(s => s.currentProject)
  const updateNovelConfig = useProjectStore(s => s.updateNovelConfig)
  const saveProject = useProjectStore(s => s.saveProject)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  // addLog 用 getState() 命令式调用，不订阅 workflow store，避免流式生成时高频更新导致表单重渲染。
  const addLog = useWorkflowStore.getState().addLog
  const [saving, setSaving] = useState(false)
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>('idle')
  const [showGenerateConfig, setShowGenerateConfig] = useState(false)
  const text = useLocaleStore(s => s.text)
  const [generateSession, setGenerateSession] = useState<ReturnType<typeof captureProjectSession>>(null)
  const [generatingField, setGeneratingField] = useState<GeneratableField | null>(null)

  const projectMatches = currentProject?.path === projectKey
  const config = projectMatches ? currentProject.novelConfig : null
  const dirty = useEditorStore(state => state.tabs.some(
    tab => tab.type === 'config' && tab.projectKey === projectKey && tab.dirty,
  ))
  const exitSaveRef = useRef<(propagateFailure?: boolean) => Promise<void>>(async () => undefined)
  useEffect(() => {
    registerEditorExitSaveHandler({
      type: 'config',
      projectKey,
      save: () => exitSaveRef.current(true),
    })
  }, [projectKey])

  const update = <K extends keyof NovelConfig>(key: K, value: NovelConfig[K]) => {
    if (!config) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    updateNovelConfig({ [key]: value }, projectSession)
    setSaveOutcome('idle')
  }

  /** Store 已是最新数据，这里只持久化到磁盘。 */
  const save = async (propagateFailure = false) => {
    const projectSession = captureProjectSession(currentProject)
    if (!config || saving || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setSaving(true)
    setSaveOutcome('idle')
    try {
      const saved = await saveProject(projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      if (!saved) throw new Error(text('项目配置未能写入磁盘', 'The project configuration could not be written to disk.'))
      addLog('info', text('小说配置已保存', 'Novel configuration saved'))
      const stillDirty = useEditorStore.getState().tabs.some(
        tab => tab.type === 'config' && tab.projectKey === projectKey && tab.dirty,
      )
      setSaveOutcome(stillDirty ? 'idle' : 'saved')
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) {
        setSaveOutcome('failed')
        console.error('[NovelConfigEditor] 保存失败:', error)
        addLog('error', text(`保存失败：${error}`, `Save failed: ${error}`))
      }
      if (propagateFailure) throw error
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSaving(false)
    }
  }
  useEffect(() => {
    exitSaveRef.current = save
  })

  const openGenerateDialog = () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!defaultModelId) {
      addLog('error', text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }
    setGenerateSession(projectSession)
    setShowGenerateConfig(true)
  }

  const generateField = async (fieldKey: GeneratableField) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!defaultModelId) {
      addLog('error', text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }
    if (generatingField) return

    setGeneratingField(fieldKey)
    try {
      const { GenerateFieldCommand } = await import('../../services/workflows/commands/generate-field.command')
      if (!isProjectSessionCurrent(projectSession)) return
      const cmd = new GenerateFieldCommand(fieldKey)
      await cmd.execute({
        step: { id: '', commandId: '', name: '', params: {} },
        context: {
          runId: `config-field:${randomUUID()}`,
          projectPath: projectSession.projectPath,
          projectSession,
          writingLanguage: resolveWritingLanguage(currentProject?.novelConfig.writingLanguage),
          uiLocale: useLocaleStore.getState().locale,
          data: {},
          cancelled: false,
        },
        callbacks: {
          log: (msg: string) => useWorkflowStore.getState().addLog('info', msg),
          setProgress: () => { },
          appendText: () => { },
        },
      })
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      addLog('error', e instanceof Error && e.message === 'GENERATION_AUTHOR_DRAFT_CHANGED'
        ? text(
          '生成期间小说配置已修改。已保留你的修改，请按当前配置重新生成。',
          'The novel configuration changed during generation. Your edits have been preserved. Generate again using the current configuration.',
        )
        : text(`生成失败：${e}`, `Generation failed: ${e}`))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setGeneratingField(null)
    }
  }

  /** AI 填充的结果只提交给启动时冻结的会话；作品已切换或重新打开时丢弃。 */
  const applyGeneratedTo = (session: ReturnType<typeof captureProjectSession>) => (parsed: Partial<NovelConfig>) => {
    if (!isProjectSessionCurrent(session)) return
    updateNovelConfig(parsed, session)
  }

  const generateDialog = {
    isOpen: showGenerateConfig,
    onClose: () => {
      setGenerateSession(null)
      setShowGenerateConfig(false)
    },
    onGenerated: applyGeneratedTo(generateSession),
  }

  return {
    config,
    projectMatches,
    dirty,
    saving,
    saveOutcome,
    update,
    save,
    generatingField,
    generateField,
    openGenerateDialog,
    generateDialog,
    applyGeneratedTo,
  }
}
