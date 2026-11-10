import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { ReviewRepository } from '../../repositories/review-repository'
import { RevisionRepository } from '../../repositories/revision-repository'
import { ReviewCycleRepository } from '../../repositories/review-cycle-repository'
import { createHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { getProjectDb } from '../../database'
import { textHash } from '../../repositories/generation-run-repository'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import type { PrepareReviewRevisionRequest } from '../../../src/shared/review-revision-generation'
import { verifyM03ReviewCycle } from '../../migrations/m03-review-cycle'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { selectFrozenReviewRevisionMaterials } from '../../../src/services/workflows/commands/review-revision-materials'
import { RefineFromReviewCommand } from '../../../src/services/workflows/commands/refine-from-review.command'
import { useProjectStore } from '../../../src/stores/project-store'
import { useEditorStore } from '../../../src/stores/editor-store'
import type { WorkflowContext } from '../../../src/stores/workflow-store'
import * as reviewRevisionMaterials from '../../../src/shared/review-revision-generation'

vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn(() => null) }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: null }) })
const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
const revisedProse = prose.replace('灯火', '月光')
const report = JSON.stringify({ summary: '检查完成', items: [{ category: '表达', severity: 'warning', description: '补充动作细节', quote: '林岚走进北塔' }] })
const materialDecision = (prompt: string): NonNullable<BeginGenerationRequest['materialDecision']> => ({
  version: 1, verdict: 'admitted', promptHash: textHash(prompt),
  capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 0 },
  coverage: { required: 0, included: 0, complete: true }, included: [], omitted: [],
})
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/review-revision-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  let db = new Database(path.join(root, 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
  db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const loadModel = (id: string) => id === model.id ? model : id === 'revision-model'
    ? { ...model, id, modelName: 'gpt-4.1-mini', maxTokens: 1024 } : null
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => { options.onVisible({ kind: 'delta', text: report }); return { finishReason: 'stop', usage: null } }))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: () => '冻结的合成提示词' }
  const makeOwner = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel }), loadModel, dispatch: spy,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  const owner = makeOwner('epoch-1')
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const prepare = (operation: PrepareReviewRevisionRequest['operation'] = 'review-chapter') => owner.prepareReviewRevision({ operation, draftId: 1, expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) }, authorInputs: [], uiLocale: 'zh-CN' })
  const selection = (prepared: ReturnType<typeof prepare>): BeginGenerationRequest => ({ operation: prepared.context.operation, uiActionNonce: 'action', modelId: model.id, chapterNumber: 1, selectedDraftIds: [1], selectedFinalizedDraftIds: [], promptKeys: [prepared.context.operation === 'review-chapter' ? 'consistency_check' : prepared.context.operation === 'refine-draft' ? 'refine_chapter' : 'refine_from_review'], skillStages: [prepared.context.operation === 'review-chapter' ? 'review' : 'refinement'], output: prepared.context.operation === 'review-chapter' ? 'structured-data' : 'visible-text', reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }], ...(prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId } : {}) })
  const run = async (operation: PrepareReviewRevisionRequest['operation'] = 'review-chapter') => {
    const prepared = prepare(operation), begin = selection(prepared), view = owner.begin(begin)
    const prompt = '检查冻结正文'
    owner.bindMaterialDecision(view.handle, materialDecision(prompt))
    const result = await owner.execute({ handle: view.handle, invocationNonce: 'request', task: { purpose: operation, output: begin.output, messages: [{ role: 'user', content: prompt }] } })
    const artifact = result.run.artifacts.at(-1)!
    return { contextId: prepared.contextId, handle: view.handle, artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } }
  }
  const reopenStorage = () => { db.close(); db = new Database(path.join(root, 'project.db')); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); return makeOwner('epoch-2') }
  return { get db() { return db }, owner, makeOwner, reopenStorage, prepare, selection, run, spy, deps }
}
describe('review and revision generation through the actual owner and SQLite', () => {
  it.each([
    'Here is the truth: I never left the island. Everyone who said otherwise was lying.',
    '以下是我从父亲遗物中找到的最后一份内容。它改变了我们所有人的命运。',
  ].flatMap(opening => ['commit', 'recovery'].map(path => ({ opening, path }))))(
    'accepts narrative prose unchanged on $path: $opening', async ({ opening, path }) => {
      const content = `${opening}\n\n${revisedProse}`
      const f = fixture(async (_request, options) => {
        options.onVisible({ kind: 'delta', text: content }); return { finishReason: 'stop', usage: null }
      })
      const request = await f.run('refine-draft')
      const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(content), 'visible-append-v1')
      if (path === 'commit') {
        const saved = f.owner.commitRevision({ contextId: request.contextId, handle: request.handle,
          expectedCompositionHash: composition.textHash })
        expect(RevisionRepository.getFull(saved.id, f.db)?.content).toBe(content)
        return
      }
      f.owner.suspendForProjectClose()
      const reopened = f.reopenStorage()
      try {
        const resumed = await reopened.resume(request.handle)
        const recovery = reopened.readReviewRevisionRecovery(resumed.handle)
        expect(recovery).toMatchObject({ canResume: true, sourceStatus: 'current', lastCompositionFinishReason: 'stop' })
        const saved = reopened.commitRevision({ contextId: recovery.contextId!, handle: resumed.handle,
          expectedCompositionHash: composition.textHash })
        expect(saved.content).toBe(content)
        expect(RevisionRepository.getFull(saved.id, f.db)?.content).toBe(content)
        expect(reopened.readReviewRevisionRecovery(resumed.handle).saved?.content).toBe(content)
        expect(f.spy).toHaveBeenCalledTimes(1)
      } finally { reopened.suspendForProjectClose() }
    },
  )

  it.each(['以下是修订后的完整正文：', '以下是修订后的完整章节正文：', 'Here is the revised chapter:'])(
    'rejects explicit output introductions on commit and recovery: %s', async opening => {
      const content = `${opening}\n\n${revisedProse}`
      const f = fixture(async (_request, options) => {
        options.onVisible({ kind: 'delta', text: content }); return { finishReason: 'stop', usage: null }
      })
      const request = await f.run('refine-draft')
      const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(content), 'visible-append-v1')
      expect(() => f.owner.commitRevision({ contextId: request.contextId, handle: request.handle,
        expectedCompositionHash: composition.textHash })).toThrow('首段元话术')
      expect(f.owner.readReviewRevisionRecovery(request.handle).canResume).toBe(false)
      expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
      expect(f.owner.read(request.handle).candidates?.[0]?.text).toBe(content)
    },
  )

  it.each([1, 2] as const)('reopens long saved reports with report version %i and refuses a changed version', async version => {
    const output = { summary: '🌙'.repeat(121) + '保留结论', items: [{ category: '表达', severity: 'pass',
      description: '已经核对的原文。'.repeat(30) + '但这只是猜测，不应修改。', quote: prose }],
      goalReviews: [{ id: 'ch1:keyEvents:1', status: 'completed', description: '进入北塔。', evidence: [{ quote: prose }] }] }
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: JSON.stringify(output) }); return { finishReason: 'stop', usage: null }
    })
    f.db.prepare('UPDATE blueprints SET key_events=? WHERE chapter_number=1').run('林岚走进北塔')
    const request = await f.run(), saved = f.owner.commitReview(request)
    const parsed = JSON.parse(saved.content)
    expect(parsed.summary).toBe(output.summary)
    expect(parsed.items[0]).toEqual(output.items[0])
    const row = f.db.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts').get() as {
      attempt_id: string; usage_receipt_json: string }
    const usage = JSON.parse(row.usage_receipt_json)
    expect(usage.reviewRevisionEffect.reportVersion).toBe(2)
    let expected = saved
    if (version === 1) {
      // Retained v1 bytes are constructed independently of the new parser.
      const legacy = JSON.parse(saved.content)
      legacy.summary = Array.from(output.summary).slice(0, 120).join('')
      legacy.items[0].description = Array.from(output.items[0]!.description).slice(0, 200).join('')
      legacy.items[0].quote = Array.from(prose).slice(0, 160).join('')
      const content = JSON.stringify(legacy, null, 2), contentHash = textHash(content)
      delete usage.reviewRevisionEffect.reportVersion
      usage.reviewRevisionEffect.contentHash = contentHash
      f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run(content, saved.id)
      f.db.prepare('UPDATE review_cycles SET review_content_hash=? WHERE review_id=?').run(contentHash, saved.id)
      f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), row.attempt_id)
      expected = { ...saved, content, contentHash }
    }
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    try {
      expect(reopened.readReviewRevisionRecovery(request.handle).saved).toEqual(expected)
      expect(reopened.commitReview(request)).toEqual(expected)
      expect(verifyM03ReviewCycle(f.db)).toBe(true)
      expect(f.spy).toHaveBeenCalledTimes(1)
      for (const changedVersion of [version === 1 ? 2 : undefined, 3]) {
        const changed = structuredClone(usage)
        if (changedVersion === undefined) delete changed.reviewRevisionEffect.reportVersion
        else changed.reviewRevisionEffect.reportVersion = changedVersion
        f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(changed), row.attempt_id)
        expect(() => reopened.readReviewRevisionRecovery(request.handle)).toThrow('GENERATION_REVIEW_RECEIPT_INVALID')
        expect(verifyM03ReviewCycle(f.db)).toBe(false)
      }
    } finally { reopened.suspendForProjectClose() }
  })

  it('explicitly refuses recovery of the old combined blueprint material hash while retaining its artifact', async () => {
    const current = reviewRevisionMaterials.reviewRevisionAuthorMaterial
    const legacy = vi.spyOn(reviewRevisionMaterials, 'reviewRevisionAuthorMaterial').mockImplementation(context => current(context).replace([
      '【本章作者指导｜约束】', JSON.stringify(context.blueprints.filter(item => item.chapterNumber === context.source.chapterNumber), null, 2),
      '【后续蓝图/计划｜非既定历史】', JSON.stringify(context.blueprints.filter(item => item.chapterNumber !== context.source.chapterNumber), null, 2),
    ].join('\n\n'), ['【当前及未来蓝图/计划｜非既定历史】', JSON.stringify(context.blueprints, null, 2)].join('\n\n')))
    const f = fixture(), prepared = f.prepare(), selection = f.selection(prepared)
    const admission = await selectFrozenReviewRevisionMaterials(prepared.context, { projectId: 'project', epoch: 'epoch-1' })
    const prompt = admission.admitted.map(item => item.text).join('\n\n')
    expect(prompt).toContain('【当前及未来蓝图/计划｜非既定历史】')
    const view = f.owner.begin(selection)
    f.owner.bindMaterialDecision(view.handle, { ...admission.decision, promptHash: textHash(prompt) })
    await f.owner.execute({ handle: view.handle, invocationNonce: 'old-material', task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: prompt }] } })
    const artifact = f.owner.read(view.handle).artifacts[0]!
    legacy.mockRestore()
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    expect(reopened.readReviewRevisionRecovery(view.handle)).toMatchObject({ sourceStatus: 'conflict', canResume: false })
    await expect(reopened.resume(view.handle)).rejects.toThrow('GENERATION_MATERIAL_DECISION_INVALID')
    expect(reopened.read(view.handle).candidates?.[0]?.text).toBe(artifact.text)
    expect(f.spy).toHaveBeenCalledTimes(1)
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
  })
  it.each(['revision-model', 'synthetic', undefined])('uses the selected revision model %s through the real command and retains it on recovery', async selectedModelId => {
    let invocation = 0
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: ++invocation === 1 ? report : revisedProse })
      return { finishReason: 'stop', usage: { promptTokens: 60, completionTokens: 40, totalTokens: 100,
        reasoningTokens: 0, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true } }
    })
    const original = await f.run(), saved = f.owner.commitReview(original)
    const content = serializeHumanConfirmedReviewSnapshot(createHumanConfirmedReviewSnapshot({ sourceReviewId: saved.id,
      sourceDraft: saved.source, summary: '确认修稿', authorGuidance: '保留原文', items: [{ category: '表达',
        severity: 'warning', description: '补充动作细节', decision: 'apply', origin: 'ai' }] })!)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: saved.source }, f.db)
    const projectPath = f.deps.projectStorageRoot
    const projectSession = { projectId: 'project', projectPath, leaseId: 'epoch-1' }
    useProjectStore.setState({ currentProject: { id: 'project', path: projectPath, name: '合成', sessionLease: 'epoch-1' } as never })
    useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
    let failSave = true
    let failDispatch = true
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      const input = args[0]
      switch (channel) {
        case 'review-revision:prepare': return f.owner.prepareReviewRevision(input as PrepareReviewRevisionRequest)
        case 'review-revision:read-recovery': return f.owner.readReviewRevisionRecovery((input as { handle: typeof original.handle }).handle)
        case 'review-revision:commit-revision':
          if (failSave) { failSave = false; throw new Error('SYNTHETIC_SAVE_ACK_FAILURE') }
          return f.owner.commitRevision(input as Parameters<typeof f.owner.commitRevision>[0])
        case 'generation:begin': return f.owner.begin(input as BeginGenerationRequest)
        case 'generation:read': return f.owner.read(input as typeof original.handle)
        case 'generation:resume': return f.owner.resume(input as typeof original.handle)
        case 'generation:execute':
          if (failDispatch) { failDispatch = false; throw new Error('SYNTHETIC_BEFORE_DISPATCH') }
          return f.owner.execute(input as Parameters<typeof f.owner.execute>[0])
        case 'generation:bind-material-decision': {
          const request = input as { handle: typeof original.handle; materialDecision: Parameters<typeof f.owner.bindMaterialDecision>[1] }
          return f.owner.bindMaterialDecision(request.handle, request.materialDecision)
        }
        case 'generation:read-visible-composition': return f.owner.readVisibleComposition(input as typeof original.handle)
        case 'generation:compose-visible': return f.owner.composeVisible(input as typeof original.handle, args[1] as string[], args[2] as string)
        case 'prompt:load-global': return { templates: [], diagnostics: [] }
        case 'fs:check-exists': return false
        default: throw new Error(`Unexpected test IPC: ${channel}`)
      }
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })
    const context: WorkflowContext = { runId: 'selected-revision', projectPath, projectSession,
      generationModelId: selectedModelId, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false }
    const callbacks = { log: vi.fn(), appendText: vi.fn(), replaceText: vi.fn(), setProgress: vi.fn() }
    const command = new RefineFromReviewCommand({ draftPath: 'ai-novel://draft/1', draftContent: prose,
      chapterNumber: 1, sourceDraft: { ...saved.source, contentRevision: 1 }, reviewSourceId: confirmation.id,
      confirmedReviewContent: content, userRefinePrompt: '' })
    const expectedModel = selectedModelId ?? 'synthetic'
    await expect(command.execute({ context, callbacks, step: {} })).rejects.toThrow('SYNTHETIC_BEFORE_DISPATCH')
    const handle = context.mainGenerationRunHandle!
    expect(f.owner.readReviewRevisionRecovery(handle).modelId).toBe(expectedModel)
    context.generationModelId = expectedModel === 'synthetic' ? 'revision-model' : 'synthetic'
    await expect(command.execute({ context, callbacks, step: {} })).rejects.toThrow('SYNTHETIC_SAVE_ACK_FAILURE')
    expect(f.spy.mock.calls.map(([request]) => (request as { model: ModelProfile }).model.id)).toEqual(['synthetic', expectedModel])
    const revisionRequest = f.spy.mock.calls[1]![0] as { model: ModelProfile }
    expect(revisionRequest.model.maxTokens).toBe(expectedModel === 'revision-model' ? 1024 : 2048)
    // issue #243 ③：confirmation 修稿开新 root（不再挂审稿 run 的 root）。
    expect(handle.rootActionId).not.toBe(original.handle.rootActionId)
    // ③ 后修稿独立 root：原 root 的审稿请求不再计入修稿 ledger；两次注入失败
    // （before-dispatch 不占额、save-ack 后结算保留）后成功一次 = 1。
    expect(f.owner.read(handle).ledger).toMatchObject({ physicalRequests: 1, tokenLiability: 100 })
    expect(f.owner.readReviewRevisionRecovery(handle).modelId).toBe(expectedModel)
    context.generationModelId = expectedModel === 'synthetic' ? 'revision-model' : 'synthetic'
    await expect(command.execute({ context, callbacks, step: {} })).resolves.toBe(revisedProse)
    expect(context.generationModelId).toBe(expectedModel)
    expect(f.spy).toHaveBeenCalledTimes(2)
    expect(f.owner.readReviewRevisionRecovery(handle).saved?.content).toBe(revisedProse)
    expect(f.db.prepare('SELECT review_source_id FROM revisions').pluck().get()).toBe(confirmation.id)
  })
  it('captures only the saved predecessor bound by the source draft and rejects changed predecessor bytes', () => {
    const f = fixture()
    f.db.exec('UPDATE drafts SET chapter_number=2 WHERE id=1')
    f.db.prepare('INSERT INTO contents(id,body) VALUES(2,?)').run('已选前驱：钥匙已经交出。')
    f.db.prepare('INSERT INTO contents(id,body) VALUES(3,?)').run('未选版本：钥匙仍在手中。')
    f.db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(2,1,1,'draft',2,10),(3,1,2,'draft',3,10)")
    f.db.prepare('UPDATE drafts SET source_dependencies=? WHERE id=1').run(JSON.stringify([{ kind: 'candidate', draftId: 2, contentHash: textHash('已选前驱：钥匙已经交出。') }]))
    const request: PrepareReviewRevisionRequest = { operation: 'review-chapter', draftId: 1,
      expectedDraft: { chapterNumber: 2, version: 1, status: 'draft', contentHash: textHash(prose) }, authorInputs: [], uiLocale: 'zh-CN' }
    const frozen = f.owner.prepareReviewRevision(request).context
    expect(frozen.predecessor).toMatchObject({ draftId: 2, content: '已选前驱：钥匙已经交出。',
      identity: { sourceId: 'candidate:2', revision: 1, provenance: 'generated' } })
    expect(JSON.stringify(frozen)).not.toContain('未选版本：钥匙仍在手中。')
    f.db.exec("UPDATE contents SET body='前驱已被改动' WHERE id=2")
    expect(() => f.owner.prepareReviewRevision(request)).toThrow('GENERATION_REVIEW_HISTORY_CHANGED')
  })
  it('admits the renderer author-material receipt through main and retains the frozen recovery context', async () => {
    const f = fixture(), prepared = f.prepare(), selection = f.selection(prepared)
    const admission = await selectFrozenReviewRevisionMaterials(prepared.context, { projectId: 'project', epoch: 'epoch-1' })
    const prompt = admission.admitted.map(material => material.text).join('\n\n')
    const view = f.owner.begin(selection)
    f.owner.bindMaterialDecision(view.handle, { ...admission.decision, promptHash: textHash(prompt) })
    await f.owner.execute({ handle: view.handle, invocationNonce: 'materials', task: { purpose: 'review-chapter',
      output: 'structured-data', messages: [{ role: 'user', content: prompt }] } })
    expect(f.spy).toHaveBeenCalledTimes(1)
    expect(f.owner.readReviewRevisionRecovery(view.handle).context).toEqual(prepared.context)
  })
  it('requires main context and rejects forged context and hashes before dispatch', () => {
    const f = fixture(), selection = f.selection(f.prepare())
    expect(() => f.owner.begin({ ...selection, reviewRevisionContextId: undefined })).toThrow('GENERATION_REVIEW_CONTEXT_REQUIRED')
    expect(() => f.owner.begin({ ...selection, authorInputs: [{ id: 'review-revision-context', text: '{}' }] })).toThrow('GENERATION_REVIEW_CONTEXT_MISMATCH')
    // issue #174：错误码必须**指名**是哪一项不等——原来 11 项合取抛同一个码，
    // 现场（第 26 章审稿）主进程日志里只有 GENERATION_REVIEW_CONTEXT_MISMATCH，
    // 无从判断是哪一项，界面则空等 720 秒。
    expect(() => f.owner.begin({ ...selection, authorInputs: [{ id: 'review-revision-context', text: '{}' }] })).toThrow('GENERATION_REVIEW_CONTEXT_MISMATCH:authorInputs')
    expect(() => f.owner.begin({ ...selection, reviewRevisionContextHash: 'a'.repeat(64) } as BeginGenerationRequest)).toThrow()
    expect(f.spy).not.toHaveBeenCalled()
  })
  /**
   * issue #174：11 项合取抛同一个错误码，现场（第 26 章）无从判断是哪一项。
   * 改成检查表后必须做到两件事：**布尔结果与原来完全一致**（不多拦也不少拦），
   * 且错误码**指名**第一个不等的项。这条逐项扫一遍。
   */
  it('names the first failing field without changing which selections are rejected', () => {
    const f = fixture(), prepared = f.prepare(), selection = f.selection(prepared)
    const drift = (patch: Record<string, unknown>, expected: string) => {
      expect(() => f.owner.begin({ ...selection, ...patch } as BeginGenerationRequest)).toThrow(`GENERATION_REVIEW_CONTEXT_MISMATCH:${expected}`)
    }
    drift({ operation: 'refine-draft' }, 'operation')
    drift({ chapterNumber: 999 }, 'chapterNumber')
    drift({ promptKeys: ['refine_chapter'] }, 'promptKeys')
    drift({ skillStages: [] }, 'skillStages')
    drift({ output: 'visible-text' }, 'output')
    drift({ authorInputs: [{ id: 'review-revision-context', text: '{}' }] }, 'authorInputs')
    // ⚠️ parentRootActionId 这一项在 begin 路径上会先撞 GENERATION_ROOT_MISSING（更早的校验），
    // 所以这里不断言它——检查表里那一项仍在（对照脚本证明布尔等价）。
    drift({ batchId: 'batch' }, 'batchId')
    // 合法的那次仍然能过——检查表不许把正常请求也拦下来。
    expect(() => f.owner.begin(selection)).not.toThrow()
  })
  it.each([['bad-json', 'stop'], [report, 'length']] as const)('does not save an invalid or incomplete review (%s)', async (text, finishReason) => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason, usage: null } }), request = await f.run()
    expect(() => f.owner.commitReview(request)).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
  })
  // issue #26：8192 的审稿配额让report必然被截断、永远落不了库。上限提到实测够用的 24k 后，
