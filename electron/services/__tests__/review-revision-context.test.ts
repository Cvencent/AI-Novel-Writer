import { FinalizationRepository } from '../../repositories/finalization-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrepareReviewRevisionRequest } from '../../../src/shared/review-revision-generation'
import { serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { getProjectDb } from '../../database'
import { ReviewRepository } from '../../repositories/review-repository'
import { textHash } from '../../repositories/generation-run-repository'
import { abilityBudgetFindings, assertionReversalFindings, captureReviewRevisionContext, numberingFindings, reviewRevisionRequest } from '../review-revision-context'
vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const connections: import('better-sqlite3').Database[] = []
afterEach(() => { connections.splice(0).forEach(db => db.close()); vi.resetAllMocks() })
/** 捕获身份与会话无关：主进程只交项目 id，会话租约不进入冻结材料（活跃租约在使用点补上）。 */
const PROJECT_ID = '合成项目'
function fixture() {
  const db = new Database(':memory:'); connections.push(db)
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.exec("INSERT INTO project_core(id,project_name,worldbuilding) VALUES('main','合成项目','作者世界设定'); INSERT INTO contents(id,body) VALUES(1,' 原稿\r\n结尾 '); INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(1,2,1,'draft',1)")
  const request: PrepareReviewRevisionRequest = { operation: 'review-chapter', draftId: 1,
    expectedDraft: { chapterNumber: 2, version: 1, status: 'draft', contentHash: textHash(' 原稿\r\n结尾 ') },
    authorInputs: [{ id: 'review-focus', text: ' 保留原文\r\n ' }], uiLocale: 'zh-CN' }
  return { db, request, capture: () => captureReviewRevisionContext(db, request, PROJECT_ID) }
}

function confirmation(f: ReturnType<typeof fixture>) {
  const source = f.capture().source
  const original = ReviewRepository.create({ baseDraftId: 1, content: '{"summary":"原始 AI 意见"}', expectedSource: source }, f.db)
  const content = serializeHumanConfirmedReviewSnapshot({ kind: 'human-confirmed-review', schemaVersion: 1,
    sourceReviewId: original.id, sourceDraft: source, summary: '作者确认', authorGuidance: '保持动机',
    items: [{ category: '情节', severity: 'warning', description: '修复因果', decision: 'apply', origin: 'ai' },
      { category: '风格', severity: 'warning', description: '不要采用此项', decision: 'ignore', origin: 'author' }] })
  const saved = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: source }, f.db)
  Object.assign(f.request, { operation: 'refine-from-review', authorInputs: [], reviewSourceId: saved.id, confirmedReviewContent: content })
  return { source, original, saved, content }
}
describe('审修上下文实际 SQLite 捕获', () => {
  it('从主进程作者世界设定与活跃角色备注冻结本章必现，来源变化产生新清单', () => {
    const f = fixture()
    f.db.exec("UPDATE project_core SET world_setting='普通背景。\n【第2章必现】城门在正文开启\n【第3章必现】钟楼倒塌' WHERE id='main'")
    f.db.prepare('INSERT INTO characters(character_id,name,retired,notes) VALUES(?,?,?,?)')
      .run('active', '林岚', 0, '【第2章必现】林岚看见铜钥匙')
    f.db.prepare('INSERT INTO characters(character_id,name,retired,notes) VALUES(?,?,?,?)')
      .run('retired', '旧人', 1, '【第2章必现】旧人出现')
    expect(f.capture().frozenGoals).toMatchObject({ coverage: 'complete', items: [
      { text: '城门在正文开启' }, { text: '林岚看见铜钥匙' },
    ] })
    f.db.exec("UPDATE project_core SET world_setting='普通背景。' WHERE id='main'")
    expect(f.capture().frozenGoals.items.map(item => item.text)).toEqual(['林岚看见铜钥匙'])
    f.db.prepare('UPDATE contents SET body=? WHERE id=1').run('来源已变')
    expect(f.capture).toThrow('GENERATION_REVIEW_SOURCE_CHANGED')
  })

  it.each(['contentHash', 'version', 'status', 'chapterNumber', 'id', 'old-version'] as const)('拒绝 UI 来源失配 %s', key => {
    const f = fixture()
    if (key === 'id') f.request.draftId = 999
    else if (key === 'old-version') f.db.exec("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(2,2,'draft',1)")
    else Object.assign(f.request.expectedDraft, { [key]: key === 'contentHash' ? textHash('别稿') : key === 'status' ? 'finalized' : 9 })
    expect(f.capture).toThrow('GENERATION_REVIEW_SOURCE_CHANGED')
  })
  it('保留作者输入字节并隔离调用方后续改动', () => {
    const f = fixture(), context = f.capture()
    f.request.authorInputs[0]!.text = '后来编辑'
    expect(context.authorInputs[0]!.text).toBe(' 保留原文\r\n ')
    expect(reviewRevisionRequest(context).expectedDraft).toEqual(f.request.expectedDraft)
    f.request.operation = 'refine-draft'; f.request.authorInputs = [{ id: 'user-prompt', text: '直接改稿' }, { id: 'merged-guidance', text: '作者指导' }]
    expect(f.capture().authorInputs).toEqual(f.request.authorInputs)
  })
  it.each(['user-prompt', 'candidate', 'merged-guidance'])('审稿拒绝越界作者输入 %s', id => {
    const f = fixture(); f.request.authorInputs = [{ id, text: '候选不能冒充作者' }]
    expect(f.capture).toThrow('GENERATION_REVIEW_CONTEXT_INVALID')
  })
  it('只采纳活跃 ID 的作者状态，不采纳派生或退休状态', () => {
    const f = fixture()
    for (const [id, retired, kind, location] of [['active', 0, 'author', '北塔'], ['retired', 1, 'author', '旧站'], ['derived', 0, 'legacy', '猜测地点']] as const) {
      f.db.prepare('INSERT INTO characters(character_id,name,retired,cs_updated_at_chapter,cs_location,cs_provenance) VALUES(?,?,?,1,?,?)')
        .run(id, id, retired, location, JSON.stringify({ location: { kind, chapterNumber: 1 } }))
    }
    const context = f.capture()
    expect(context.characterStates).toContain('北塔'); expect(context.characterStates).not.toContain('旧站'); expect(context.characterStates).not.toContain('猜测地点')
  })
  it('冻结当前及后五章蓝图和目标，历史原文无凭据不变成事实', () => {
    const f = fixture()
    f.db.exec("INSERT INTO contents(id,body) VALUES(2,'历史正文'); INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(1,1,'finalized',2)")
    // 标题带上章号：issue #110 的「同题加尾」判据会把全同标题判成复用，
    // 而本条测试验的是蓝图冻结范围，不该被标题重复干扰。
    for (const chapter of [1,2,3,7,8]) f.db.prepare('INSERT INTO blueprints(chapter_number,title,key_events) VALUES(?,?,?)').run(chapter, `合成章节${chapter}`, '林岚抵达北塔')
    const context = f.capture()
    expect(context.blueprints.map(row => row.chapterNumber)).toEqual([2,3,7])
    expect(context.history).toEqual([expect.objectContaining({ content: '历史正文' })])
    // 只增不减：每条材料额外带上选择契约所需的最小身份，旧字段一字不改。
    expect(context.history[0]!.identity).toEqual({ projectId: '合成项目',
      sourceId: 'finalized:2', revision: 2, contentHash: textHash('历史正文'), provenance: 'legacy' })
    expect(context.history[0]!.projection).toBeUndefined(); expect(context.preflightFindings).toEqual([])
    f.db.exec("UPDATE blueprints SET key_events='作者新目标'")
    expect(f.capture().frozenGoals).not.toEqual(context.frozenGoals)
    expect(context.worldbuilding).toBe('作者世界设定')
  })
  it('确认快照关联原 AI row，同 ID 的另一全局库不能混入', () => {
    const f = fixture(), c = confirmation(f)
    const wrong = new Database(f.db.serialize()); connections.push(wrong)
    wrong.exec("UPDATE contents SET body='错误全局库'")
    vi.mocked(getProjectDb).mockReturnValue(wrong)
    const context = f.capture()
    expect(context.confirmation?.originalReviewContentHash).toBe(textHash('{"summary":"原始 AI 意见"}'))
    expect(context.confirmation?.snapshot.items.map(item => item.decision)).toEqual(['apply','ignore'])
    expect(context.confirmation?.reviewSourceId).toBe(c.saved.id)
  })
  it.each(['bad-json','changed-confirmation','ignored-only','wrong-original-source'])('拒绝确认凭据错误 %s', kind => {
    const f = fixture(), c = confirmation(f)
    if (kind === 'bad-json') f.request.confirmedReviewContent = '{'
    if (kind === 'changed-confirmation') f.request.confirmedReviewContent = c.content.replace('保持动机','不同作者指导')
    if (kind === 'ignored-only') {
      const content = c.content.replaceAll('"apply"','"ignore"')
      f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run(content,c.saved.id)
      f.request.confirmedReviewContent = content
    }
    if (kind === 'wrong-original-source') f.db.prepare('UPDATE reviews SET source_content=? WHERE id=?').run('别稿',c.original.id)
    expect(f.capture).toThrow('GENERATION_REVIEW_CONFIRMATION_CHANGED')
  })
})

