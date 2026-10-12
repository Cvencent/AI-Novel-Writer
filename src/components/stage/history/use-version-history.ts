import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { requireIpcSuccess } from '../../../services/ipc-result'
import type { VersionRecord } from '../../../services/version-service'
import { countDraftUnits } from '../../../shared/draft-units'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

export interface VersionChapter {
  number: number
  title: string
}

/** 一次对比的两边正文。current 为 null 表示这一章还没有任何稿。 */
export interface VersionComparison {
  older: string
  current: string | null
}

/**
 * 版本历史的数据：章节列表、所选章的各稿，以及读取对比两边与回退。新外壳的版本历史页与旧外壳的 VersionHistory 共用。
 * 回退不覆盖任何一稿，而是用旧稿的正文新建一稿，返回新稿的版本号。
 */
export function useVersionHistory(projectKey: string) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const [chapters, setChapters] = useState<VersionChapter[]>([])
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null)
  const [versions, setVersions] = useState<VersionRecord[]>([])
  const [loading, setLoading] = useState(true)

  const loadChapters = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setLoading(true)
    try {
      const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', projectSession.projectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      setChapters(blueprints.map(blueprint => ({
        number: blueprint.chapterNumber,
        title: blueprint.title || text(`第 ${blueprint.chapterNumber} 章`, `Chapter ${blueprint.chapterNumber}`),
      })))
    } catch {
      if (isProjectSessionCurrent(projectSession)) setChapters([])
    } finally {
      if (isProjectSessionCurrent(projectSession)) setLoading(false)
    }
  }, [currentProject, projectKey, text])

  useEffect(() => {
    let mounted = true
    Promise.resolve().then(() => { if (mounted) void loadChapters() })
    return () => { mounted = false }
  }, [loadChapters])

  const loadVersions = useCallback(async (chapterNumber: number) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const drafts = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chapterNumber, projectSession.projectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      setVersions(drafts.map(draft => ({
        id: draft.id,
        version: draft.version,
        type: draft.status === 'finalized' ? 'final' : (draft.status === 'revised' ? 'refined' : 'draft'),
        word_count: draft.wordCount || 0,
        created_at: draft.createdAt,
        dependencies_stale: draft.dependenciesStale,
      })))
    } catch {
      if (isProjectSessionCurrent(projectSession)) setVersions([])
    }
  }, [projectKey])

  useEffect(() => {
    if (selectedChapter === null) return
    let mounted = true
    Promise.resolve().then(() => { if (mounted) void loadVersions(selectedChapter) })
    return () => { mounted = false }
  }, [loadVersions, selectedChapter])

  const selectChapter = useCallback((chapterNumber: number) => {
    setVersions([])
    setSelectedChapter(chapterNumber)
  }, [])

  /** 读出这一稿与这一章最新一稿的正文；会话已切换或这一稿读不到时返回 null。 */
  const readComparison = useCallback(async (versionId: number): Promise<VersionComparison | null> => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || selectedChapter === null) return null
    const older = (await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', versionId, projectSession.projectPath))?.content
    if (!isProjectSessionCurrent(projectSession) || !older) return null
    const latest = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-latest', selectedChapter, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    if (latest?.id === undefined) return { older, current: null }
    if (latest.id === versionId) return { older, current: older }
    const current = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', latest.id, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    return { older, current: current?.content ?? '' }
  }, [projectKey, selectedChapter])

  /** 用这一稿的正文新建一稿（回滚草稿），原有各稿都保留。返回新稿的版本号；会话已切换或旧稿为空时返回 null。 */
  const createRollbackDraft = useCallback(async (versionId: number): Promise<number | null> => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || selectedChapter === null) return null
    const content = (await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', versionId, projectSession.projectPath))?.content
    if (!isProjectSessionCurrent(projectSession) || !content) return null
    const nextVersion = await ipc.invokeWithProjectSession(projectSession, 'db:draft-next-version', selectedChapter, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    requireIpcSuccess(await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
      chapterNumber: selectedChapter,
      version: nextVersion,
      source: 'rewrite',
      content,
      wordCount: countDraftUnits(content),
    }, projectSession.projectPath), text('创建回滚草稿', 'Create rollback draft'))
    if (!isProjectSessionCurrent(projectSession)) return null
    await loadVersions(selectedChapter)
    return nextVersion
  }, [loadVersions, projectKey, selectedChapter, text])

  return { chapters, loading, selectedChapter, selectChapter, versions, readComparison, createRollbackDraft }
}
