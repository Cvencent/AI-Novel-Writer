import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { CharacterRosterRepository } from '../character-roster-repository'
import { ensureCharacterRosterSchema } from '../character-roster-schema'
import { CharacterRepository } from '../character-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import type { CharacterRosterCommitRequest } from '../../../src/shared/character-roster'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database

function commitRequest(
  overrides: Partial<CharacterRosterCommitRequest> = {},
): CharacterRosterCommitRequest {
  return {
    operationId: 'architecture-run-001',
    expectedRevision: 0,
    schemaVersion: 1,
    entries: [
      {
        name: '林舟',
        role: 'protagonist',
        gender: '男',
        age: '十八岁',
        appearance: '灰袍少年',
        personality: '克制',
        background: '铁砧镇学徒',
        abilities: '锻造',
        motivation: '守住家人',
        relationships: [{ target: '苏绾', relation: '师徒' }],
        arc: '从学徒成长为守护者',
        notes: '左手有旧伤',
      },
      {
        name: '苏绾',
        role: 'supporting',
        gender: '女',
        age: '二十六岁',
        appearance: '青衣剑客',
        personality: '冷静',
        background: '游侠',
        abilities: '剑术',
        motivation: '偿还旧债',
        relationships: [{ target: '林舟', relation: '师徒' }],
        arc: '学会托付',
        notes: '',
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE project_core (
      id TEXT PRIMARY KEY,
      writing_language TEXT NOT NULL DEFAULT 'zh-CN',
      characters_arch TEXT DEFAULT ''
    );
    INSERT INTO project_core (id, characters_arch) VALUES ('main', '');
    CREATE TABLE characters (
      name TEXT PRIMARY KEY,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      background TEXT DEFAULT '',
      abilities TEXT DEFAULT '',
      motivation TEXT DEFAULT '',
      relationships TEXT DEFAULT '',
      arc TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      cs_location TEXT DEFAULT '',
      cs_power_level TEXT DEFAULT '',
      cs_physical_state TEXT DEFAULT '',
      cs_mental_state TEXT DEFAULT '',
      cs_key_items TEXT DEFAULT '',
      cs_recent_events TEXT DEFAULT '',
      cs_updated_at_chapter INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE blueprints (
      chapter_number INTEGER PRIMARY KEY,
      characters TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY,
      chapter_number INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE finalization_outbox (
      finalization_id TEXT PRIMARY KEY,
      draft_id INTEGER NOT NULL UNIQUE,
      chapter_number INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    );
  `)
  ensureCharacterRosterSchema(db)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => {
  db.close()
})

function finalizedSource(draftId: number, chapterNumber: number) {
  return {
    draftId,
    finalizationId: `finalization-${draftId}`,
    chapterNumber,
    contentHash: String(draftId).padStart(64, '0'),
  }
}

function insertDraft(draftId: number, chapterNumber: number, status: 'draft' | 'finalized'): void {
  db.prepare('INSERT INTO drafts (id, chapter_number, status) VALUES (?, ?, ?)')
    .run(draftId, chapterNumber, status)
  if (status === 'finalized') {
    const source = finalizedSource(draftId, chapterNumber)
    db.prepare(`
      INSERT INTO finalization_outbox (finalization_id, draft_id, chapter_number, content_hash)
      VALUES (?, ?, ?, ?)
    `).run(source.finalizationId, source.draftId, source.chapterNumber, source.contentHash)
  }
}

function rawRosterStorage() {
  return {
    core: db.prepare("SELECT characters_arch FROM project_core WHERE id = 'main'").get(),
    cards: db.prepare('SELECT * FROM characters ORDER BY name').all(),
    meta: db.prepare(`
      SELECT schema_version, revision, migration_state, legacy_markdown, projection_hash, fact_hash, updated_at
      FROM character_roster_meta
      WHERE id = 'main'
    `).get(),
    operations: db.prepare(`
      SELECT operation_id, payload_hash, committed_revision, projection_hash, created_at
      FROM character_roster_operations
      ORDER BY operation_id
    `).all(),
  }
}

describe('CharacterRosterRepository public read/commit seam', () => {
  it('keeps a pre-provenance ready roster ready after adding the empty provenance column, backfilling legacy on first read (issue #225)', () => {
    const request = commitRequest({
      entries: commitRequest().entries.map((entry, index) => index === 0
        ? {
            ...entry,
            currentState: {
              location: '旧港口',
              powerLevel: '学徒',
              physicalState: '轻伤',
              mentalState: '警觉',
              keyItems: '旧剑',
              recentEvents: '刚抵达港口',
              updatedAtChapter: 1,
            },
          }
        : entry),
    })
    const committed = CharacterRosterRepository.commit(request)
    const legacyEntries = committed.snapshot.entries.map((entry) => {
      if (!entry.currentState) return entry
      const currentState = { ...entry.currentState }
      delete currentState.provenance
      return { ...entry, currentState }
    })
    const legacyFactHash = createHash('sha256')
      .update(JSON.stringify(legacyEntries), 'utf8')
      .digest('hex')
    db.prepare("UPDATE character_roster_meta SET fact_hash = ? WHERE id = 'main'").run(legacyFactHash)
    db.exec('ALTER TABLE characters DROP COLUMN cs_provenance')

    ensureCharacterRosterSchema(db)

    const upgraded = CharacterRosterRepository.read()
    // issue #225 起语义更新：升列后首次 read 会把缺键的存量补成 legacy 并刷新
    // factHash（否则这些值会永久卡住 derived 链路并被起草兜底误当作者事实）。
    // ready 不变，但 factHash 不再等于旧的「无 provenance 基线」——它等于补标后的事实。
    expect(upgraded.status).toBe('ready')
    expect(upgraded.entries[0]?.currentState?.provenance?.recentEvents?.kind).toBe('legacy')
    expect(upgraded.factHash).not.toBe(legacyFactHash)
  })

  it('keeps the persisted name-only factHash for a project without the identity schema', () => {
    // 没有 character_identity_meta 的旧项目没有稳定角色 ID，公开 factHash
    // 必须继续等于持久化的姓名版本，不能在只读路径上被重写成 ID 版本。
    const committed = CharacterRosterRepository.commit(commitRequest())
    const persisted = db
      .prepare("SELECT fact_hash FROM character_roster_meta WHERE id = 'main'")
      .get() as { fact_hash: string }
    expect(committed.snapshot.factHash).toBe(persisted.fact_hash)

    const reread = CharacterRosterRepository.read()
    expect(reread.factHash).toBe(persisted.fact_hash)
    expect(reread.status).toBe('ready')
  })

  it('normalizes a finite numeric model age without widening other roster fields', () => {
    const base = commitRequest()
    const numericAge = {
      ...base,
      entries: base.entries.map((entry) => (
        entry.name === '林舟' ? { ...entry, age: 18 } : entry
      )),
    } as unknown as CharacterRosterCommitRequest

    const receipt = CharacterRosterRepository.commit(numericAge)
    expect(receipt.snapshot.entries.find((entry) => entry.name === '林舟')?.age).toBe('18')

    for (const invalidAge of [Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
      expect(() => CharacterRosterRepository.commit({
        ...commitRequest({ operationId: `invalid-age-${String(invalidAge)}` }),
        entries: [{ ...base.entries[0], age: invalidAge }, base.entries[1]],
      } as unknown as CharacterRosterCommitRequest)).toThrow(/年龄必须是文本/)
    }
    expect(() => CharacterRosterRepository.commit({
      ...commitRequest({ operationId: 'invalid-name-number' }),
      entries: [{ ...base.entries[0], name: 7 }, base.entries[1]],
    } as unknown as CharacterRosterCommitRequest)).toThrow(/角色名必须是文本/)
  })

  it('renders the canonical shared minor-role label in the deterministic roster projection', () => {
    const receipt = CharacterRosterRepository.commit(commitRequest({
      entries: commitRequest().entries.map(entry => (
        entry.name === '苏绾' ? { ...entry, role: 'minor' as const } : entry
      )),
    }))

    expect(receipt.snapshot.renderedMarkdown).toContain('## 龙套：苏绾')
    expect(receipt.snapshot.renderedMarkdown).not.toContain('## 次要角色：苏绾')
  })

  it('renders an English project roster without Chinese projection labels', () => {
    db.prepare("UPDATE project_core SET writing_language = 'en-US' WHERE id = 'main'").run()

    const receipt = CharacterRosterRepository.commit(commitRequest({
      entries: commitRequest().entries.map(entry => ({
        ...entry,
        name: entry.name === '林舟' ? 'Lin Zhou' : 'Su Wan',
        gender: entry.gender === '男' ? 'male' : 'female',
        age: entry.age === '十八岁' ? '18' : '26',
        appearance: 'plain travel clothes',
        personality: 'calm',
        background: 'harbor investigator',
        abilities: 'investigation',
        motivation: 'find the truth',
        relationships: [{
          target: entry.name === '林舟' ? 'Su Wan' : 'Lin Zhou',
          relation: 'trusted colleague',
        }],
        arc: 'learns to trust others',
        notes: '',
      })),
    }))

    expect(receipt.snapshot.renderedMarkdown).toBe([
      '# Character graph',
      '',
      '## Protagonist: Lin Zhou',
      '- Gender: male',
      '- Age: 18',
      '- Appearance: plain travel clothes',
      '- Personality: calm',
      '- Background: harbor investigator',
      '- Abilities: investigation',
      '- Motivation: find the truth',
      '- Arc: learns to trust others',
      '- Relationship: Su Wan (trusted colleague)',
      '',
      '## Supporting character: Su Wan',
      '- Gender: female',
      '- Age: 26',
      '- Appearance: plain travel clothes',
      '- Personality: calm',
      '- Background: harbor investigator',
      '- Abilities: investigation',
      '- Motivation: find the truth',
      '- Arc: learns to trust others',
      '- Relationship: Lin Zhou (trusted colleague)',
    ].join('\n'))
    expect(receipt.snapshot.renderedMarkdown).not.toMatch(/[\u3400-\u9fff]/u)

    const extraRoles = CharacterRosterRepository.commit({
      operationId: 'english-role-labels',
      expectedRevision: receipt.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: [
        ...receipt.snapshot.entries,
        { ...receipt.snapshot.entries[1], name: 'Rowan Vale', role: 'antagonist' as const, relationships: [] },
        { ...receipt.snapshot.entries[1], name: 'Harbor Clerk', role: 'minor' as const, relationships: [] },
      ],
    })
    expect(extraRoles.snapshot.renderedMarkdown).toContain('## Antagonist: Rowan Vale')
    expect(extraRoles.snapshot.renderedMarkdown).toContain('## Minor character: Harbor Clerk')
  })

  it('keeps a historical Chinese projection readable after a project switches to English, then localizes the next commit', () => {
    const historical = CharacterRosterRepository.commit(commitRequest())
    db.prepare("UPDATE project_core SET writing_language = 'en-US' WHERE id = 'main'").run()

    expect(CharacterRosterRepository.read()).toMatchObject({
      status: 'ready',
      renderedMarkdown: historical.snapshot.renderedMarkdown,
      projectionHash: historical.snapshot.projectionHash,
    })
    expect(CharacterRosterRepository.commit(commitRequest())).toMatchObject({
      idempotent: true,
      snapshot: { status: 'ready', renderedMarkdown: historical.snapshot.renderedMarkdown },
    })

    const localized = CharacterRosterRepository.commit({
      operationId: 'manual-edit-localizes-projection',
      expectedRevision: historical.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: historical.snapshot.entries,
    })
    expect(localized.snapshot).toMatchObject({ status: 'ready', revision: 2 })
    expect(localized.snapshot.renderedMarkdown).toContain('# Character graph')
    expect(localized.snapshot.renderedMarkdown).toContain('## Protagonist: 林舟')
    expect(localized.snapshot.renderedMarkdown).toContain('- Relationship: 苏绾 (师徒)')
  })

  it('uses one manual-edit receipt to rename, delete, preserve free-text relations, update blueprint references, and allow an empty roster', () => {
    const initial = CharacterRosterRepository.commit(commitRequest({
      intent: 'manual_edit',
      entries: commitRequest().entries.map(entry => (
        entry.name === '林舟'
          ? {
              ...entry,
              relationships: [],
              legacyRelationshipNotes: '作者手写的自由关系备注，不能被结构化保存吞掉',
            }
          : entry
      )),
    }))
    db.prepare('INSERT INTO blueprints (chapter_number, characters) VALUES (?, ?)')
      .run(1, JSON.stringify(['林舟', '苏绾']))

    const renamedAndTrimmed = CharacterRosterRepository.commit({
      operationId: 'manual-edit-rename-delete',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      renames: [{ originalName: '林舟', newName: '陆舟' }],
      entries: [{
        ...initial.snapshot.entries.find(entry => entry.name === '林舟')!,
        name: '陆舟',
        // This candidate still names the deleted card. The deep module must
        // remove that structural edge together with the omitted card.
        relationships: [{ target: '苏绾', relation: '旧师徒' }],
        currentState: {
          location: '北境',
          powerLevel: '炼气',
          physicalState: '轻伤',
          mentalState: '警觉',
          keyItems: '旧剑',
          recentEvents: '发现线索',
          updatedAtChapter: 3,
        },
      }],
    })

    expect(renamedAndTrimmed).toMatchObject({
      revision: 2,
      snapshot: {
        status: 'ready',
        entries: [expect.objectContaining({
          name: '陆舟',
          relationships: [],
          legacyRelationshipNotes: '作者手写的自由关系备注，不能被结构化保存吞掉',
          currentState: expect.objectContaining({ updatedAtChapter: 3 }),
        })],
      },
    })
    expect(renamedAndTrimmed.snapshot.factHash).not.toBe(initial.snapshot.factHash)
    expect(db.prepare('SELECT characters FROM blueprints WHERE chapter_number = 1').get())
      .toEqual({ characters: JSON.stringify(['陆舟']) })

    const empty = CharacterRosterRepository.commit({
      operationId: 'manual-edit-delete-last',
      expectedRevision: renamedAndTrimmed.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: [],
    })
    expect(empty.snapshot).toMatchObject({
      revision: 3,
      status: 'empty',
      entries: [],
      renderedMarkdown: '',
    })
  })

  it('fails closed when a legacy direct card write makes the ready roster inconsistent', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const existing = CharacterRepository.getByName('林舟')!
    CharacterRepository.upsert({ ...existing, notes: '旧旁路直接改写了角色事实' })

    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: first.revision,
      status: 'inconsistent',
    })
    expect(() => CharacterRosterRepository.commit(commitRequest({
      operationId: 'architecture-must-not-bypass-inconsistent-roster',
      expectedRevision: first.revision,
      intent: 'architecture_generation',
    }))).toThrow(/状态不一致/)
    expect(CharacterRepository.getByName('林舟')?.notes).toBe('旧旁路直接改写了角色事实')
  })

  it('rejects free-text relationship evidence outside a manual edit', () => {
    expect(() => CharacterRosterRepository.commit(commitRequest({
      intent: 'novel_import',
      entries: commitRequest().entries.map(entry => ({
        ...entry,
        legacyRelationshipNotes: '导入候选不得携带旧自由文本关系',
      })),
    }))).toThrow(/只有手工角色管理可以提交自由文本关系/)
  })

  it('commits a validated roster and its deterministic projection as one ready snapshot', () => {
    const receipt = CharacterRosterRepository.commit(commitRequest())

    expect(receipt).toMatchObject({
      idempotent: false,
      operationId: 'architecture-run-001',
      revision: 1,
      snapshot: {
        schemaVersion: 1,
        revision: 1,
        migrationState: 'ready',
        entries: [
          expect.objectContaining({
            name: '林舟',
            relationships: [{ target: '苏绾', relation: '师徒' }],
          }),
          expect.objectContaining({
            name: '苏绾',
            relationships: [{ target: '林舟', relation: '师徒' }],
          }),
        ],
        renderedMarkdown: [
          '# 角色图谱',
          '',
          '## 主角：林舟',
          '- 性别：男',
          '- 年龄：十八岁',
          '- 外貌：灰袍少年',
          '- 性格：克制',
          '- 背景：铁砧镇学徒',
          '- 能力：锻造',
          '- 动机：守住家人',
          '- 弧光：从学徒成长为守护者',
          '- 备注：左手有旧伤',
          '- 关系：苏绾（师徒）',
          '',
          '## 配角：苏绾',
          '- 性别：女',
          '- 年龄：二十六岁',
          '- 外貌：青衣剑客',
          '- 性格：冷静',
          '- 背景：游侠',
          '- 能力：剑术',
          '- 动机：偿还旧债',
          '- 弧光：学会托付',
          '- 关系：林舟（师徒）',
        ].join('\n'),
      },
    })

    expect(CharacterRosterRepository.read()).toEqual(receipt.snapshot)
  })

  it('returns the original receipt for an idempotent operation replay without writing a second revision', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const replay = CharacterRosterRepository.commit(commitRequest())

    expect(replay).toMatchObject({
      operationId: first.operationId,
      payloadHash: first.payloadHash,
      revision: 1,
      idempotent: true,
    })
    expect(CharacterRosterRepository.read().revision).toBe(1)
  })

  it('returns a current consistent idempotent observation when replaying an older operation after a later commit', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const second = CharacterRosterRepository.commit({
      operationId: 'manual-edit-after-first-operation',
      expectedRevision: first.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: first.snapshot.entries.map(entry => (
        entry.name === '林舟'
          ? { ...entry, notes: 'B 已成为当前角色事实' }
          : entry
      )),
    })
    const operationCountBeforeReplay = (db.prepare(
      'SELECT COUNT(*) AS count FROM character_roster_operations',
    ).get() as { count: number }).count

    const replay = CharacterRosterRepository.commit(commitRequest())

    expect(replay).toMatchObject({
      operationId: first.operationId,
      payloadHash: first.payloadHash,
      idempotent: true,
      revision: second.revision,
      snapshot: {
        revision: second.revision,
        entries: expect.arrayContaining([
          expect.objectContaining({ name: '林舟', notes: 'B 已成为当前角色事实' }),
        ]),
      },
    })
    expect(replay.revision).toBe(replay.snapshot.revision)
    expect(replay.snapshot).toEqual(second.snapshot)
    expect((db.prepare('SELECT COUNT(*) AS count FROM character_roster_operations').get() as { count: number }).count)
      .toBe(operationCountBeforeReplay)
  })

  it('rejects a reused operation ID with a different payload and a stale revision without changing the roster', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const differentPayload = commitRequest({
      entries: commitRequest().entries.map(entry => (
        entry.name === '林舟' ? { ...entry, notes: '不同 payload' } : entry
      )),
    })

    expect(() => CharacterRosterRepository.commit(differentPayload))
      .toThrow(/操作 ID 已被用于不同的角色名单/)
    expect(() => CharacterRosterRepository.commit(commitRequest({
      operationId: 'architecture-run-002',
      expectedRevision: 0,
    }))).toThrow(/revision 已过期/)
    expect(CharacterRosterRepository.read()).toEqual(first.snapshot)
  })

  it('rejects a candidate with a dangling relationship before any facts are written', () => {
    const invalid = commitRequest({
      entries: [{
        ...commitRequest().entries[0],
        relationships: [{ target: '不存在的角色', relation: '敌对' }],
      }],
    })

    expect(() => CharacterRosterRepository.commit(invalid))
      .toThrow(/不存在的关系目标/)
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'empty',
      entries: [],
      renderedMarkdown: '',
    })
  })

  it('fails closed for an unsupported schema, duplicate identity, invalid role and self relation', () => {
    const base = commitRequest()
    const invalidCandidates: Array<{ candidate: CharacterRosterCommitRequest; error: RegExp }> = [
      {
        candidate: { ...base, schemaVersion: 2 as 1 },
        error: /schema 版本不受支持/,
      },
      {
        candidate: {
          ...base,
          entries: [base.entries[0], {
            ...base.entries[1],
            name: '林舟',
            relationships: [],
          }],
        },
        error: /角色名必须唯一/,
      },
      {
        candidate: {
          ...base,
          entries: [{ ...base.entries[0], role: 'villain' as never }],
        },
        error: /定位无效/,
      },
      {
        candidate: {
          ...base,
          entries: [{
            ...base.entries[0],
            relationships: [{ target: '林舟', relation: '镜像' }],
          }],
        },
        error: /不能建立自指关系/,
      },
    ]

    for (const { candidate, error } of invalidCandidates) {
      expect(() => CharacterRosterRepository.commit(candidate)).toThrow(error)
    }
    expect(CharacterRosterRepository.read().revision).toBe(0)
  })

  it('rolls back cards, projection, revision and receipt together when the final receipt write faults', () => {
    db.exec(`
      CREATE TRIGGER character_roster_test_receipt_fault
      BEFORE INSERT ON character_roster_operations
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt fault');
      END;
    `)

    expect(() => CharacterRosterRepository.commit(commitRequest()))
      .toThrow(/injected receipt fault/)
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'empty',
      entries: [],
      renderedMarkdown: '',
    })
    expect(ProjectCoreRepository.get()?.charactersArch).toBe('')
  })

  it('rolls back inserted cards when the projection write faults before meta and receipt are recorded', () => {
    db.exec(`
      CREATE TRIGGER character_roster_test_projection_fault
      BEFORE UPDATE OF characters_arch ON project_core
      BEGIN
        SELECT RAISE(ABORT, 'injected projection fault');
      END;
    `)

    expect(() => CharacterRosterRepository.commit(commitRequest()))
      .toThrow(/injected projection fault/)
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'empty',
      entries: [],
      renderedMarkdown: '',
    })
    expect(ProjectCoreRepository.get()?.charactersArch).toBe('')
  })

  it('exposes existing cards as preserved legacy facts and refuses to overwrite them through the new seam', () => {
    db.exec('DELETE FROM character_roster_meta')
    CharacterRepository.upsert({
      name: '手工角色',
      role: 'protagonist',
      gender: '',
      age: '',
      appearance: '',
      personality: '',
      background: '',
      abilities: '',
      motivation: '',
      relationships: '自由文本关系必须原样保留',
      arc: '',
      notes: '用户手工填写',
    })
    ensureCharacterRosterSchema(db)

    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'legacy_cards_preserved',
      status: 'inconsistent',
      entries: [expect.objectContaining({
        name: '手工角色',
        notes: '用户手工填写',
        legacyRelationshipNotes: '自由文本关系必须原样保留',
      })],
    })
    expect(() => CharacterRosterRepository.commit(commitRequest()))
      .toThrow(/已有角色数据受到保护/)
    expect(CharacterRosterRepository.read().entries).toEqual([
      expect.objectContaining({ name: '手工角色', notes: '用户手工填写' }),
    ])
  })

  it('safely regenerates a structured roster around existing manual cards without replacing non-empty fields', () => {
    db.exec('DELETE FROM character_roster_meta')
    CharacterRepository.upsert({
      name: '林舟',
      role: 'supporting',
      gender: '',
      age: '',
      appearance: '作者手写的旧斗篷',
      personality: '',
      background: '',
      abilities: '',
      motivation: '',
      relationships: '作者手工填写的旧关系备注，不得被生成 JSON 覆盖',
      arc: '',
      notes: '作者已确认，不应覆盖',
    })
    ensureCharacterRosterSchema(db)

    // 旧项目先由显式 adoption 固化 cards -> projection；架构重新生成不再
    // 获得绕过 inconsistent 状态的特权。
    const preserved = CharacterRosterRepository.read()
    const adopted = CharacterRosterRepository.commit({
      operationId: 'adopt-before-architecture-regeneration',
      expectedRevision: preserved.revision,
      schemaVersion: 1,
      entries: preserved.entries.map((entry) => {
        const structuredEntry = { ...entry }
        delete structuredEntry.legacyRelationshipNotes
        return structuredEntry
      }),
      intent: 'legacy_cards_adoption',
      expectedLegacyMarkdown: preserved.legacyMarkdown ?? '',
    })

    const receipt = CharacterRosterRepository.commit({
      ...commitRequest({
        operationId: 'architecture-regeneration-001',
        expectedRevision: adopted.revision,
      }),
      intent: 'architecture_generation',
    })

    expect(receipt.snapshot).toMatchObject({
      revision: 2,
      migrationState: 'ready',
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: '林舟',
          role: 'supporting',
          appearance: '作者手写的旧斗篷',
          notes: '作者已确认，不应覆盖',
          background: '铁砧镇学徒',
          legacyRelationshipNotes: '作者手工填写的旧关系备注，不得被生成 JSON 覆盖',
        }),
        expect.objectContaining({ name: '苏绾', role: 'supporting' }),
      ]),
    })
    expect(CharacterRosterRepository.read().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: '林舟',
        appearance: '作者手写的旧斗篷',
        legacyRelationshipNotes: '作者手工填写的旧关系备注，不得被生成 JSON 覆盖',
      }),
      expect.objectContaining({ name: '苏绾' }),
    ]))
    expect(CharacterRepository.getByName('林舟')?.relationships)
      .toBe('作者手工填写的旧关系备注，不得被生成 JSON 覆盖')
  })

  it('creates a second roster revision while preserving a manual edit made after the first structured commit', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const manual = CharacterRosterRepository.commit({
      operationId: 'manual-edit-after-first-generation',
      expectedRevision: first.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: first.snapshot.entries.map(entry => (
        entry.name === '林舟'
          ? { ...entry, appearance: '作者在角色管理中补写的红色旧斗篷' }
          : entry
      )),
    })
    const newCharacter = {
      name: '顾临',
      role: 'antagonist' as const,
      gender: '男',
      age: '三十岁',
      appearance: '玄铁面具',
      personality: '偏执',
      background: '旧王朝遗臣',
      abilities: '阵法',
      motivation: '复辟旧朝',
      relationships: [],
      arc: '承认失败',
      notes: '',
    }

    const second = CharacterRosterRepository.commit({
      ...commitRequest({
        operationId: 'architecture-regeneration-002',
        expectedRevision: manual.revision,
        entries: [...commitRequest().entries, newCharacter],
      }),
      intent: 'architecture_generation',
    })

    expect(second).toMatchObject({ revision: 3, idempotent: false })
    expect(second.snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '林舟', appearance: '作者在角色管理中补写的红色旧斗篷' }),
      expect.objectContaining({ name: '顾临', role: 'antagonist' }),
    ]))
  })

  it.each(['architecture_generation', 'novel_import'] as const)(
    'merges a canonical-equivalent %s identity while preserving manual fields',
    (intent) => {
      const existing = {
        ...commitRequest().entries[0],
        name: 'Alice',
        appearance: '作者手写的旧斗篷',
        background: '',
        relationships: [],
      }
      const initial = CharacterRosterRepository.commit(commitRequest({ entries: [existing] }))

      const receipt = CharacterRosterRepository.commit({
        operationId: `${intent}-canonical-existing-name`,
        expectedRevision: initial.revision,
        schemaVersion: 1,
        intent,
        entries: [{
          ...existing,
          name: ' ALICE ',
          appearance: '模型试图覆盖的银色斗篷',
          background: '模型补齐的航海经历',
        }],
      })

      expect(receipt.snapshot.entries).toEqual([
        expect.objectContaining({
          name: 'Alice',
          appearance: '作者手写的旧斗篷',
          background: '模型补齐的航海经历',
        }),
      ])
    },
  )

  it('archives legacy Markdown as migration evidence instead of parsing it as a roster', () => {
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core
      SET characters_arch = '## 主角：这段旧文本不能自动成为事实';
    `)
    ensureCharacterRosterSchema(db)

    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'legacy_markdown_pending',
      status: 'legacy_repair_required',
      entries: [],
      renderedMarkdown: '',
      legacyMarkdown: '## 主角：这段旧文本不能自动成为事实',
    })
  })

  it('rejects normal generation for a zero-card legacy graph without changing its raw evidence, cards, or roster metadata', () => {
    const legacyMarkdown = '旧角色图谱原文：没有角色卡时，普通架构生成不得把它转为 ready。'
    db.prepare('DELETE FROM character_roster_meta').run()
    db.prepare("UPDATE project_core SET characters_arch = ? WHERE id = 'main'").run(legacyMarkdown)
    ensureCharacterRosterSchema(db)
    const before = rawRosterStorage()

    expect(() => CharacterRosterRepository.commit(commitRequest({
      operationId: 'normal-generation-must-not-migrate-legacy-markdown',
      intent: 'architecture_generation',
    }))).toThrow(/只能通过显式旧角色图谱修复/)

    expect(rawRosterStorage()).toEqual(before)
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'legacy_markdown_pending',
      status: 'legacy_repair_required',
      entries: [],
      legacyMarkdown,
    })
  })

  it('repairs a v0.7.1 zero-card legacy graph only through an exact-evidence structured commit', () => {
    const legacyMarkdown = '矿场事故后，沈砺和顾湘从互相怀疑走向共同调查。这里没有可供程序解析的标题或编号。'
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core
      SET characters_arch = '${legacyMarkdown}';
    `)
    ensureCharacterRosterSchema(db)
    const before = CharacterRosterRepository.read()

    const receipt = CharacterRosterRepository.commit({
      ...commitRequest({ operationId: 'legacy-repair-v071', expectedRevision: before.revision }),
      intent: 'legacy_repair',
      expectedLegacyMarkdown: legacyMarkdown,
    })

    expect(receipt).toMatchObject({
      revision: 1,
      idempotent: false,
      snapshot: {
        migrationState: 'ready',
        status: 'ready',
        legacyMarkdown,
        entries: expect.arrayContaining([
          expect.objectContaining({ name: '林舟' }),
          expect.objectContaining({ name: '苏绾' }),
        ]),
      },
    })
    expect(ProjectCoreRepository.get()?.charactersArch).toBe(receipt.snapshot.renderedMarkdown)
    expect(CharacterRosterRepository.commit({
      ...commitRequest({ operationId: 'legacy-repair-v071', expectedRevision: before.revision }),
      intent: 'legacy_repair',
      expectedLegacyMarkdown: legacyMarkdown,
    })).toMatchObject({ idempotent: true, revision: 1 })
  })

  it('rejects a legacy repair whose archived source changed, without touching cards or the old graph', () => {
    const legacyMarkdown = '旧图谱原文 A：只有自然语言关系，没有固定 Markdown 排版。'
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core
      SET characters_arch = '${legacyMarkdown}';
    `)
    ensureCharacterRosterSchema(db)
    const before = CharacterRosterRepository.read()

    expect(() => CharacterRosterRepository.commit({
      ...commitRequest({ operationId: 'legacy-repair-stale-source' }),
      intent: 'legacy_repair',
      expectedLegacyMarkdown: '旧图谱原文 B：模型候选不可以写回 A。',
    })).toThrow(/旧角色图谱已变更/)

    expect(CharacterRosterRepository.read()).toEqual(before)
    expect(ProjectCoreRepository.get()?.charactersArch).toBe(legacyMarkdown)
  })

  it('classifies empty, existing-card, partial-card and damaged legacy projects without auto-writing', () => {
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'empty',
      status: 'empty',
      entries: [],
    })

    CharacterRepository.upsert({
      name: '已有角色',
      role: 'supporting',
      gender: '', age: '', appearance: '', personality: '', background: '', abilities: '', motivation: '',
      relationships: '', arc: '', notes: '用户已手工填写',
    })
    // #83 之前旧编辑入口还会直接写 characters；读取只把它当受保护事实，
    // 不触发任何 Markdown 解析或覆盖。
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'empty',
      status: 'inconsistent',
      entries: [expect.objectContaining({ name: '已有角色' })],
    })

    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core SET characters_arch = '旧图谱存在，但此前只保存了一张手工角色卡。';
    `)
    ensureCharacterRosterSchema(db)
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'legacy_cards_preserved',
      status: 'inconsistent',
      entries: [expect.objectContaining({ name: '已有角色', notes: '用户已手工填写' })],
    })

    // 将元数据刻意置为“待修复”而数据库已有卡，代表损坏/不一致状态。
    db.prepare("UPDATE character_roster_meta SET migration_state = 'legacy_markdown_pending'").run()
    expect(CharacterRosterRepository.read()).toMatchObject({ status: 'inconsistent' })
  })

  it('explicitly adopts existing legacy cards by rebuilding only the deterministic projection', () => {
    const legacyMarkdown = '旧角色图谱原文：已有角色卡是事实，不应重新从这里提取。'
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core SET characters_arch = '${legacyMarkdown}';
    `)
    CharacterRepository.upsert({
      name: '手工主角',
      role: 'protagonist',
      gender: '女', age: '二十五岁', appearance: '作者手写的黑色风衣', personality: '谨慎',
      background: '作者手工设定的背景', abilities: '调查', motivation: '寻找真相',
      relationships: '作者手工填写的自由文本关系，必须原样保留', arc: '学会信任', notes: '不可覆盖',
    })
    ensureCharacterRosterSchema(db)
    const before = CharacterRosterRepository.read()
    const cardBefore = CharacterRepository.getByName('手工主角')

    expect(before).toMatchObject({
      migrationState: 'legacy_cards_preserved',
      status: 'inconsistent',
      entries: [expect.objectContaining({ legacyRelationshipNotes: '作者手工填写的自由文本关系，必须原样保留' })],
    })

    const receipt = CharacterRosterRepository.commit({
      operationId: 'adopt-existing-cards',
      expectedRevision: before.revision,
      schemaVersion: 1,
      entries: before.entries.map((entry) => {
        const structuredEntry = { ...entry }
        delete structuredEntry.legacyRelationshipNotes
        return structuredEntry
      }),
      intent: 'legacy_cards_adoption',
      expectedLegacyMarkdown: legacyMarkdown,
    })

    expect(receipt.snapshot).toMatchObject({
      migrationState: 'ready',
      status: 'ready',
      legacyMarkdown,
      entries: [expect.objectContaining({ name: '手工主角' })],
    })
    expect(ProjectCoreRepository.get()?.charactersArch).toBe(receipt.snapshot.renderedMarkdown)
    expect(CharacterRepository.getByName('手工主角')).toEqual(cardBefore)
  })

  it('rejects chapter-progress additions and canonical duplicate names at the repository boundary', () => {
    const initial = CharacterRosterRepository.commit(commitRequest())
    insertDraft(2, 2, 'finalized')
    const existing = initial.snapshot.entries[0]
    const unknown = {
      ...existing,
      name: '未知角色',
      relationships: [],
      currentState: {
        location: '码头',
        powerLevel: '',
        physicalState: '',
        mentalState: '',
        keyItems: '',
        recentEvents: '突然出现',
        updatedAtChapter: 2,
      },
    }

    expect(() => CharacterRosterRepository.commit({
      operationId: 'chapter-progress-unknown',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source: finalizedSource(2, 2),
      entries: [unknown],
    })).toThrow(/不能创建未知角色/)
    expect(CharacterRosterRepository.read()).toEqual(initial.snapshot)

    expect(() => CharacterRosterRepository.commit({
      operationId: 'chapter-progress-duplicate',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source: finalizedSource(2, 2),
      entries: [
        { ...existing, relationships: [] },
        { ...existing, name: ` ${existing.name.toLocaleUpperCase('en-US')} `, relationships: [] },
      ],
    })).toThrow(/角色名必须唯一/)
    expect(CharacterRosterRepository.read()).toEqual(initial.snapshot)
  })

  it('rejects chapter progress older than a genuinely finalized character state', () => {
    const base = commitRequest()
    const initial = CharacterRosterRepository.commit({
      ...base,
      entries: base.entries.map(entry => ({
        ...entry,
        currentState: {
          location: '第三章现场',
          powerLevel: '',
          physicalState: '',
          mentalState: '',
          keyItems: '',
          recentEvents: '',
          updatedAtChapter: 3,
        },
      })),
    })
    insertDraft(2, 2, 'finalized')
    insertDraft(3, 3, 'finalized')
    const existing = initial.snapshot.entries[0]

    expect(() => CharacterRosterRepository.commit({
      operationId: 'older-finalized-chapter-progress',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source: finalizedSource(2, 2),
      entries: [{
        ...existing,
        relationships: [],
        currentState: { ...existing.currentState!, location: '第二章现场', updatedAtChapter: 2 },
      }],
    })).toThrow(/较新章节更新/)
  })

  it('preserves a non-empty legacy state instead of reclassifying it as derived', () => {
    const base = commitRequest()
    const initial = CharacterRosterRepository.commit({
      ...base,
      entries: base.entries.map(entry => ({
        ...entry,
        currentState: {
          location: '受污染的未来状态',
          powerLevel: '',
          physicalState: '',
          mentalState: '',
          keyItems: '',
          recentEvents: '',
          updatedAtChapter: 3,
        },
      })),
    })
    insertDraft(2, 2, 'finalized')
    const existing = initial.snapshot.entries[0]

    const receipt = CharacterRosterRepository.commit({
      operationId: 'repair-future-chapter-progress',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source: finalizedSource(2, 2),
      entries: [{
        ...existing,
        relationships: [],
        currentState: {
          ...existing.currentState!,
          location: '第二章现场',
          updatedAtChapter: 2,
          provenance: {
            ...existing.currentState!.provenance,
            location: { kind: 'derived', source: finalizedSource(2, 2) },
          },
        },
      }],
    })

    expect(receipt.snapshot.entries.find(entry => entry.name === existing.name)?.currentState)
      .toMatchObject({ location: '受污染的未来状态', updatedAtChapter: 3 })
  })

  it('rejects chapter progress whose candidate chapter is not finalized', () => {
    const base = commitRequest()
    const initial = CharacterRosterRepository.commit({
      ...base,
      entries: base.entries.map(entry => ({
        ...entry,
        currentState: {
          location: '第一章现场',
          powerLevel: '',
          physicalState: '',
          mentalState: '',
          keyItems: '',
          recentEvents: '',
          updatedAtChapter: 1,
        },
      })),
    })
    insertDraft(2, 2, 'draft')
    const existing = initial.snapshot.entries[0]

    expect(() => CharacterRosterRepository.commit({
      operationId: 'unfinalized-chapter-progress',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source: finalizedSource(2, 2),
      entries: [{
        ...existing,
        relationships: [],
        currentState: { ...existing.currentState!, location: '第二章现场', updatedAtChapter: 2 },
      }],
    })).toThrow(/来源已失效/)
  })

  it('preserves an author field while accepting a derived patch for a different empty field', () => {
    const initial = CharacterRosterRepository.commit(commitRequest())
    const authored = CharacterRosterRepository.commit({
      operationId: 'manual-state-source',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: initial.snapshot.entries.map((entry, index) => index === 0 ? {
        ...entry,
        currentState: {
          location: '作者设定的山庄',
          powerLevel: '',
          physicalState: '',
          mentalState: '',
          keyItems: '',
          recentEvents: '',
          updatedAtChapter: 1,
        },
      } : entry),
    })
    insertDraft(2, 2, 'finalized')
    const existing = authored.snapshot.entries[0]!
    const source = finalizedSource(2, 2)

    const derived = CharacterRosterRepository.commit({
      operationId: 'derived-state-source',
      expectedRevision: authored.revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source,
      entries: [{
        ...existing,
        currentState: {
          ...existing.currentState!,
          location: '模型试图覆盖的码头',
          mentalState: '警觉',
          updatedAtChapter: 2,
          provenance: {
            location: { kind: 'derived', source },
            mentalState: { kind: 'derived', source },
          },
        },
      }],
    })

    expect(derived.snapshot.entries[0]?.currentState).toMatchObject({
      location: '作者设定的山庄',
      mentalState: '警觉',
      updatedAtChapter: 2,
      provenance: {
        location: { kind: 'author', chapterNumber: 1 },
        mentalState: { kind: 'derived', source },
      },
    })
  })
})

