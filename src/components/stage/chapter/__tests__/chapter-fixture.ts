import { vi } from 'vitest'
import type { ModelProfile, ProjectData } from '../../../../shared/ipc-channels'
import type { ReviewCycleProjection } from '../../../../shared/review-cycle'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'

export const PROJECT_PATH = 'C:\\novels\\chapter-view'
export const SESSION = Object.freeze({ projectId: 'chapter-view', leaseId: 'chapter-view-lease', projectPath: PROJECT_PATH })

export const BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 3,
  title: '雨夜车站',
  role: '发展',
  purpose: '让林舟确认匿名信不是恶作剧。',
  keyEvents: '最后一班列车晚点；第三节车厢的门开了。',
  characters: ['林舟', '老周'],
  suspenseHook: '',
  userGuidance: '前半章只写声音。',
  notes: '',
  notesUpdatedAt: '',
}

export const ORIGINAL = [
  '雨从傍晚开始就没有停过。',
  '最后一班列车晚点了十七分钟。广播里的女声重复着同一句道歉。',
  '他第三次展开信纸。',
  '他想起母亲说过，这座车站在三十年前就该拆了。',
].join('\n\n')

export const REVISED = [
  '雨从傍晚开始就没有停过。',
  '最后一班列车晚点了十七分钟，广播里的道歉一遍遍落进空站台。',
  '他第三次展开信纸。',
  '他想起旧报纸上说过，这座车站在三十年前就该拆了。',
].join('\n\n')

export const AI_REVIEW = JSON.stringify({
  summary: '节奏偏慢，有一处前后矛盾。',
  items: [
    { category: '前后矛盾', severity: 'error', description: '第 2 章写明母亲在他出生前离开。', quote: '他想起母亲说过，这座车站在三十年前就该拆了。' },
    { category: '节奏', severity: 'warning', description: '晚点与道歉两句信息重叠。' },
    { category: '本章必现', severity: 'unknown', description: '「不要回头」的伏笔是否回收，由你决定。' },
    { category: '措辞', severity: 'pass', description: '语言自然。' },
  ],
})

type Status = 'draft' | 'revised' | 'finalized' | 'archived'

interface Draft { id: number; chapterNumber: number; version: number; status: Status; content: string; createdAt: string; updatedAt: string }
interface Review { id: number; baseDraftId: number; reviewIndex: number; content: string; source: Draft }
interface Revision { id: number; baseDraftId: number; revisionIndex: number; revisionType: 'refine' | 'review-fix'; status: 'pending' | 'merged'; content: string; source: Draft }

/**
 * 一章的假数据库：草稿、审稿、修稿、复验周期与后处理，按主进程的通道语义回答。
 * 测试改它的状态来摆出各个阶段，再读 calls 里的写入断言界面交给了主进程什么。
 */