it('当前投影提供预检事实，失效或 legacy 投影只保留同一原文', () => {
  const f = fixture(), prose = '林岚已经死亡。'
  f.db.exec("INSERT INTO characters(character_id,name) VALUES('lin','林岚'); INSERT INTO contents(id,body) VALUES(2,'待定稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(2,1,1,'draft',2)")
  f.db.prepare('INSERT INTO blueprints(chapter_number,title,characters,key_events) VALUES(2,?,?,?)').run('归来', JSON.stringify(['林岚']), '林岚归来')
  FinalizationRepository.commit({ finalizationId: 'context-final', draftId: 2, chapterNumber: 1,
    chapterTitle: '告别', content: prose, contentHash: textHash(prose), contentRevision: 1, targetFileName: '1.txt' })
  const generation = f.db.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get() as number
  SummaryRepository.saveFinalizedContinuity({ draftId: 2, chapterNumber: 1, chapterNotes: '告别',
    projectionGeneration: generation, source: { draftId: 2, chapterNumber: 1, finalizationId: 'context-final', contentHash: textHash(prose) },
    facts: [{ category: 'character-state', entities: ['林岚'], statement: prose, evidence: prose, sourceChapter: 1,
      characterRefs: [{ characterId: 'lin', displayNameSnapshot: '林岚' }] }] })
  const current = f.capture()
  expect(current.history[0]!.projection?.sourceStatus).toBe('current')
  expect(current.preflightFindings).toHaveLength(1)
  f.db.exec('UPDATE continuity_projection_meta SET generation=generation+1,stale_from_chapter=1')
  const stale = f.capture()
  expect(stale.history[0]!.content).toBe(prose); expect(stale.history[0]!.projection).toBeUndefined()
  expect(stale.preflightFindings).toEqual([])
  expect(current.preflightFindings).toHaveLength(1)
  f.db.exec("UPDATE summary_snapshots SET source_finalization_id='',source_content_hash=''")
  expect(f.capture().history[0]!.projection).toBeUndefined()
})