it('runs the main generation source guard inside the write transaction but not on durable replay', () => {
  const request = commitRequest()
  const rejected = vi.fn(() => { expect(db.inTransaction).toBe(true); throw new Error('GENERATION_SOURCE_CHANGED') })
  expect(() => CharacterRosterRepository.commit(request, rejected)).toThrow('GENERATION_SOURCE_CHANGED')
  expect(CharacterRepository.count()).toBe(0)
  expect(db.prepare('SELECT COUNT(*) FROM character_roster_operations').pluck().get()).toBe(0)
  const accepted = vi.fn(() => { expect(db.inTransaction).toBe(true) })
  CharacterRosterRepository.commit(request, accepted)
  expect(accepted).toHaveBeenCalledTimes(1)
  expect(CharacterRosterRepository.commit(request, rejected).idempotent).toBe(true)
  expect(rejected).toHaveBeenCalledTimes(1)
})

/**
 * issue #225：读路径的存量自愈——「有值的 cs_* 字段但 provenance 缺该字段键」
 * 在 `CharacterRosterRepository.read` 时被**持久化**补成 `kind:'legacy'`。
 *
 * 为什么必须在写库侧补而不是读出层：fullFactHash 把 provenance 算进事实，
 * 读出补标会让哈希漂移、ready 名单被误判 inconsistent。补标后 fact_hash 由
 * `repairFactHashAfterBackfill` 重算——且只在「不一致完全由补标引起」（剥掉
 * provenance 的哈希恰等于旧 meta.fact_hash）时才修，旧旁路直写造成的
 * inconsistent 必须保持 fails closed。
 */