export function createChapterBackend() {
  const state = {
    drafts: [] as Draft[],
    reviews: [] as Review[],
    revisions: [] as Revision[],
    cycles: new Map<number, ReviewCycleProjection>(),
    postProcess: null as null | { steps: { stepKey: string; label: string; ok: boolean; errorMsg?: string; attemptCount?: number }[] },
    nextId: 100,
    mergeDisposition: 'required' as 'required' | 'not-required',
    calls: [] as { channel: string; args: unknown[] }[],
  }
  const meta = (draft: Draft) => ({
    id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version, status: draft.status, source: 'write',
    wordCount: draft.content.length, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
  })
  const source = (draft: Draft) => ({ id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version, status: draft.status, content: draft.content })
  const byId = (id: unknown) => state.drafts.find(draft => draft.id === Number(id))

  const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    state.calls.push({ channel, args })
    switch (channel) {
      case 'db:blueprint-get-all': return [BLUEPRINT]
      case 'db:blueprint-get': return Number(args[0]) === BLUEPRINT.chapterNumber ? BLUEPRINT : null
      case 'db:draft-get-meta': { const draft = byId(args[0]); return draft ? meta(draft) : null }
      case 'db:draft-list': return state.drafts.filter(draft => draft.chapterNumber === Number(args[0])).map(meta)
      case 'db:draft-list-all': return state.drafts.map(meta)
      case 'db:draft-get-full': { const draft = byId(args[0]); return draft ? { ...meta(draft), content: draft.content } : null }
      case 'db:draft-update-content': {
        const draft = byId(args[0])
        if (draft) draft.content = String(args[1])
        return { success: Boolean(draft) }
      }
      case 'db:draft-delete': {
        state.drafts = state.drafts.filter(draft => draft.id !== Number(args[0]))
        return { success: true }
      }
      case 'db:review-list': return state.reviews.filter(review => review.baseDraftId === Number(args[0])).map(({ content: _content, source: _source, ...rest }) => ({ ...rest, contentId: rest.id, createdAt: '2026-10-13 21:14:00' }))
      case 'db:review-get-latest':
      case 'db:review-get-full': {
        const review = channel === 'db:review-get-full'
          ? state.reviews.find(candidate => candidate.id === Number(args[0]))
          : state.reviews.filter(candidate => candidate.baseDraftId === Number(args[0])).at(-1)
        return review ? { id: review.id, baseDraftId: review.baseDraftId, reviewIndex: review.reviewIndex, contentId: review.id, createdAt: '2026-10-13 21:14:00', content: review.content, sourceDraft: source(review.source) } : null
      }
      case 'db:review-cycle-get': return state.cycles.get(Number(args[0])) ?? null
      case 'db:review-next-index': return state.reviews.filter(review => review.baseDraftId === Number(args[0])).length + 1
      case 'db:review-create': {
        const request = args[0] as { baseDraftId: number; reviewIndex: number; content: string }
        const draft = byId(request.baseDraftId)!
        const id = ++state.nextId
        state.reviews.push({ id, baseDraftId: request.baseDraftId, reviewIndex: request.reviewIndex, content: request.content, source: { ...draft } })
        return { success: true, id, reviewIndex: request.reviewIndex }
      }
      case 'db:revision-get-pending': return state.revisions.filter(revision => revision.baseDraftId === Number(args[0]) && revision.status === 'pending')
        .map(({ content: _content, source: _source, ...rest }) => ({ ...rest, mergedToDraftId: null, userPrompt: '', reviewSourceId: null, contentId: rest.id, wordCount: 0, createdAt: '', updatedAt: '' }))
      case 'db:revision-get-full': {
        const revision = state.revisions.find(candidate => candidate.id === Number(args[0]))
        return revision ? { ...revision, mergedToDraftId: null, userPrompt: '', reviewSourceId: null, contentId: revision.id, wordCount: 0, createdAt: '', updatedAt: '', sourceDraft: source(revision.source) } : null
      }
      case 'db:revision-merge': {
        const request = args[0] as { revisionId: number; targetDraftId: number; mergedContent: string }
        const draft = byId(request.targetDraftId)!
        const revision = state.revisions.find(candidate => candidate.id === request.revisionId)!
        draft.content = request.mergedContent
        draft.status = 'revised'
        revision.status = 'merged'
        return { success: true, receipt: {
          revisionId: revision.id, targetDraftId: draft.id, status: 'revised', wordCount: request.mergedContent.length, idempotent: false,
          chapterNumber: draft.chapterNumber, version: draft.version,
          reviewCycle: { cycleId: 'cycle-1', mergedHash: 'b'.repeat(64), disposition: state.mergeDisposition },
        } }
      }
      case 'db:post-process-get-latest-run': return state.postProcess ? { id: 'run-1', sourceLabel: '第3章定稿', createdAt: '', updatedAt: '', allCriticalPassed: false } : null
      case 'db:post-process-get-steps': return state.postProcess?.steps.map(step => ({ critical: false, completedAt: step.ok ? '2026-10-13 22:00:00' : '', ...step })) ?? []
      case 'db:consistency-exemption-list': return []
      case 'db:character-get-all': return [{ id: 1 }]
      case 'db:draft-authority-sequence': return { status: 'continuous', lastChapterNumber: 2, nextChapterNumber: 3, duplicateChapterNumbers: [], authorityFingerprint: 'e'.repeat(64) }
      case 'db:draft-get-finalized': return { chapterNumber: Number(args[0]) }
      case 'db:draft-get-max-finalized-chapter': return Math.max(0, ...state.drafts.filter(draft => draft.status === 'finalized').map(draft => draft.chapterNumber))
      case 'db:continuity-list-before': return []
      case 'fs:read-json': return { success: false }
      case 'fs:write-json': return { success: true }
      default: throw new Error(`unexpected IPC ${channel}`)
    }
  })

  const install = () => Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })

  const addDraft = (fields: Partial<Draft> & Pick<Draft, 'status'>): Draft => {
    const draft: Draft = { id: ++state.nextId, chapterNumber: 3, version: 1, content: ORIGINAL, createdAt: '2026-10-13 20:00:00', updatedAt: '2026-10-13 20:00:00', ...fields }
    state.drafts.push(draft)
    return draft
  }
  const addReview = (draft: Draft, content = AI_REVIEW): Review => {
    const review: Review = { id: ++state.nextId, baseDraftId: draft.id, reviewIndex: 1, content, source: { ...draft } }
    state.reviews.push(review)
    return review
  }
  const addRevision = (draft: Draft, revisionType: Revision['revisionType'] = 'review-fix'): Revision => {
    const revision: Revision = { id: ++state.nextId, baseDraftId: draft.id, revisionIndex: 1, revisionType, status: 'pending', content: REVISED, source: { ...draft } }
    state.revisions.push(revision)
    return revision
  }
  const writes = (channel: string) => state.calls.filter(call => call.channel === channel).map(call => call.args)

  return { state, invoke, install, addDraft, addReview, addRevision, writes }
}

export function chapterProject(): ProjectData {
  return {
    id: SESSION.projectId,
    sessionLease: SESSION.leaseId,
    name: '雨夜列车',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 24, wordsPerChapter: 3000,
      plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '雨夜列车', worldSetting: '',
      goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

export function generationModel(id: string): ModelProfile {
  return {
    id, name: id.toUpperCase(), provider: 'custom', protocol: 'openai', modelName: id, apiKey: 'test-only-key',
    baseUrl: 'https://models.example/v1', temperature: 0.7, maxTokens: 4096, purposes: ['generation'],
  }
}
