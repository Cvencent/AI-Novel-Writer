import { ipc } from '../../services/ipc-client'
import { confirmationSourceReviewId, parseHumanConfirmedReviewSnapshot } from '../../shared/human-confirmed-review'
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

/** 过期的原因（issue #126）。**先看正文，再看稿状态**——两件事不能合成一个说法。 */
export type StaleRevisionReason = 'edited' | 'finalized' | 'unsourced'

/**
 * 为什么这份修稿不能合并（issue #126）。
 *
 * 旧实现只要五个字段有一个不等就一律归成 `edited`，而 `edited` 的文案写的是
 * 「修稿生成之后**正文又改过**」。但定稿会把 `status` 从 `draft` 改成 `finalized`，
 * 于是「起草 → 修稿 → 定稿」这个很常见的顺序会让在途修稿被判成「正文被改过」：
 * 作者回去翻正文，一个字节都没变（实测 sha256 相同），只能怀疑自己记错。
 * `stage-progress.ts` 的注释其实已经写明有「正文改了」和「稿状态变了」两种触发，
 * 却在收口时合成一个 `edited`，到界面只剩前半句。
 *
 * 判据按**主次**排：正文不同才是「合并会覆盖改动」，这是唯一需要作者警惕的一条；
 * 正文逐字相同、只有稿状态变成已定稿的，单独成一类，用不撒谎的说法讲清楚。
 */
export function staleRevisionReason(
  source: ExpectedDraftSource | null | undefined,
  draft: DraftIdentity,
): StaleRevisionReason | null {
  if (!source) return 'unsourced'
  // 先判内容：正文不同才是「合并会覆盖改动」，这是唯一需要作者警惕的一条。
  if (source.content !== draft.content) return 'edited'
  // 正文逐字相同、只有稿状态变了：定稿单独成一类，别赖到正文上。
  if (source.status !== draft.status) return draft.status === 'finalized' ? 'finalized' : 'edited'
  // 其余字段（id/章节/版本）只要有一处不同，就说明这一稿已不是同一份源稿；
  // 全部相同才返回 null——**可合并**。这里必须显式返回 null，不能把「可合并」
  // 也归进某一档过期原因（否则在途修稿会被整体判成不能合并）。
  if (source.id !== draft.id || source.chapterNumber !== draft.chapterNumber
    || source.version !== draft.version) return 'edited'
  return null
}

async function readLatestReview(reviews: readonly { id: number; reviewIndex: number; createdAt: string }[], session: ProjectSessionContext) {
  const latest = [...reviews].sort((a, b) => a.reviewIndex - b.reviewIndex).at(-1)
  if (!latest) return null
  const full = await ipc.invokeWithProjectSession(session, 'db:review-get-full', latest.id, session.projectPath)
  const cycleReviewId = confirmationSourceReviewId(parseHumanConfirmedReviewSnapshot(full?.content ?? ''), latest.id)
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
  // 每份待合并修稿只判一次「能不能合并、不能是为什么」，可合并（原因 null）进 mergeable，
  // 其余进 stale——两处用同一个函数，分类与文案不会再各说一套（issue #126）。
  const verdicts = pending.map((revision, index) => (
    draft ? { revision, reason: staleRevisionReason(sources[index]?.sourceDraft, draft) }
      : { revision, reason: 'unsourced' as const }
  ))
  const merged = revisions.filter(revision => revision.status === 'merged').map(revision => revision.updatedAt).sort()
  return {
    mergeable: verdicts.filter(item => item.reason === null).map(item => item.revision.id),
    stale: verdicts.flatMap(item => item.reason === null ? [] : [{ id: item.revision.id, reason: item.reason }]),
    latestReview,
    lastMergedAt: merged.at(-1) ?? null,
  }
}

let sequence = 0
const latestRequest = new Map<number, number>()

/**
 * 重读这几稿的审稿与修稿记录，写进 stage-store 的 chapterFacts。流程脊（打开作品与每次刷新）和单章视图（打开、合并、
 * 丢弃修稿、保存了有待合并修稿的稿）都调它，所以两边看到的是同一份。同一稿只认最后一次请求，但还没有记录的稿先收下
 * 较早请求的结果：打开作品时单章视图对落点那一章的读取会取代流程脊那批里的同一稿，流程脊不能因此缺这一章。读失败的稿保留原值。
 */
export async function refreshChapterFacts(drafts: readonly { id: number }[], session: ProjectSessionContext): Promise<void> {
  const requests = drafts.map(draft => {
    const request = ++sequence
    latestRequest.set(draft.id, request)
    return { id: draft.id, request }
  })
  // 一次刷新可能是几百份在途稿；无上限 Promise.all 会瞬间向主进程灌上千个
  // IPC（每稿 3-5 个读取），主进程单线程直接排队到未响应。
  const FACTS_READ_CONCURRENCY = 8
  const results: Array<ChapterFacts | null> = new Array(requests.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(FACTS_READ_CONCURRENCY, requests.length) }, async () => {
    while (cursor < requests.length) {
      const index = cursor++
      results[index] = await readChapterFacts(requests[index].id, session).catch(() => null)
    }
  }))
  if (!sameProjectSessionContext(session, getActiveProjectSessionContext())) return
  useStageStore.setState(state => {
    const byDraft = state.chapterFacts && sameProjectSessionContext(state.chapterFacts.session, session) ? { ...state.chapterFacts.byDraft } : {}
    requests.forEach(({ id, request }, index) => {
      const facts = results[index]
      if (facts && (latestRequest.get(id) === request || !(id in byDraft))) byDraft[id] = facts
    })
    return { chapterFacts: { session, byDraft } }
  })
}