/**
 * issue #225：读路径的存量自愈——「有值的 cs_* 字段但 provenance 缺该字段键」
 * 在 `CharacterRosterRepository.read` 时被**持久化**补成 `kind:'legacy'`。
 *
 * ⚠️ 缺键只会出现在 **v2 之前的存量库**（旧写入路径直写 SQL，不经 normalizeState；
 * 经 commit seam 写入的数据已被 normalizeState 补齐）。为什么在写库侧补而不是
 * 读出层：fullFactHash 把 provenance 算进事实，读出补标会让哈希漂移、ready 名单
 * 被误判 inconsistent。补标后的 fact_hash 由 repairFactHashAfterBackfill 重算——
 * 且只在「不一致完全由补标引起」（剥掉 provenance 的哈希恰等于旧 meta.fact_hash）
 * 时才修；旧旁路直写造成的 inconsistent 必须保持 fails closed。
 */
describe('cs_* 字段 provenance 缺键的持久化补标 (issue #225)', () => {
  it('backfills kind:legacy on read and keeps the roster ready with a refreshed fact hash', () => {
    const committed = CharacterRosterRepository.commit(commitRequest())
    // 手工把第 0 张卡改回「v2 之前」的存量形态：recentEvents 有值、provenance 整列清空
    // （默认 commitRequest 的 entries 没有 currentState，先直写一版状态再清来源）。
    db.prepare("UPDATE characters SET cs_recent_events='刚抵达港口', cs_updated_at_chapter=1, cs_provenance='{}' WHERE name=?").run('林舟')
    const legacyEntries = committed.snapshot.entries.map((entry, index) => index === 0
      ? { ...entry, currentState: { location: '', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '刚抵达港口', updatedAtChapter: 1 } }
      : entry)
    // 旧对账基线 = 剥掉 provenance 后的哈希（legacy 项目 fact_hash 存的就是它）。
    db.prepare("UPDATE character_roster_meta SET fact_hash=? WHERE id='main'").run(
      createHash('sha256').update(JSON.stringify(legacyEntries), 'utf8').digest('hex'))

    const upgraded = CharacterRosterRepository.read()
    expect(upgraded.status).toBe('ready')
    const state = upgraded.entries.find(entry => entry.name === '林舟')!.currentState!
    expect(state.recentEvents).not.toBe('')
    expect(state.provenance!.recentEvents!.kind).toBe('legacy')
    // 幂等：再读一遍仍是 ready、标记仍在。
    const again = CharacterRosterRepository.read()
    expect(again.status).toBe('ready')
    expect(again.entries.find(entry => entry.name === '林舟')!.currentState!.provenance!.recentEvents!.kind).toBe('legacy')
  })

  it('does not repair an inconsistency caused by a direct card write (fails closed preserved)', () => {
    CharacterRosterRepository.commit(commitRequest())
    CharacterRepository.upsert({ ...CharacterRepository.getByName('林舟')!, notes: '旧旁路直接改写' })
    const snapshot = CharacterRosterRepository.read()
    expect(snapshot.status).toBe('inconsistent')
  })
})

