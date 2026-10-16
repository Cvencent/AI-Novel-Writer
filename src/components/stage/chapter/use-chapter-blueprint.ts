import { useEffect, useState } from 'react'
import { globalEventBus } from '../../../shared/event-bus'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

type Blueprint = Awaited<ReturnType<typeof readBlueprint>>

function readBlueprint(chapterNumber: number, projectKey: string) {
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  if (!session || !isProjectSessionPath(session, projectKey)) return Promise.resolve(null)
  return ipc.invokeWithProjectSession(session, 'db:blueprint-get', chapterNumber, session.projectPath)
}

/** 这一章的蓝图；蓝图或草稿资源刷新时重读。 */
export function useChapterBlueprint(chapterNumber: number | undefined, projectKey: string): Blueprint | undefined {
  const [blueprint, setBlueprint] = useState<Blueprint | undefined>(undefined)
  const [version, setVersion] = useState(0)
  useEffect(() => globalEventBus.on('REFRESH_RESOURCE', ({ projectSession, resources }) => {
    if (isProjectSessionCurrent(projectSession) && resources.some(kind => kind === 'blueprints' || kind === 'all')) setVersion(v => v + 1)
  }), [])
  useEffect(() => {
    if (chapterNumber === undefined) return
    let cancelled = false
    void readBlueprint(chapterNumber, projectKey).then(next => { if (!cancelled) setBlueprint(next) }).catch(() => { if (!cancelled) setBlueprint(null) })
    return () => { cancelled = true }
  }, [chapterNumber, projectKey, version])
  return blueprint
}