// 正常长度的报告会以 finishReason='stop' 完成并照常落库（配额问题在 plan 层修，见
// main-generation-plan.test.ts）。这里锁住「截断产物仍不得作为正式审稿落库」这一不变量。
  it('keeps a length-terminated review candidate out of the reviews table (issue #26 invariant)', async () => {
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: report }); return { finishReason: 'length', usage: null }
    })
    const request = await f.run()
    await f.owner.execute({ handle: request.handle, invocationNonce: 'review-chapter',
      task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '检查冻结正文' }] } })
    const recovery = f.owner.readReviewRevisionRecovery(request.handle)
    expect(recovery.latestArtifactFinishReason).toBe('length')
    expect(recovery.saved).toBeUndefined()
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
    const artifact = recovery.latestArtifact!
    expect(() => f.owner.commitReview({ contextId: recovery.contextId ?? 'absent', handle: request.handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
  })

  it.each([['stop', report], ['stop', 'bad-json']] as const)(
    'keeps STOP save and rebuild behaviour unchanged (%s, %s)', async (finishReason, text) => {
      let calls = 0
      const f = fixture(async (_request, options) => {
        options.onVisible({ kind: 'delta', text }); return { finishReason: calls++ === 0 ? 'length' : finishReason, usage: null }
      })
      const request = await f.run()
      expect(f.owner.readReviewRevisionRecovery(request.handle)).toMatchObject({ canResume: true, sourceStatus: 'current' })
      const execute = (purpose: 'review-chapter' | 'review-chapter-rebuild') => f.owner.execute({ handle: request.handle,
        invocationNonce: purpose, task: { purpose, output: 'structured-data', messages: [{ role: 'user', content: '检查冻结正文' }] } })
      await execute('review-chapter')
      const recovery = f.owner.readReviewRevisionRecovery(request.handle)
      expect(recovery.attemptedPurposes).toEqual(['review-chapter', 'review-chapter'])
      expect(recovery.latestArtifactFinishReason).toBe(finishReason)
      expect(recovery.saved).toBeUndefined()
      expect(recovery.canResume).toBe(true)
      expect(recovery.contextId).toEqual(expect.any(String))
      const artifact = recovery.latestArtifact!
      const commit = { contextId: recovery.contextId!, handle: request.handle,
        artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } }
      if (text === report) {
        expect(f.owner.commitReview(commit)).toMatchObject({ success: true, kind: 'review' })
        expect(f.spy).toHaveBeenCalledTimes(2)
      } else {
        expect(() => f.owner.commitReview(commit)).toThrow()
        await execute('review-chapter-rebuild')
        expect(f.owner.readReviewRevisionRecovery(request.handle)).toMatchObject({ canResume: true,
          attemptedPurposes: ['review-chapter', 'review-chapter', 'review-chapter-rebuild'] })
        expect(f.spy).toHaveBeenCalledTimes(3)
      }
    },
  )
  it('saves a review once and replays its saved ACK', async () => {
    const f = fixture(), request = await f.run(), saved = f.owner.commitReview(request)
    expect(saved).toMatchObject({ success: true, kind: 'review' })
    expect(f.owner.commitReview(request)).toEqual(saved)
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(1)
    expect(f.db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(1)
    expect(f.db.prepare('SELECT COUNT(*) FROM review_findings').pluck().get()).toBe(2)
    expect(verifyM03ReviewCycle(f.db)).toBe(true)
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('rolls back the review and durable effect when cycle persistence fails, then retries the same artifact', async () => {
    const f = fixture(), request = await f.run()
    f.db.exec("CREATE TRIGGER fail_review_cycle BEFORE INSERT ON review_cycles BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CYCLE_FAILURE'); END")
    expect(() => f.owner.commitReview(request)).toThrow('SYNTHETIC_CYCLE_FAILURE')
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(0)
    expect(f.db.prepare("SELECT COUNT(*) FROM generation_attempts WHERE json_extract(usage_receipt_json,'$.reviewRevisionEffect') IS NOT NULL").pluck().get()).toBe(0)
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toBeUndefined()
    f.db.exec('DROP TRIGGER fail_review_cycle')
    expect(f.owner.commitReview(request)).toMatchObject({ success: true, kind: 'review' })
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(1)
    expect(f.db.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(1)
    expect(verifyM03ReviewCycle(f.db)).toBe(true)
  })
  it.each(['source', 'config'] as const)('rejects changed %s while preserving the candidate', async change => {
    const f = fixture(), request = await f.run()
    f.db.exec(change === 'source' ? "UPDATE contents SET body='作者新正文' WHERE id=1" : "UPDATE project_core SET global_guidance='作者新指导' WHERE id='main'")
    expect(() => f.owner.commitReview(request)).toThrow()
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
    expect(f.owner.readReviewRevisionRecovery(request.handle).sourceStatus).toBe('conflict')
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
  })
  it('rolls back the formal row and effect together, then retries the same revision candidate', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: revisedProse }); return { finishReason: 'stop', usage: null } })
    const request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(revisedProse), 'visible-append-v1')
    const commit = { contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash }
    const before = f.db.prepare('SELECT COUNT(*) FROM contents').pluck().get()
    f.db.exec("CREATE TRIGGER fail_effect BEFORE UPDATE OF usage_receipt_json ON generation_attempts BEGIN SELECT RAISE(ABORT,'SYNTHETIC_EFFECT_FAILURE'); END")
    expect(() => f.owner.commitRevision(commit)).toThrow('SYNTHETIC_EFFECT_FAILURE')
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM contents').pluck().get()).toBe(before)
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toBeUndefined()
    f.db.exec('DROP TRIGGER fail_effect')
    const saved = f.owner.commitRevision(commit)
    expect(saved).toMatchObject({ kind: 'revision', revisionStatus: 'pending', content: revisedProse })
    expect(f.owner.commitRevision(commit)).toEqual(saved)
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(1)
  })
  it('rejects a short revision despite a stop and a valid visible composition', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: '太短' }); return { finishReason: 'stop', usage: null } }), request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash('太短'), 'visible-append-v1')
    expect(() => f.owner.commitRevision({ contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash })).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
    const recovery = f.owner.readReviewRevisionRecovery(request.handle)
    expect(recovery.canResume).toBe(false)
    expect(recovery).not.toHaveProperty('contextId')
  })
  it('refuses to resume or commit a stop revision with an obviously duplicated paragraph', async () => {
    // Long enough and different from the source, but the same long paragraph appears twice.
    const paragraph = '\u6797\u5c9a\u8d70\u8fdb\u5317\u5854\uff0c\u6708\u5149\u7167\u4eae\u4e86\u77f3\u9636\u3002'.repeat(10)
    const duplicated = `${paragraph}\n\n${paragraph}`
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: duplicated }); return { finishReason: 'stop', usage: null } })
    const request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(duplicated), 'visible-append-v1')
    // The author reopens the run after the first execution rejected this exact composition.
    const recovery = f.owner.readReviewRevisionRecovery(request.handle)
    expect(recovery.lastCompositionFinishReason).toBe('stop')
    expect(recovery.canResume).toBe(false)
    expect(recovery).not.toHaveProperty('contextId')
    expect(() => f.owner.commitRevision({ contextId: request.contextId, handle: request.handle,
      expectedCompositionHash: composition.textHash })).toThrow('\u660e\u663e\u91cd\u590d\u6bb5\u843d')
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.db.prepare("SELECT COUNT(*) FROM generation_attempts WHERE json_extract(usage_receipt_json,'$.reviewRevisionEffect') IS NOT NULL")
      .pluck().get()).toBe(0)
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['identical', prose],
    ['format-only', `${prose}\n\u200b`],
  ])('rejects a %s revision before persisting a row or formal effect', async (_label, output) => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: output }); return { finishReason: 'stop', usage: null } })
    const request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(output.trim()), 'visible-append-v1')
    const beforeContents = f.db.prepare('SELECT COUNT(*) FROM contents').pluck().get()
    expect(() => f.owner.commitRevision({ contextId: request.contextId, handle: request.handle,
      expectedCompositionHash: composition.textHash })).toThrow('GENERATION_REVIEW_REVISION_NOOP')
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM contents').pluck().get()).toBe(beforeContents)
    expect(f.db.prepare("SELECT COUNT(*) FROM generation_attempts WHERE json_extract(usage_receipt_json,'$.reviewRevisionEffect') IS NOT NULL")
      .pluck().get()).toBe(0)
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
    const recovery = f.owner.readReviewRevisionRecovery(request.handle)
    expect(recovery.canResume).toBe(false)
    expect(recovery).not.toHaveProperty('contextId')
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('retains the saved review and frozen manifest after closing the owner and reopening a new epoch', async () => {
    const f = fixture(), request = await f.run(), saved = f.owner.commitReview(request)
    const before = f.owner.readReviewRevisionRecovery(request.handle).context
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    try {
      const recovery = reopened.readReviewRevisionRecovery(request.handle)
      expect(recovery.context).toEqual(before)
      expect(recovery.saved).toEqual(saved)
      expect(reopened.commitReview(request)).toEqual(saved)
      expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(1)
      expect(f.spy).toHaveBeenCalledTimes(1)
    } finally { reopened.suspendForProjectClose() }
  })
  it('derives review-fix lineage with portable NULL history and rejects malformed history', async () => {
    const f = fixture(), history = await f.run('refine-draft')
    const original = await f.run(), saved = f.owner.commitReview(original)
    // Portable export retains the attempt row while projecting its machine usage receipt to SQL NULL.
    f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=NULL WHERE run_id=?').run(history.handle.runId)
    const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: saved.id, sourceDraft: saved.source,
      summary: '作者确认', authorGuidance: '', items: [{ category: '表达', severity: 'warning',
        description: '补充动作', decision: 'apply', origin: 'author' }] })!
    const content = serializeHumanConfirmedReviewSnapshot(snapshot)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: saved.source }, f.db)
    const request: PrepareReviewRevisionRequest = { operation: 'refine-from-review', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) },
      authorInputs: [], uiLocale: 'zh-CN', reviewSourceId: confirmation.id, confirmedReviewContent: content }
    const prepared = f.owner.prepareReviewRevision(request)
    // issue #243 ③：confirmation 修稿开新 root——parent 不再返回审稿 root。
    expect(prepared.parentRootActionId).toBeUndefined()
    expect(prepared.modelId).toBe('synthetic')
    expect(f.spy).toHaveBeenCalledTimes(2)
    expect(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE run_id=?')
      .pluck().get(history.handle.runId)).toBeNull()
    f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE run_id=?').run('{', history.handle.runId)
    expect(() => f.owner.prepareReviewRevision(request)).toThrow(SyntaxError)
  })
  it('derives review-fix lineage from the saved original review and refuses confirmation changes', async () => {
    const f = fixture(), original = await f.run(), saved = f.owner.commitReview(original)
    const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: saved.id, sourceDraft: saved.source, summary: '作者确认', authorGuidance: '保持克制', items: [{ category: '表达', severity: 'warning', description: '补充动作', decision: 'apply', origin: 'ai' }] })
    const content = serializeHumanConfirmedReviewSnapshot(snapshot!)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: saved.source }, f.db)
    const request: PrepareReviewRevisionRequest = { operation: 'refine-from-review', draftId: 1, expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) }, authorInputs: [], uiLocale: 'zh-CN', reviewSourceId: confirmation.id, confirmedReviewContent: content }
    const prepared = f.owner.prepareReviewRevision(request)
    // issue #243 ③：confirmation 修稿开新 root——parent 不再返回审稿 root。
    expect(prepared.parentRootActionId).toBeUndefined()
    expect(prepared.modelId).toBe('synthetic')
    const selection = { ...f.selection(prepared), uiActionNonce: 'confirmed-fix' }
    expect(() => f.owner.begin({ ...selection, parentRootActionId: undefined })).toThrow('GENERATION_BEGIN_INVALID')
    expect(() => f.owner.begin({ ...selection, modelId: 'other' })).toThrow()
    const view = f.owner.begin(selection)
    // issue #243 ③：confirmation 修稿开新 root。
    expect(view.handle.rootActionId).not.toBe(original.handle.rootActionId)
    const recovered = f.owner.readReviewRevisionRecovery(view.handle)
    expect(() => f.owner.begin({ ...selection, reviewRevisionContextId: recovered.contextId })).not.toThrow()
    const prompt = '按确认修改'
    const brief = renderHumanConfirmedReviewBrief(prepared.context.confirmation!.snapshot, prepared.context.writingLanguage)
    f.owner.bindMaterialDecision(view.handle, { ...materialDecision(prompt),
      capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: Buffer.byteLength(brief) },
      coverage: { required: 1, included: 1, complete: true },
      included: [{ sourceId: `review:confirmed:${confirmation.id}`, revision: confirmation.id, contentHash: textHash(brief),
        category: 'author', required: true, units: Buffer.byteLength(brief) }] })
    await f.owner.execute({ handle: view.handle, invocationNonce: 'fix-1', task: { purpose: 'refine-from-review', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(2)
    // ③ 后修稿开新 root：审稿 + 修稿 = 2。
    expect(f.db.prepare('SELECT COUNT(DISTINCT root_action_id) FROM generation_runs').pluck().get()).toBe(2)
    const candidate = f.owner.read(view.handle).candidates![0]
    const composition = f.owner.composeVisible(view.handle, [candidate.artifactId], textHash(report), 'visible-append-v1')
    f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run('作者改了确认', confirmation.id)
    expect(f.owner.readReviewRevisionRecovery(view.handle).sourceStatus).toBe('conflict')
    expect(() => f.owner.commitRevision({ contextId: prepared.contextId, handle: view.handle, expectedCompositionHash: composition.textHash })).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.owner.read(view.handle).candidates).toHaveLength(1)
    expect(() => f.owner.prepareReviewRevision(request)).toThrow('GENERATION_REVIEW_CONFIRMATION_CHANGED')
  })
  it('binds a confirmed revision to its cycle atomically and retries after an attach failure', async () => {
    let invocation = 0
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: ++invocation === 1 ? report : revisedProse })
      return { finishReason: 'stop', usage: null }
    })
    const original = await f.run(), savedReview = f.owner.commitReview(original)
    const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: savedReview.id, sourceDraft: savedReview.source,
      summary: '作者确认', authorGuidance: '保持克制', items: [{ category: '表达', severity: 'warning',
        description: '补充动作', decision: 'apply', origin: 'ai' }] })!
    const confirmationContent = serializeHumanConfirmedReviewSnapshot(snapshot)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content: confirmationContent,
      expectedSource: savedReview.source }, f.db)
    const prepared = f.owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) },
      authorInputs: [], uiLocale: 'zh-CN', reviewSourceId: confirmation.id, confirmedReviewContent: confirmationContent })
    const view = f.owner.begin({ ...f.selection(prepared), uiActionNonce: 'confirmed-cycle' })
    const prompt = '按确认修改', brief = renderHumanConfirmedReviewBrief(snapshot, prepared.context.writingLanguage)
    f.owner.bindMaterialDecision(view.handle, { ...materialDecision(prompt),
      capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: Buffer.byteLength(brief) },
      coverage: { required: 1, included: 1, complete: true }, included: [{ sourceId: `review:confirmed:${confirmation.id}`,
        revision: confirmation.id, contentHash: textHash(brief), category: 'author', required: true,
        units: Buffer.byteLength(brief) }] })
    await f.owner.execute({ handle: view.handle, invocationNonce: 'confirmed-cycle-run',
      task: { purpose: 'refine-from-review', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    const candidate = f.owner.read(view.handle).candidates![0]
    const composition = f.owner.composeVisible(view.handle, [candidate.artifactId], textHash(revisedProse), 'visible-append-v1')
    const commit = { contextId: prepared.contextId, handle: view.handle, expectedCompositionHash: composition.textHash }
    const contentsBefore = f.db.prepare('SELECT COUNT(*) FROM contents').pluck().get()
    f.db.exec(`CREATE TRIGGER fail_cycle_attach BEFORE UPDATE OF revision_status ON review_cycles
      WHEN NEW.revision_status='generated' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CYCLE_ATTACH_FAILURE'); END`)
    expect(() => f.owner.commitRevision(commit)).toThrow('SYNTHETIC_CYCLE_ATTACH_FAILURE')
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM contents').pluck().get()).toBe(contentsBefore)
    expect(f.db.prepare("SELECT COUNT(*) FROM generation_attempts WHERE json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='revision'")
      .pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT revision_status,revision_id FROM review_cycles').get())
      .toEqual({ revision_status: 'not-generated', revision_id: null })
    expect(verifyM03ReviewCycle(f.db)).toBe(true)
    f.db.exec('DROP TRIGGER fail_cycle_attach')

    const savedRevision = f.owner.commitRevision(commit)
    expect(savedRevision).toMatchObject({ kind: 'revision', revisionStatus: 'pending', content: revisedProse })
    expect(f.db.prepare('SELECT review_id,confirmation_review_id,revision_id,revision_status FROM review_cycles').get())
      .toEqual({ review_id: savedReview.id, confirmation_review_id: confirmation.id,
        revision_id: savedRevision.id, revision_status: 'generated' })
    expect(verifyM03ReviewCycle(f.db)).toBe(true)
    expect(f.owner.commitRevision(commit)).toEqual(savedRevision)
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(1)
    const cycle = f.db.prepare('SELECT cycle_id,root_action_id FROM review_cycles').get() as {
      cycle_id: string; root_action_id: string
    }
    const attemptsBeforeNoOpMerge = f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()
    const dispatchesBeforeNoOpMerge = f.spy.mock.calls.length
    const merged = RevisionRepository.mergeIntoDraft({ revisionId: savedRevision.id, targetDraftId: 1,
      expectedDraftContent: prose, mergedContent: prose, wordCount: countDraftUnits(prose) }, f.db)
    expect(merged.reviewCycle).toMatchObject({ cycleId: cycle.cycle_id,
      mergedHash: textHash(prose), disposition: 'not-required' })
    expect(ReviewCycleRepository.planRecheck(cycle.cycle_id, f.db)).toEqual({ disposition: 'not-required',
      context: null, rootActionId: cycle.root_action_id, reviewId: savedReview.id })
    expect(() => f.owner.prepareReviewRevision({ operation: 'review-chapter', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'revised', contentHash: textHash(prose) },
      reviewCycleId: cycle.cycle_id, expectedMergedHash: textHash(prose), authorInputs: [], uiLocale: 'zh-CN' }))
      .toThrow('GENERATION_REVIEW_RECHECK_NOT_REQUIRED')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(attemptsBeforeNoOpMerge)
    expect(f.spy).toHaveBeenCalledTimes(dispatchesBeforeNoOpMerge)
  })
  it('resolves the cycle by the snapshot cycleId first, falling back to review_id (issue #244 四开 12:42 现场)', async () => {
    // 现场：commit-revision 按 snapshot.sourceReviewId 查 review_cycles 落空（快照
    // 谱系键与 cycle.review_id 不一致时）→ 修稿跑完却在提交时炸
    // REVIEW_CYCLE_INPUT_INVALID。修复 = 快照带 cycleId（UI 弹层传入）按 cycle_id 查
    // 正键，review_id 只作旧快照兜底；落空时打主进程诊断日志再抛。
    let invocation = 0
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: ++invocation === 1 ? report : revisedProse })
      return { finishReason: 'stop', usage: null }
    })
    const original = await f.run(), savedReview = f.owner.commitReview(original)
    const cycleRow = f.db.prepare('SELECT cycle_id,review_id FROM review_cycles').get() as { cycle_id: string; review_id: number }
    expect(cycleRow.review_id).toBe(savedReview.id)
    const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: savedReview.id,
      cycleId: cycleRow.cycle_id, sourceDraft: savedReview.source,
      summary: '作者确认', authorGuidance: '保持克制', items: [{ category: '表达', severity: 'warning',
        description: '补充动作', decision: 'apply', origin: 'ai' }] })!
    const confirmationContent = serializeHumanConfirmedReviewSnapshot(snapshot)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content: confirmationContent,
      expectedSource: savedReview.source }, f.db)
    const prepared = f.owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) },
      authorInputs: [], uiLocale: 'zh-CN', reviewSourceId: confirmation.id, confirmedReviewContent: confirmationContent })
    // 1.5.247 ③：confirmation 修稿开新 root；1.5.249 修复：parent 不再按 effect 找原始
    // run——复核审稿的确认快照按 effect 找不到原始 run（另一处四开阻断）。
    expect(prepared.parentRootActionId).toBeUndefined()
    const view = f.owner.begin({ ...f.selection(prepared), uiActionNonce: 'cycle-keyed-fix' })
    const prompt = '按确认修改', brief = renderHumanConfirmedReviewBrief(snapshot, prepared.context.writingLanguage)
    f.owner.bindMaterialDecision(view.handle, { ...materialDecision(prompt),
      capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: Buffer.byteLength(brief) },
      coverage: { required: 1, included: 1, complete: true }, included: [{ sourceId: `review:confirmed:${confirmation.id}`,
        revision: confirmation.id, contentHash: textHash(brief), category: 'author', required: true,
        units: Buffer.byteLength(brief) }] })
    await f.owner.execute({ handle: view.handle, invocationNonce: 'cycle-keyed-run',
      task: { purpose: 'refine-from-review', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    const candidate = f.owner.read(view.handle).candidates![0]!
    const composition = f.owner.composeVisible(view.handle, [candidate.artifactId], textHash(revisedProse), 'visible-append-v1')
    const savedRevision = f.owner.commitRevision({ contextId: prepared.contextId, handle: view.handle,
      expectedCompositionHash: composition.textHash })
    expect(savedRevision).toMatchObject({ kind: 'revision', revisionStatus: 'pending', content: revisedProse })
    expect(f.db.prepare('SELECT review_id,confirmation_review_id,revision_id,revision_status FROM review_cycles').get())
      .toEqual({ review_id: savedReview.id, confirmation_review_id: confirmation.id,
        revision_id: savedRevision.id, revision_status: 'generated' })
    expect(verifyM03ReviewCycle(f.db)).toBe(true)
  })
  it.each([1, 2] as const)('resumes a settled semantic v1 recheck and replays wrapped report derivation v%i', async reportVersion => {
    const source = prose + '门闩上的裂纹仍在。'
    const revised = prose + '门闩上的裂纹已用石蜡封住。'
    const targetedReport = JSON.stringify({ summary: '发现门闩事实需要修复。',
      items: [{ category: '表达', severity: 'pass', description: '其余表达可接受。' }],
      goalReviews: [{ id: 'ch1:keyEvents:1', evidence: [{ quote: '门闩上的裂纹仍在' }],
        description: '门闩裂纹尚未处理。', status: 'unmet' }] })
    let invocation = 0, recheckOutput = 'not-json'
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: [targetedReport, revised, recheckOutput][invocation++]! })
      return { finishReason: 'stop', usage: null }
    })
    f.db.prepare('UPDATE contents SET body=? WHERE id=1').run(source)
    f.db.prepare('UPDATE blueprints SET key_events=? WHERE chapter_number=1').run('修复门闩上的裂纹')
    const expected = { chapterNumber: 1, version: 1, status: 'draft' as const, contentHash: textHash(source) }
    const reviewPrepared = f.owner.prepareReviewRevision({ operation: 'review-chapter', draftId: 1,
      expectedDraft: expected, authorInputs: [], uiLocale: 'zh-CN' })
    const reviewView = f.owner.begin(f.selection(reviewPrepared))
    const reviewPrompt = '检查唯一门闩事实'
    f.owner.bindMaterialDecision(reviewView.handle, materialDecision(reviewPrompt))
    const reviewRun = await f.owner.execute({ handle: reviewView.handle, invocationNonce: 'review-root',
      task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: reviewPrompt }] } })
    const reviewArtifact = reviewRun.run.artifacts.at(-1)!
    const savedReview = f.owner.commitReview({ contextId: reviewPrepared.contextId, handle: reviewView.handle,
      artifact: { artifactId: reviewArtifact.artifactId, revision: reviewArtifact.revision, textHash: reviewArtifact.textHash } })
    const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: savedReview.id, sourceDraft: savedReview.source,
      summary: '作者确认修复门闩', authorGuidance: '', items: [{ category: '本章目标', severity: 'error',
        description: '修复门闩上的裂纹\n门闩裂纹尚未处理。', quote: '门闩上的裂纹仍在',
        goalId: 'ch1:keyEvents:1', decision: 'apply', origin: 'ai' }] })!
    const confirmationContent = serializeHumanConfirmedReviewSnapshot(snapshot)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content: confirmationContent,
      expectedSource: savedReview.source }, f.db)
    const revisionPrepared = f.owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: 1,
      expectedDraft: expected, reviewSourceId: confirmation.id, confirmedReviewContent: confirmationContent,
      authorInputs: [], uiLocale: 'zh-CN' })
    const revisionView = f.owner.begin({ ...f.selection(revisionPrepared), uiActionNonce: 'revision-root' })
    const revisionPrompt = '只修复门闩事实', brief = renderHumanConfirmedReviewBrief(snapshot, 'zh-CN')
    f.owner.bindMaterialDecision(revisionView.handle, { ...materialDecision(revisionPrompt),
      capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: Buffer.byteLength(brief) },
      coverage: { required: 1, included: 1, complete: true }, included: [{ sourceId: `review:confirmed:${confirmation.id}`,
        revision: confirmation.id, contentHash: textHash(brief), category: 'author', required: true,
        units: Buffer.byteLength(brief) }] })
    await f.owner.execute({ handle: revisionView.handle, invocationNonce: 'revision-run',
      task: { purpose: 'refine-from-review', output: 'visible-text', messages: [{ role: 'user', content: revisionPrompt }] } })
    const revisionArtifact = f.owner.read(revisionView.handle).candidates![0]!
    const composition = f.owner.composeVisible(revisionView.handle, [revisionArtifact.artifactId], textHash(revised), 'visible-append-v1')
    const savedRevision = f.owner.commitRevision({ contextId: revisionPrepared.contextId, handle: revisionView.handle,
      expectedCompositionHash: composition.textHash })
    RevisionRepository.mergeIntoDraft({ revisionId: savedRevision.id, targetDraftId: 1, expectedDraftContent: source,
      mergedContent: revised, wordCount: countDraftUnits(revised) }, f.db)
    const cycle = f.db.prepare('SELECT cycle_id,merged_hash FROM review_cycles').get() as { cycle_id: string; merged_hash: string }
    const recheckPrepared = f.owner.prepareReviewRevision({ operation: 'review-chapter', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'revised', contentHash: textHash(revised) },
      reviewCycleId: cycle.cycle_id, expectedMergedHash: cycle.merged_hash, authorInputs: [], uiLocale: 'zh-CN' })
    // issue #246：复核 run 开新 root——不再继承审稿 root（其预算/blocked_code
    // 会挡复验重试）；modelId 继承保留。
    expect(recheckPrepared.parentRootActionId).toBeUndefined()
    expect(recheckPrepared.modelId).toBe('synthetic')
    const recheckView = f.owner.begin({ ...f.selection(recheckPrepared), uiActionNonce: 'recheck-root' })
    const recheckPrompt = '复核门闩 finding'
    f.owner.bindMaterialDecision(recheckView.handle, materialDecision(recheckPrompt))
    const finding = f.db.prepare('SELECT finding_id,target_id FROM review_findings WHERE cycle_id=? AND target_id IS NOT NULL')
      .get(cycle.cycle_id) as { finding_id: string; target_id: string }
    recheckOutput = `复核说明\n\`\`\`json\n${JSON.stringify({ summary: '模型认为已经修复。', items: [{ findingId: finding.finding_id,
      targetId: finding.target_id, resolved: true, evidenceQuote: '门闩上的裂纹已用石蜡封住', reason: '正文出现新证据。' }] })}\n\`\`\`\n说明结束`
    const storedBinding = JSON.parse(f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?')
      .pluck().get(recheckView.handle.runId) as string)
    storedBinding.sourceManifest.reviewRevisionContext.recheck.version = 1
    const frozenContext = JSON.stringify(storedBinding.sourceManifest.reviewRevisionContext)
    storedBinding.sourceManifest.reviewRevisionContextHash = textHash(frozenContext)
    storedBinding.sourceManifest.authorInputs = [{ id: 'review-revision-context', text: frozenContext }]
    const legacyBinding = rebuildGenerationSourceBinding(f.deps, storedBinding, 'epoch-1').binding
    f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?')
      .run(JSON.stringify(legacyBinding), recheckView.handle.runId)
    const recheckRun = await f.owner.execute({ handle: recheckView.handle, invocationNonce: 'recheck-run',
      task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: recheckPrompt }] } })
    const recheckArtifact = recheckRun.run.artifacts.at(-1)!
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    try {
      const resumed = await reopened.resume(recheckView.handle)
      const recovery = reopened.readReviewRevisionRecovery(resumed.handle)
      expect(recovery).toMatchObject({ sourceStatus: 'current', canResume: true,
        context: { recheck: { version: 1, cycleId: cycle.cycle_id } } })
      const commit = { contextId: recovery.contextId!, handle: resumed.handle,
        artifact: { artifactId: recheckArtifact.artifactId, revision: recheckArtifact.revision, textHash: recheckArtifact.textHash } }
      const savedRecheck = reopened.commitReview(commit)
      expect(savedRecheck.reviewCycle).toMatchObject({ cycleId: cycle.cycle_id, recheckCount: 1, disposition: 'completed' })
      const parsed = JSON.parse(savedRecheck.content)
      /**
       * issue #245：v2 不再把模型判的 resolved 降级成 unknown（那个「作者核实」
       * 入口并不存在，导致作者按 AI 改完后定稿永远提示「还没确定」）。
       * 现在两版语义一致：引文唯一锚定 + resolved=true → 直接算已解决。
       *
       * ⚠️ 注意 `it.each` 的 `reportVersion` 只决定**事后模拟哪种历史落库行**
       * （下面 `if (reportVersion === 1)` 那段改写 DB），两次迭代跑的活路径相同，
       * 所以这条断言不带分支。
       */
      expect(parsed.summary).toBe('模型认为已经修复。')
      expect(parsed.items[0]).toMatchObject({ severity: 'pass', resolved: true,
        quote: '门闩上的裂纹已用石蜡封住', description: expect.stringContaining('正文出现新证据。') })
      expect(f.db.prepare('SELECT status FROM review_findings').pluck().get()).toBe('resolved')
      expect(reopened.commitReview(commit)).toEqual(savedRecheck)
      expect(f.db.prepare("SELECT json_extract(usage_receipt_json,'$.reviewCycleRecheck.version') FROM generation_attempts WHERE attempt_id=?")
        .pluck().get(recheckArtifact.attemptId)).toBe(2)
      // ③ 后修稿开新 root；#246 后复核也开新 root：审稿 + 修稿 + 复核 = 3。
    expect(f.db.prepare('SELECT COUNT(DISTINCT root_action_id) FROM generation_runs').pluck().get()).toBe(3)
      expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(3)
      expect(verifyM03ReviewCycle(f.db)).toBe(true)
      expect(f.spy).toHaveBeenCalledTimes(3)
      expect(() => reopened.prepareReviewRevision({ operation: 'review-chapter', draftId: 1,
        expectedDraft: { chapterNumber: 1, version: 1, status: 'revised', contentHash: textHash(revised) },
        reviewCycleId: cycle.cycle_id, expectedMergedHash: cycle.merged_hash, authorInputs: [], uiLocale: 'zh-CN' }))
        .toThrow('GENERATION_REVIEW_RECHECK_NOT_REQUIRED')
      const usage = JSON.parse(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?')
        .pluck().get(recheckArtifact.attemptId) as string)
      expect(usage.reviewRevisionEffect.reportVersion).toBe(2)
      let expectedSaved = savedRecheck
      if (reportVersion === 1) {
        // Historical strict parsing kept this complete wrapped artifact but saved an invalid-output report.
        const content = JSON.stringify({ summary: '复核输出无效；受影响项目保持待核实。', items: [{
          category: parsed.items[0].category, severity: 'unknown', findingId: finding.finding_id,
          targetId: finding.target_id, description: '复核未提供唯一且可验证的新证据。',
        }] }, null, 2)
        delete usage.reviewRevisionEffect.reportVersion
        usage.reviewRevisionEffect.contentHash = textHash(content)
        f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run(content, savedRecheck.id)
        f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?')
          .run(JSON.stringify(usage), recheckArtifact.attemptId)
        // 这份「历史行」若真是 v1 严格解析拒收的产物，那么当时的**裁决集是空的**：
        // 整份复核作废 → 没有 decisions → 回执 findings 为 []、finding 全部 unknown。
        // 只改报告不改这两处，M03 会看到「回执说 resolved=true、报告说 unknown」，
        // 校验不过 → readRecheckCycle 抛 REVIEW_CYCLE_CONFLICT。
        usage.reviewCycleRecheck.findings = []
        f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?')
          .run(JSON.stringify(usage), recheckArtifact.attemptId)
        f.db.prepare("UPDATE review_findings SET status='unknown',evidence_hash=NULL WHERE cycle_id=?")
          .run(cycle.cycle_id)
        expectedSaved = { ...savedRecheck, content, contentHash: textHash(content) }
      }
      reopened.suspendForProjectClose()
      const again = f.reopenStorage()
      try {
        expect(again.readReviewRevisionRecovery(resumed.handle).saved).toEqual(expectedSaved)
        expect(again.commitReview(commit)).toEqual(expectedSaved)
        expect(verifyM03ReviewCycle(f.db)).toBe(true)
        expect(JSON.parse(f.db.prepare('SELECT artifact_json FROM generation_artifacts WHERE artifact_id=?')
          .pluck().get(recheckArtifact.artifactId) as string).text).toBe(recheckOutput)
        for (const version of [3, reportVersion === 1 ? 2 : undefined]) {
          const changed = structuredClone(usage)
          if (version === undefined) delete changed.reviewRevisionEffect.reportVersion
          else changed.reviewRevisionEffect.reportVersion = version
          f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?')
            .run(JSON.stringify(changed), recheckArtifact.attemptId)
          expect(() => again.commitReview(commit)).toThrow('GENERATION_REVIEW_RECEIPT_INVALID')
          f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?')
            .run(JSON.stringify(usage), recheckArtifact.attemptId)
        }
        expect(f.spy).toHaveBeenCalledTimes(3)
      } finally { again.suspendForProjectClose() }
    } finally { reopened.suspendForProjectClose() }
  })
  it('refuses a legacy AI review without an owner effect instead of opening a new budget root', () => {
    const f = fixture(), source = f.prepare().context.source
    const legacy = ReviewRepository.create({ baseDraftId: 1, content: report, expectedSource: source }, f.db)
    const content = serializeHumanConfirmedReviewSnapshot(createHumanConfirmedReviewSnapshot({ sourceReviewId: legacy.id, sourceDraft: source, summary: '确认旧稿', authorGuidance: '', items: [{ category: '表达', severity: 'warning', description: '修改', decision: 'apply', origin: 'ai' }] })!)
    const confirmation = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: source }, f.db)
    expect(() => f.owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: 1, expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(prose) }, authorInputs: [], uiLocale: 'zh-CN', reviewSourceId: confirmation.id, confirmedReviewContent: content })).toThrow('GENERATION_REVIEW_LINEAGE_UNPROVEN')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
    expect(f.spy).not.toHaveBeenCalled()
  })
  it('replays an old revision ACK without discarding a later pending revision', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: revisedProse }); return { finishReason: 'stop', usage: null } }), request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(revisedProse), 'visible-append-v1')
    const commit = { contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash }
    const saved = f.owner.commitRevision(commit)
    const later = RevisionRepository.replacePending({ baseDraftId: 1, revisionType: 'refine', userPrompt: '后来的作者指导', content: prose + '后来候选', wordCount: 284, expectedSource: saved.source }, f.db)
    expect(f.owner.commitRevision(commit)).toMatchObject({ id: saved.id, revisionStatus: 'discarded' })
    expect(RevisionRepository.getFull(later.id, f.db)).toMatchObject({ status: 'pending', content: prose + '后来候选' })
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(2)
  })
  /**
   * issue #201：`read-recovery` 是纯读取，不许把它自己的容量吃掉、更不许挤掉正在用的那份。
   *
   * 现场推演：`readRecovery` 每次都 `remember` 一条新记录，而运行侧页对**每个**审稿 run
   * 都调一次 —— 打开一次侧页就吃掉 N 条（Map 上限 64、纯 FIFO）。塞满之后最早那条
   * （很可能正是 `prepare` 写进去、等着 `admit` 用的那条）被删 → 点「审稿」报
   * `GENERATION_REVIEW_CONTEXT_REQUIRED`。
   *
   * 这条测试就是 issue 建议 ③ 的那条守卫：prepare 一条 → 大量读取 → 断言它仍可取。
   */
  it('reading recovery repeatedly never evicts the admission context a pending begin will use (issue #201)', async () => {
    const f = fixture(), prepared = f.prepare(), view = f.owner.begin(f.selection(prepared))
    // 先发一次真实尝试，好让 readRecovery 走进「有 run、可恢复」这条分支。
    f.owner.bindMaterialDecision(view.handle, materialDecision('审稿'))
    await f.owner.execute({ handle: view.handle, invocationNonce: 'first', task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '审稿' }] } })

    const recovery = f.owner.readReviewRevisionRecovery(view.handle)
    expect(recovery.contextId, '可恢复的 run 必须给出 contextId').toBeTruthy()
    // 同一 run 反复读：必须返回**同一个** contextId（不再每次新建一条）。
    for (let index = 0; index < 100; index += 1) {
      expect(f.owner.readReviewRevisionRecovery(view.handle).contextId).toBe(recovery.contextId)
    }
    /**
     * 关键断言：那条 `prepare` 出来的准入凭据**仍然可通过准入**（100 次读取远超 64 上限）。
     * ⚠️ 用一个新的 `uiActionNonce`：同一个 nonce 会先撞 `GENERATION_NONCE_CONFLICT`
     * （那是 begin 后半段的预算幂等校验），而 `admit` 在那之前就跑了 —— 换个 nonce
     * 才能证明「准入本身过了」。
     */
    expect(() => f.owner.begin({ ...f.selection(prepared), uiActionNonce: 'reclick-admission' })).not.toThrow()
    // 而 recovery 给出的 id 也是可准入的（作者点「继续」走的正是它）。
    expect(() => f.owner.begin({ ...f.selection(prepared), uiActionNonce: 'reclick-recovery',
      reviewRevisionContextId: recovery.contextId! } as BeginGenerationRequest)).not.toThrow()
  })

  it('keeps a recovery context reusable across other runs so a busy sidebar cannot lock the author out', async () => {
    // 多开几条 run 造出容量压力：任何一条 recovery 的写入都不许把仍在等待的准入凭据挤掉。
    const f = fixture()
    const first = f.prepare(), firstView = f.owner.begin(f.selection(first))
    f.owner.bindMaterialDecision(firstView.handle, materialDecision('审稿'))
    await f.owner.execute({ handle: firstView.handle, invocationNonce: 'a', task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '审稿' }] } })
    for (let index = 0; index < 70; index += 1) f.owner.readReviewRevisionRecovery(firstView.handle)
    expect(() => f.owner.begin({ ...f.selection(first), uiActionNonce: 'after-busy-sidebar' })).not.toThrow()
  })

  it('does not write a review when a cancelled provider returns late', async () => {
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const f = fixture(async (_request, options) => {
      started()
      await new Promise<void>(resolve => { finish = resolve })
      options.onVisible({ kind: 'delta', text: report })
      return { finishReason: 'stop', usage: null }
    })
    const prepared = f.prepare(), view = f.owner.begin(f.selection(prepared))
    const prompt = '审稿'
    f.owner.bindMaterialDecision(view.handle, materialDecision(prompt))
    const pending = f.owner.execute({ handle: view.handle, invocationNonce: 'late', task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: prompt }] } })
    await entered
    f.owner.cancel(view.handle)
    finish()
    await pending
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
    expect(f.owner.readReviewRevisionRecovery(view.handle).saved).toBeUndefined()
    expect(f.owner.read(view.handle).artifacts.every(artifact => artifact.text === '')).toBe(true)
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('keeps the draft and rejects an empty review after an unknown stream failure', async () => {
    const f = fixture(async () => { throw new Error('NETWORK_ERROR') }), request = await f.run()
    expect(() => f.owner.commitReview(request)).toThrow('GENERATION_REVIEW_ARTIFACT_INVALID')
    expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT body FROM contents WHERE id=(SELECT content_id FROM drafts WHERE id=1)').pluck().get()).toBe(prose)
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toBeUndefined()
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('does not turn length-terminated revision text into a formal revision', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: prose }); return { finishReason: 'length', usage: null } }), request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(prose), 'visible-append-v1')
    expect(() => f.owner.commitRevision({ contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash })).toThrow('GENERATION_REVIEW_ARTIFACT_INVALID')
    expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(0)
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
  })
  it('seals a saved review artifact against discard and preserves its ACK after reopening', async () => {
    const f = fixture(), request = await f.run(), saved = f.owner.commitReview(request)
    expect(() => f.owner.discardCandidate(request.handle, request.artifact.artifactId)).toThrow('GENERATION_REVIEW_ALREADY_SAVED')
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
    expect(f.owner.commitReview(request)).toEqual(saved)
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    try {
      expect(reopened.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
      expect(reopened.commitReview(request)).toEqual(saved)
      expect(f.db.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(1)
    } finally { reopened.suspendForProjectClose() }
  })
  it('seals a saved revision against new attempts while allowing the original invocation replay', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: revisedProse }); return { finishReason: 'stop', usage: null } }), request = await f.run('refine-draft')
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(revisedProse), 'visible-append-v1')
    const commit = { contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash }
    const saved = f.owner.commitRevision(commit)
    const task = { purpose: 'refine-draft', output: 'visible-text' as const, messages: [{ role: 'user' as const, content: '检查冻结正文' }] }
    await expect(f.owner.execute({ handle: request.handle, invocationNonce: 'new-request', task })).rejects.toThrow('GENERATION_REVIEW_ALREADY_SAVED')
    await expect(f.owner.execute({ handle: request.handle, invocationNonce: 'request', task })).resolves.toBeDefined()
    expect(f.spy).toHaveBeenCalledTimes(1)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(1)
    expect(() => f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(revisedProse), 'visible-append-v1')).toThrow('GENERATION_REVIEW_ALREADY_SAVED')
    expect(f.owner.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
    f.owner.suspendForProjectClose()
    const reopened = f.reopenStorage()
    try {
      expect(reopened.readReviewRevisionRecovery(request.handle).saved).toEqual(saved)
      expect(reopened.commitRevision(commit)).toEqual(saved)
      expect(f.db.prepare('SELECT COUNT(*) FROM revisions').pluck().get()).toBe(1)
    } finally { reopened.suspendForProjectClose() }
  })
  it('cannot switch a saved composition to another already generated artifact', async () => {
    const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: revisedProse }); return { finishReason: 'stop', usage: null } }), request = await f.run('refine-draft')
    const second = await f.owner.execute({ handle: request.handle, invocationNonce: 'second-before-save', task: { purpose: 'refine-draft', output: 'visible-text', messages: [{ role: 'user', content: '另一候选' }] } })
    const secondId = second.run.artifacts.at(-1)!.artifactId
    expect(secondId).not.toBe(request.artifact.artifactId)
    const composition = f.owner.composeVisible(request.handle, [request.artifact.artifactId], textHash(revisedProse), 'visible-append-v1')
    const commit = { contextId: request.contextId, handle: request.handle, expectedCompositionHash: composition.textHash }
    const saved = f.owner.commitRevision(commit)
    expect(() => f.owner.composeVisible(request.handle, [secondId], textHash(revisedProse), 'visible-append-v1')).toThrow('GENERATION_REVIEW_ALREADY_SAVED')
    const recovery = f.owner.readReviewRevisionRecovery(request.handle)
    expect(recovery.composition?.artifactIds).toEqual([request.artifact.artifactId])
    expect(recovery.saved).toEqual(saved)
    expect(f.owner.commitRevision(commit)).toEqual(saved)
    expect(f.spy).toHaveBeenCalledTimes(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(2)
  })})