/**
 * issue #225 建议 ③：mergeDerivedCurrentState 遇到受保护的旧值（author/legacy）
 * 跳过该字段——旧实现静默 continue，commit 账本记了回写、卡上没写，「两套账」
 * 从此分叉且无任何信号。现在跳过明细随 receipt.skippedCharacterStateFields 带回。
 */
describe('受保护字段的 skipped 明细随 receipt 带回 (issue #225 ③)', () => {
  it('reports author-protected skips in the receipt while applying other derived fields', () => {
    const initial = CharacterRosterRepository.commit(commitRequest())
    const authored = CharacterRosterRepository.commit({
      operationId: 'manual-state-source-skipped',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: initial.snapshot.entries.map((entry, index) => index === 0 ? {
        ...entry,
        currentState: {
          location: '作者设定的山庄',
          powerLevel: '',
          physicalState: '',
          mentalState: '',
          keyItems: '',
          recentEvents: '',
          updatedAtChapter: 1,
        },
      } : entry),
    })
    insertDraft(2, 2, 'finalized')
    const existing = authored.snapshot.entries[0]!
    const source = finalizedSource(2, 2)
    const derived = CharacterRosterRepository.commit({
      operationId: 'derived-state-skipped',
      expectedRevision: authored.revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source,
      entries: [{
        ...existing,
        currentState: {
          ...existing.currentState!,
          location: '模型试图覆盖的码头',
          mentalState: '警觉',
          updatedAtChapter: 2,
          provenance: {
            location: { kind: 'derived', source },
            mentalState: { kind: 'derived', source },
          },
        },
      }],
    })
    // 卡上：作者值保持；receipt：跳过明细可诊断。
    expect(derived.snapshot.entries[0]?.currentState?.location).toBe('作者设定的山庄')
    expect(derived.skippedCharacterStateFields).toEqual([
      { characterName: '林舟', field: 'location', reason: 'author-protected' },
    ])
  })

  it('reports legacy-protected skips the same way', () => {
    const initial = CharacterRosterRepository.commit(commitRequest())
    // 先给林舟一个完整 currentState（commit seam 写入会补 provenance），再把 location 改成 legacy。
    CharacterRosterRepository.commit({
      operationId: 'seed-state-for-legacy',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: initial.snapshot.entries.map((entry, index) => index === 0 ? {
        ...entry,
        currentState: { location: '旧码头', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 1 },
      } : entry),
    })
    // 直接把卡上的 location 改成 legacy 保护值（模拟 v2 之前的存量语义）。
    const row = db.prepare("SELECT cs_provenance FROM characters WHERE name='林舟'").pluck().get() as string
    const provenance = JSON.parse(row || '{}') as Record<string, unknown>
    provenance.location = { kind: 'legacy' }
    db.prepare("UPDATE characters SET cs_location='存量写的旧码头', cs_provenance=? WHERE name='林舟'").run(JSON.stringify(provenance))
    // direct write 使 factHash 过期（cs_* 进 fullFactHash）——按既有 repair 语义恢复对账。
    CharacterRosterRepository.repairFactHashIfSafe(db)
    insertDraft(2, 2, 'finalized')
    const existing = CharacterRosterRepository.read().entries.find(entry => entry.name === '林舟')!
    const source = finalizedSource(2, 2)
    const derived = CharacterRosterRepository.commit({
      operationId: 'derived-state-legacy-skip',
      expectedRevision: CharacterRosterRepository.read().revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source,
      entries: [{
        ...existing,
        currentState: {
          ...existing.currentState!,
          location: '模型给出的新位置',
          updatedAtChapter: 2,
          provenance: {
            ...existing.currentState!.provenance,
            location: { kind: 'derived', source },
          },
        },
      }],
    })
    expect(derived.snapshot.entries.find(entry => entry.name === '林舟')?.currentState?.location).toBe('存量写的旧码头')
    expect(derived.skippedCharacterStateFields).toEqual([
      { characterName: '林舟', field: 'location', reason: 'legacy-protected' },
    ])
  })
})
