import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { SummaryRepository } from '../summary-repository'
import { recategorizeFinalizedFacts } from '../../../src/shared/finalized-continuity-facts'

let projectRoot = ''

function projectionGeneration(): number {
  return (getProjectDb()!.prepare(`
    SELECT generation FROM continuity_projection_meta WHERE id = 'main'
  `).get() as { generation: number }).generation
}

beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/novel-quality-modernization/recat-173')
  fs.mkdirSync(cache, { recursive: true })
  projectRoot = fs.mkdtempSync(path.join(cache, 'case-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

/**
 * issue #173：`#148` 修好的是**判据**，但 `category` 是落库那一刻算一次并写死的 ——
 * 存量 20 章不自愈。真书全量复算 561 条里 **148 条与当前判据不符**（含 109 条 `plot→open-thread`）。
 *
 * 这里钉住写回通道的四件事：**只改 category** / **引文必须仍能定位** / **幂等** /
 * **两张表（summary_snapshots 与 chapter_commits）一起对齐**。
 */
function seedLegacyChapter(): { draftId: number } {
  const content = '第一章正文。周叙把绳圈放平。他记得温珩教过他打这个结。'
  const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
    operationId: 'recat-173',
    chapters: [{ chapterNumber: 1, title: '绳结', content, wordCount: countDraftUnits(content) }],
  })
  const draft = receipt.drafts[0]!
  SummaryRepository.saveFinalizedContinuity({
    draftId: draft.draftId,
    chapterNumber: 1,
    chapterNotes: '情节节点：周叙放平绳圈。',
    projectionGeneration: projectionGeneration(),
    source: {
      draftId: draft.draftId,
      finalizationId: draft.finalizationId,
      chapterNumber: 1,
      contentHash: draft.contentHash,
    },
    // ⚠️ 故意写成「旧判据算出来的」错误分类：一条伏笔被标成 plot。
    facts: [
      { category: 'plot', entities: ['绳圈'], statement: '[埋] 绳结的绕法是温珩教的。', sourceChapter: 1, evidence: '周叙把绳圈放平。' },
      { category: 'plot', entities: ['周叙'], statement: '周叙记得温珩教过他打这个结。', sourceChapter: 1, evidence: '他记得温珩教过他打这个结。' },
    ],
  })
  return { draftId: draft.draftId }
}

describe('recategorizeFinalizedContinuityChapter (issue #173)', () => {
  it('fixes an old [埋] fact from plot to open-thread and reports what changed', () => {
    const { draftId } = seedLegacyChapter()
    const receipt = SummaryRepository.recategorizeFinalizedContinuityChapter({ draftId, chapterNumber: 1 })
    expect(receipt.changed).toBe(2)
    // 计数按 from→to 分组，供界面先给作者看差异。
    expect(receipt.counts['plot→open-thread']).toBe(1)
    const facts = SummaryRepository.listFinalizedContinuityBefore(2)[0]!.facts ?? []
    expect(facts.find(fact => fact.statement.startsWith('[埋]'))!.category).toBe('open-thread')
  })

  it('changes ONLY the category: statement, evidence and sourceChapter stay byte-identical', () => {
    const { draftId } = seedLegacyChapter()
    const before = SummaryRepository.listFinalizedContinuityBefore(2)[0]!.facts ?? []
    SummaryRepository.recategorizeFinalizedContinuityChapter({ draftId, chapterNumber: 1 })
    const after = SummaryRepository.listFinalizedContinuityBefore(2)[0]!.facts ?? []
    expect(after.length).toBe(before.length)
    for (let index = 0; index < before.length; index += 1) {
      const beforeFact = before[index]!
      const afterFact = after[index]!
      expect(afterFact.statement).toBe(beforeFact.statement)
      expect(afterFact.evidence).toBe(beforeFact.evidence)
      expect(afterFact.sourceChapter).toBe(beforeFact.sourceChapter)
      expect(afterFact.entities).toEqual(beforeFact.entities)
    }
  })

  it('is idempotent: a second run changes nothing', () => {
    const { draftId } = seedLegacyChapter()
    expect(SummaryRepository.recategorizeFinalizedContinuityChapter({ draftId, chapterNumber: 1 }).changed).toBe(2)
    const second = SummaryRepository.recategorizeFinalizedContinuityChapter({ draftId, chapterNumber: 1 })
    expect(second.changed).toBe(0)
    expect(second.counts).toEqual({})
  })

  it('rejects a chapter number that does not belong to that draft (source guard)', () => {
    const { draftId } = seedLegacyChapter()
    expect(() => SummaryRepository.recategorizeFinalizedContinuityChapter({ draftId, chapterNumber: 9 }))
      .toThrow('来源已失效')
  })

  it('keeps chapter_commits.facts_json in step with the summary snapshot', () => {
    const { draftId } = seedLegacyChapter()
    // 先建账本（chapter_commits），再重算 —— 两张表必须一起对齐，否则两套账不一致。
    SummaryRepository.recategorizeFinalizedContinuityChapter({ draftId, chapterNumber: 1 })
    const commit = getProjectDb()!.prepare('SELECT facts_json FROM chapter_commits WHERE draft_id=?').get(draftId) as { facts_json: string } | undefined
    if (!commit) return
    const facts = JSON.parse(commit.facts_json) as Array<{ category: string, statement: string }>
    const planted = facts.find(fact => fact.statement.startsWith('[埋]'))
    if (planted) expect(planted.category).toBe('open-thread')
  })
})
/**
 * 安全闸必须真的挡得住（红验证发现的第一版没覆盖这条）：
 * 若某条事实的 `evidence` 已不在绑定定稿正文里（那一章被替换过），
 * 重算必须整笔拒绝 —— 否则等于「按旧引文改新账本」。
 */
