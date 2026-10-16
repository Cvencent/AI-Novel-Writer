import { useEffect, useRef, useState } from 'react'

import { ipc } from '../../../services/ipc-client'
import type { ProjectOverview } from '../../../shared/project-overview'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { confirmRemoveRecentProject } from '../../project-delete-action'

export type ShelfOverview = { state: 'loading' | 'empty' } | ProjectOverview

export interface ShelfBook {
  id: string
  name: string
  path: string
  updatedAt: string
  current: boolean
  onPreview: () => void
  onOpen: () => void
  onRemove: () => void
}

const EMPTY_OVERVIEW: ShelfOverview = { state: 'empty' }

/**
 * 书架与作品概览。当前作品读 `project:overview-current`（带摘录），其他书只用 `project:peek-overview` 预览，不正式打开。
 * 旧外壳的欢迎页与新外壳的书房共用这份数据。
 */
export function useShelfOverview() {
  const currentProject = useProjectStore(state => state.currentProject)
  const recentProjects = useProjectStore(state => state.recentProjects)
  const currentKey = currentProject
    ? `${currentProject.id}\0${currentProject.path}\0${currentProject.sessionLease ?? ''}`
    : ''
  const currentSession = captureProjectSession(currentProject)
  const [selection, setSelection] = useState<{
    currentKey: string
    itemId: string
    requestKey: string
  } | null>(null)
  const [result, setResult] = useState<{ requestKey: string; overview: ProjectOverview } | null>(null)
  const request = useRef(0)

  useEffect(() => {
    try {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index)
        if (key?.startsWith('vela:overview:')) localStorage.removeItem(key)
      }
    } catch {
      // Storage can be disabled. Overview remains IPC-only either way.
    }
  }, [])

  useEffect(() => {
    const requestId = ++request.current
    if (!currentKey) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    const requestKey = `current:${currentKey}`
    void ipc.invokeWithProjectSession(session, 'project:overview-current').then(result => {
      if (request.current === requestId && isProjectSessionCurrent(session)) {
        setResult({ requestKey, overview: result })
      }
    }).catch(() => {
      if (request.current === requestId && isProjectSessionCurrent(session)) {
        setResult({ requestKey, overview: { state: 'unavailable' } })
      }
    })
    return () => { request.current += 1 }
  }, [currentKey])

  const activeSelection = selection?.currentKey === currentKey ? selection : null
  const requestKey = activeSelection?.requestKey ?? (currentKey ? `current:${currentKey}` : '')
  const overview: ShelfOverview = result?.requestKey === requestKey
    ? result.overview
    : activeSelection || currentSession
      ? { state: 'loading' }
      : currentProject
        ? { state: 'unavailable' }
        : EMPTY_OVERVIEW

  const preview = (project: (typeof recentProjects)[number]) => {
    const itemId = project.previewCapabilityId ?? project.path
    if (activeSelection?.itemId === itemId) {
      void useProjectStore.getState().openProject(project.path)
      return
    }

    const requestId = ++request.current
    const requestKey = `preview:${itemId}`
    setSelection({ currentKey, itemId, requestKey })
    if (!project.previewCapabilityId) {
      setResult({ requestKey, overview: { state: 'unavailable' } })
      return
    }
    void ipc.invoke('project:peek-overview', project.previewCapabilityId).then((result: ProjectOverview) => {
      if (request.current === requestId) setResult({ requestKey, overview: result })
    }).catch(() => {
      if (request.current === requestId) setResult({ requestKey, overview: { state: 'unavailable' } })
    })
  }

  return {
    overview,
    /** 正在预览的书；为空时概览显示当前作品。 */
    selectedId: activeSelection?.itemId ?? null,
    clearSelection: () => setSelection(null),
    recentProjects: recentProjects.map((project): ShelfBook => ({
      id: project.previewCapabilityId ?? project.path,
      name: project.name,
      path: project.path,
      updatedAt: project.updatedAt,
      current: Boolean(currentProject && sameProjectPathKey(currentProject.path, project.path)),
      onPreview: () => preview(project),
      onOpen: () => { void useProjectStore.getState().openProject(project.path) },
      onRemove: () => { void confirmRemoveRecentProject(project) },
    })),
    hasCurrentProject: currentProject !== null && !activeSelection,
    deletableCurrentProject: currentProject && !activeSelection ? { name: currentProject.name, path: currentProject.path } : null,
  }
}