it('accepts a reviewed current draft and same-hash archived predecessor, but refuses changed history or newer authority', () => {
 const f=fixture()
 f.db.exec("UPDATE drafts SET status='reviewed' WHERE id=1; INSERT INTO contents(id,body) VALUES(2,'前驱正文'); INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(2,1,1,'archived',2)")
 f.request.expectedDraft.status='reviewed'
 f.db.prepare('UPDATE drafts SET source_dependencies=? WHERE id=1').run(JSON.stringify([{kind:'candidate',draftId:2,contentHash:textHash('前驱正文')}]))
 expect(f.capture().predecessor?.content).toBe('前驱正文')
 f.db.prepare('UPDATE contents SET body=? WHERE id=2').run('作者修改')
 expect(f.capture).toThrow('GENERATION_REVIEW_HISTORY_CHANGED')
 f.db.exec("UPDATE contents SET body='前驱正文' WHERE id=2; INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(2,2,'reviewed',1)")
 expect(f.capture).toThrow('GENERATION_REVIEW_SOURCE_CHANGED')
})

// issue #47 的接线：声明位数与编号位数矛盾 → 审稿 preflight 里出现一条可定位的 warning。
describe('numberingFindings (issue #47)', () => {
  it('第 16 章的原文形态产出 finding，stableFactKey 带章号与位置', () => {
    const findings = numberingFindings({
      chapterNumber: 16,
      content: '墨层慢慢活了。被覆盖的笔画浮出来：编号五位，零三一七，字尾收得急。',
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.sourceChapter).toBe(16)
    expect(findings[0]!.stableFactKey).toContain('numbering:digits:16')
    expect(findings[0]!.evidence).toContain('声明 5 位，实际写出 4 位')
    expect(findings[0]!.issue.zhCN).toContain('位数自相矛盾')
    // 作者能照着改
    expect(findings[0]!.suggestion.zhCN).toContain('要么把声明改成 4 位')
  })

  it('正常章节不产出 finding', () => {
    expect(numberingFindings({ chapterNumber: 3, content: '编号五位，零三一七〇。他把票根收好。' })).toEqual([])
  })
})

// issue #52：第 16 章正文断言「是叶九的手」，第 19 章正文又断言「不是叶九的手」。
describe('assertionReversalFindings (issue #52)', () => {
  it('前章断言、本章否定同一短语时报出，证据指向两章', () => {
    const findings = assertionReversalFindings(
      [{ chapterNumber: 16, content: '温珩的名字果然已被写上，墨迹极新，笔压稳匀，是叶九的手。' }],
      { chapterNumber: 19, content: '他往下按了按，笔压在纸面上抖。不是叶九的手。叶九的笔稳、匀，起笔带锋。' },
      ['周叙', '温珩', '叶九'],
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidence).toContain('第16章正文')
    expect(findings[0]!.evidence).toContain('第19章')
    expect(findings[0]!.stableFactKey).toContain('assertion-reversal:叶九的手')
  })

  it('没有在册角色名时直接返回空（无名单不做推断）', () => {
    expect(assertionReversalFindings(
      [{ chapterNumber: 16, content: '是叶九的手。' }],
      { chapterNumber: 19, content: '不是叶九的手。' },
      [],
    )).toEqual([])
  })

  it('本章只是继续沿用前一章结论时不报', () => {
    expect(assertionReversalFindings(
      [{ chapterNumber: 16, content: '笔压稳匀，是叶九的手。' }],
      { chapterNumber: 17, content: '他把那一笔抄进私册，笔迹与叶九平日一样稳匀。' },
      ['叶九'],
    )).toEqual([])
  })
})

// issue #51：能力上限被同一段自相抵消（第 13 章「用尽」后紧接着又读出）。
describe('abilityBudgetFindings (issue #51)', () => {
  it('同一段内声明用尽后再次成功使用时给出可定位提示', () => {
    const findings = abilityBudgetFindings({
      chapterNumber: 13,
      content: '纸面发了脆，最后一次溯读已经用尽，本班次再读不出第二处。凑近灯，一行字浮出来。',
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.sourceChapter).toBe(13)
    expect(findings[0]!.stableFactKey).toContain('ability-budget:reuse:13')
    expect(findings[0]!.evidence).toContain('用尽')
    expect(findings[0]!.suggestion.zhCN).toContain('恢复条件')
  })

  it('用尽后没有再用时不报（正常「这次真用完了」）', () => {
    expect(abilityBudgetFindings({
      chapterNumber: 5,
      content: '最后一次溯读已经用尽。他把票根收回怀里，夜里什么也没再发生。',
    })).toEqual([])
  })
})

describe('章末收束体检（issue #65 / #66）', () => {
  /** 造一本已定稿若干章的书，正文末段各按需要给。 */
  function bookWithEndings(endings: ReadonlyArray<{ chapter: number; body: string }>) {
    const f = fixture()
    // 基础 fixture 已经放了第 2 章的一稿；本组测试自建章节，先清掉它避免 (chapter,version) 撞唯一键。
    f.db.exec('DELETE FROM drafts WHERE id=1')
    const insert = f.db.prepare('INSERT INTO contents(id,body) VALUES(?,?)')
    const insertDraft = f.db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(?,?,?, 'finalized', ?)")
    for (const [index, ending] of endings.entries()) {
      const contentId = 100 + index
      const draftId = 100 + index
      insert.run(contentId, ending.body)
      insertDraft.run(draftId, ending.chapter, 1, contentId)
    }
    return f
  }

  it('标记蓝图标注与正文实际落幅不符（issue #65）', () => {
    // 第 25 章：蓝图标「物件落幅」，正文却收在温珩的警告台词上。
    const ending = ['他把签收联和纸片叠进风灯罩。', '温珩把最后一圈绳从桩上抹下来：“那你今晚别下船。”'].join(String.fromCharCode(10) + String.fromCharCode(10))
    const f = bookWithEndings([{ chapter: 25, body: ending }])
    f.db.exec(`INSERT INTO blueprints(chapter_number,title,key_events) VALUES(25,'末章','周叙把笔撂下。【收束：物件落幅】')`)
    Object.assign(f.request, {
      draftId: 100,
      expectedDraft: { chapterNumber: 25, version: 1, status: 'finalized', contentHash: textHash(ending) },
    })
    const findings = f.capture().preflightFindings.filter(item => item.stableFactKey.startsWith('chapter-ending:'))
    const mismatch = findings.find(item => item.stableFactKey === 'chapter-ending:label-mismatch:25')
    expect(mismatch).toBeDefined()
    expect(mismatch!.evidence).toContain('物件落幅')
    expect(mismatch!.evidence).toContain('收在台词里')
  })

  it('连续三章通牒式收尾时报出整条链（issue #66）', () => {
    const ending = (line: string) => line
    const f = bookWithEndings([
      { chapter: 1, body: '铺垫。' },
      { chapter: 2, body: ending('周叙推门进去。') },
      { chapter: 3, body: ending('“但你泡了，它就化了。”') },
      { chapter: 4, body: ending('“不签，箱子当场扣下。今夜别想开船。”') },
      { chapter: 5, body: ending('“那你今晚别下船。”') },
    ])
    Object.assign(f.request, {
      draftId: 104,
      expectedDraft: { chapterNumber: 5, version: 1, status: 'finalized', contentHash: textHash('“那你今晚别下船。”') },
    })
    const streak = f.capture().preflightFindings.find(item => item.stableFactKey === 'chapter-ending:ultimatum-streak:5')
    expect(streak).toBeDefined()
    expect(streak!.evidence).toContain('第 3–5 章连续 3 章')
  })

  it('收束正常时不产生这两类发现', () => {
    const f = bookWithEndings([
      { chapter: 1, body: '铺垫。' },
      { chapter: 2, body: '周叙推门进去。' },
      { chapter: 3, body: '“路上小心。”' },
    ])
    Object.assign(f.request, {
      draftId: 102,
      expectedDraft: { chapterNumber: 3, version: 1, status: 'finalized', contentHash: textHash('“路上小心。”') },
    })
    expect(f.capture().preflightFindings.filter(item => item.stableFactKey.startsWith('chapter-ending:'))).toEqual([])
  })
})