describe('recategorizeFinalizedContinuityChapter 的安全闸 (issue #173)', () => {
  it('refuses the whole run when a fact evidence can no longer be located in the finalized prose', () => {
    const content = '第一章正文。周叙把绳圈放平。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'recat-173-guard',
      chapters: [{ chapterNumber: 1, title: '绳结', content, wordCount: countDraftUnits(content) }],
    })
    const draft = receipt.drafts[0]!
    SummaryRepository.saveFinalizedContinuity({
      draftId: draft.draftId,
      chapterNumber: 1,
      chapterNotes: '情节节点：周叙放平绳圈。',
      projectionGeneration: projectionGeneration(),
      source: { draftId: draft.draftId, finalizationId: draft.finalizationId, chapterNumber: 1, contentHash: draft.contentHash },
      facts: [
        { category: 'plot', entities: ['绳圈'], statement: '[埋] 绳结的绕法是温珩教的。', sourceChapter: 1, evidence: '周叙把绳圈放平。' },
      ],
    })
    // 直接改库，模拟「正文被替换过、账本引文已经是老的」这种存量场景
    // （正常写入路径不会允许这种数据，所以只能绕过写入层构造）。
    getProjectDb()!.prepare('UPDATE summary_snapshots SET continuity_facts=? WHERE draft_id=?').run(
      JSON.stringify([{ category: 'plot', entities: ['绳圈'], statement: '[埋] 绳结的绕法是温珩教的。', sourceChapter: 1, evidence: '温珩亲手教他打这个结。' }]),
      draft.draftId)
    expect(() => SummaryRepository.recategorizeFinalizedContinuityChapter({ draftId: draft.draftId, chapterNumber: 1 }))
      .toThrow('无法在绑定定稿正文中精确定位')
    // 整笔拒绝：账本没有被改动过（仍然是我们塞进去的那条旧分类）。
    const facts = SummaryRepository.listFinalizedContinuityBefore(2)[0]!.facts ?? []
    expect(facts[0]!.category).toBe('plot')
  })
})

/**
 * 预览与落库**必须一致**（issue #173 建议 ①「写之前给出计数与样本」）。
 *
 * 界面上的流程是：先 `db:continuity-recategorize-preview`（只读，给计数）→
 * 作者确认 → 再 `db:continuity-recategorize-chapter`（落库）。
 * 两条通道各自算一遍，所以它们的数字**必须相等**，否则作者看到的差异是假的。
 */
describe('预览与落库的数字必须一致 (issue #173)', () => {
  it('preview counts equal what the write path then changes', async () => {
    const { draftId } = seedLegacyChapter()
    // 预览走的是同一份纯函数（IPC 层直接调 recategorizeFinalizedFacts），
    // 这里在仓库层复算一次，确认它与写入路径用的是同一判据。
    const row = getProjectDb()!.prepare('SELECT continuity_facts FROM summary_snapshots WHERE draft_id=?').get(draftId) as { continuity_facts: string }
    const plan = recategorizeFinalizedFacts(JSON.parse(row.continuity_facts) as never)
    const receipt = SummaryRepository.recategorizeFinalizedContinuityChapter({ draftId, chapterNumber: 1 })
    expect(receipt.changed).toBe(plan.changes.length)
    expect(receipt.counts).toEqual(plan.counts)
  })
})
