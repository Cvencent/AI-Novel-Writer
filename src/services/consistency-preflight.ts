import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { BlueprintForPreflight, ConsistencyExemption, ConsistencyFinding } from '../shared/consistency-preflight'
import { findBlueprintContinuityRisks, findExpandedContinuityRisks } from '../shared/consistency-preflight'
import { ipc } from './ipc-client'

export interface ConsistencyPreflightResult {
  findings: ConsistencyFinding[]
  exemptions: ConsistencyExemption[]
}

export async function readConsistencyPreflight(
  session: ProjectSessionContext,
  blueprints: readonly BlueprintForPreflight[],
): Promise<ConsistencyPreflightResult> {
  const exemptions = await ipc.invokeWithProjectSession(
    session, 'db:consistency-exemption-list', session.projectPath,
  )
  const [roster, allBlueprints, threads] = await Promise.all([
    ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath).catch(() => null),
    ipc.invokeWithProjectSession(session, 'db:blueprint-get-all', session.projectPath).catch(() => []),
    ipc.invokeWithProjectSession(session, 'db:narrative-thread-list', session.projectPath).catch(() => []),
  ])
  const terminalFindings = (await Promise.all(blueprints.map(async blueprint => {
    const projections = await ipc.invokeWithProjectSession(
      session, 'db:continuity-list-before', blueprint.chapterNumber, session.projectPath,
    )
    return findBlueprintContinuityRisks(projections, blueprint, exemptions)
  }))).flat()
  const currentChapter = blueprints.reduce((max, blueprint) => Math.max(max, blueprint.chapterNumber), 0)
  const expandedFindings = currentChapter === 0 ? [] : findExpandedContinuityRisks({
    currentChapter,
    blueprints: (Array.isArray(allBlueprints) ? allBlueprints : []).map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
    })),
    cast: (Array.isArray(roster?.entries) ? roster.entries : []).map(entry => ({
      name: entry.name,
      role: entry.role,
      motivation: typeof entry.motivation === 'string' ? entry.motivation : '',
    })),
    threads: (Array.isArray(threads) ? threads : []).map(thread => ({
      title: thread.title,
      status: thread.status,
      dormantChapters: thread.dormantChapters,
      overdue: thread.overdue,
      authorIntent: thread.authorIntent,
    })),
  })
  const activeExemptions = new Set(exemptions.filter(item => !item.revoked).map(item => item.stableFactKey))
  return { findings: [...terminalFindings, ...expandedFindings].filter(item => !activeExemptions.has(item.stableFactKey)), exemptions }
}