/**
 * issue #215：审稿 ECONNRESET 之后的重试撞 `GENERATION_NONCE_CONFLICT`。
 *
 * 真实路径（本机实测复现）：
 *   ① prepare → begin（此时 sourceManifest 里**没有** materialDecision）
 *   ② `bindMaterialDecision`（写进 materialDecision + materialDecisionHash，
 *      并因此改掉 `contextSnapshotId` —— 它是 `context:${hash(contextSourcesHash, materialDecisionHash)}`）
 *   ③ execute 因 ECONNRESET 失败
 *   ④ 重试再走一次 prepare → begin：这一份**没有** materialDecision（裁决是第 ② 步绑的）
 *      → 与 run 上冻结的那份逐字不等 → NONCE_CONFLICT → 界面空等 720 秒
 *
 * 根因不是 issue 猜的「reviewRevisionContext 被重算」——**两次 prepare 的 context 逐字相同**
 * （下面那条断言钉住这一点）。真因是幂等判据把「begin 之后才绑上去的字段」也算进了逐字比较。
 */
it('retrying a failed review reuses the same run instead of hitting GENERATION_NONCE_CONFLICT (issue #215)', async () => {
  const f = fixture(async () => { throw new Error('NETWORK_ERROR') })
  const first = f.prepare(), selA = f.selection(first)
  const view = f.owner.begin(selA)
  f.owner.bindMaterialDecision(view.handle, materialDecision('审稿'))
  await f.owner.execute({ handle: view.handle, invocationNonce: 'attempt-1',
    task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '审稿' }] } }).catch(() => {})

  // 重试：与命令层一样再走一次 prepare，然后用**同一个** uiActionNonce 再 begin。
  const second = f.prepare()
  // ⚠️ 两次 prepare 的 context 逐字相同 —— 所以「context 被重算」不是这条的原因。
  expect(isDeepStrictEqual(first.context, second.context)).toBe(true)
  const again = f.owner.begin({ ...f.selection(second), uiActionNonce: selA.uiActionNonce })
  // 幂等复用同一个 run：不再抛错，也不再新建一条。
  expect(again.handle.runId).toBe(view.handle.runId)
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(1)
})

it('still rejects a same-nonce request whose frozen inputs genuinely changed (issue #215 不许放宽这条)', () => {
  // 「同 nonce 换了输入」必须照旧拒绝 —— 否则幂等判据就形同虚设。
  const f = fixture()
  const prepared = f.prepare(), selection = f.selection(prepared)
  f.owner.begin(selection)
  /**
   * 造一份**只改了冻结输入、其余准入项全过**的 selection：同 nonce、同 context，
   * 但 `authorInputs` 里的正文字段变了（那会进 sourceManifest / fingerprint）。
   * ⚠️ 不能只改 `reviewRevisionContextId` —— 那会先撞
   * `GENERATION_REVIEW_CONTEXT_MISMATCH`（准入表比 sourceManifest 更早）。
   */
  const tampered = { ...selection, authorInputs: [{ id: 'review-revision-context', text: '{}' }] }
  expect(() => f.owner.begin({ ...tampered, uiActionNonce: selection.uiActionNonce }))
    .toThrow()
})
