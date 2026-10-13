import { ipc } from '../../services/ipc-client'
import { parseHumanConfirmedReviewSnapshot } from '../../shared/human-confirmed-review'
import type { ExpectedDraftSource, ProjectSessionContext } from '../../shared/ipc-channels'
import { getActiveProjectSessionContext, sameProjectSessionContext } from '../../shared/project-session-context'
import type { ChapterFacts } from './stage-progress'
import { useStageStore } from './stage-store'

interface DraftIdentity {
  id: number
  chapterNumber: number
  version: number
  status: string
  content: string
}

/** 修稿生成时冻结的源稿与这一稿现在保存的样子相同，才能合并；旧修稿没有冻结源，只能查看。 */
export function isRevisionSourceCurrent(source: ExpectedDraftSource | null | undefined, draft: DraftIdentity): boolean {
  if (!source) return false
  return source.id === draft.id
    && source.chapterNumber === draft.chapterNumber
    && source.version === draft.version
    && source.status === draft.status
    && source.content === draft.content
}

async function readLatestReview(reviews: readonly { id: number; reviewIndex: number; createdAt: string }[], session: ProjectSessionContext) {
  const latest = [...reviews].sort((a, b) => a.reviewIndex - b.reviewIndex).at(-1)
  if (!latest) return null
  const full = await ipc.invokeWithProjectSession(session, 'db:review-get-full', latest.id, session.projectPath)
  // 确认后的清单另存为一份审稿，复验周期挂在它指向的原始审稿上。
  const cycleReviewId = parseHumanConfirmedReviewSnapshot(full?.content ?? '')?.sourceReviewId ?? latest.id
  const cycle = await ipc.invokeWithProjectSession(session, 'db:review-cycle-get', cycleReviewId, session.projectPath).catch(() => null)
  return { createdAt: latest.createdAt, cycleStatus: cycle?.revisionStatus ?? null }
}

async function readChapterFacts(draftId: number, session: ProjectSessionContext): Promise<ChapterFacts> {
  const path = session.projectPath
  const [revisions, reviews] = await Promise.all([
    ipc.invokeWithProjectSession(session, 'db:revision-list', draftId, path),
    ipc.invokeWithProjectSession(session, 'db:review-list', draftId, path),
  ])
  const pending = revisions.filter(revision => revision.status === 'pending')
  // 只有有待合并修稿时才读正文：判断修稿生成之后这一稿的保存内容变没变。
  const [draft, sources, latestReview] = await Promise.all([
    pending.length > 0 ? ipc.invokeWithProjectSession(session, 'db:draft-get-full', draftId, path) : null,
    Promise.all(pending.map(revision => ipc.invokeWithProjectSession(session, 'db:revision-get-full', revision.id, path))),
    readLatestReview(reviews, session),
  ])
  const current = draft ? pending.filter((_, index) => isRevisionSourceCurrent(sources[index]?.sourceDraft, draft)) : []
  const merged = revisions.filter(revision => revision.status === 'merged').map(revision => revision.updatedAt).sort()
  return {
    mergeable: current.map(revision => revision.id),
    stale: pending.filter(revision => !current.includes(revision)).map(revision => revision.id),
    latestReview,
    lastMergedAt: merged.at(-1) ?? null,
  }
}

let sequence = 0
const latestRequest = new Map<number, number>()

/**
 * 重读这几稿的审稿与修稿记录，写进 stage-store 的 chapterFacts。流程脊（打开作品与每次刷新）和单章视图（打开、合并、
 * 丢弃修稿、保存了有待合并修稿的稿）都调它，所以两边看到的是同一份。同一稿只认最后一次请求；读失败的稿保留原值。
 */
export async function refreshChapterFacts(drafts: readonly { id: number }[], session: ProjectSessionContext): Promise<void> {
  const requests = drafts.map(draft => {
    const request = ++sequence
    latestRequest.set(draft.id, request)
    return { id: draft.id, request }
  })
  const results = await Promise.all(requests.map(({ id }) => readChapterFacts(id, session).catch(() => null)))
  if (!sameProjectSessionContext(session, getActiveProjectSessionContext())) return
  useStageStore.setState(state => {
    const byDraft = state.chapterFacts && sameProjectSessionContext(state.chapterFacts.session, session) ? { ...state.chapterFacts.byDraft } : {}
    requests.forEach(({ id, request }, index) => {
      const facts = results[index]
      if (facts && latestRequest.get(id) === request) byDraft[id] = facts
    })
    return { chapterFacts: { session, byDraft } }
  })
}
