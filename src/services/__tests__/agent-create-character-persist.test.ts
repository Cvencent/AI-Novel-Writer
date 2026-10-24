import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import { assignCharacterIdForNewCard, characterCardFromRosterEntry, characterRosterEntryFromCard } from '../character-roster-client'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { CharacterRosterRepository, refreshCharacterIdentityProjection } from '../../../electron/repositories/character-roster-repository'
import { commitAuthorCharacterRoster } from '../../../electron/services/character-roster-author'
import type { CharacterData } from '../../../electron/repositories/character-repository'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))

it('a model-created character actually persists on an identity-schema project', () => {
  const base = path.resolve('.runtime/.cache/agent-create')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'create-'))
  prepareCanonicalStorageFixture(root)
  const file = path.join(root, '.ai-novel', 'project.db')
  const db = new Database(file)
  db.pragma('foreign_keys=ON')
  db.exec("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','创作测试','zh-CN')")
  db.prepare('INSERT INTO characters(character_id,name,role) VALUES(?,?,?)').run('lead','林澈','protagonist')
  db.transaction(() => refreshCharacterIdentityProjection(db))()
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

  const before = CharacterRosterRepository.read(db)
  expect(before.status).toBe('ready')
  expect(before.entries.some(e => e.name === '程立')).toBe(false)

  const cards = before.entries.map(characterCardFromRosterEntry)
  const newCard: CharacterData = { name: '程立', role: 'minor', gender: '男', age: '18', appearance: '', personality: '话少', background: '废脉班学生', abilities: '', motivation: '改回评级', relationships: '', arc: '', notes: '' }
  const withId = assignCharacterIdForNewCard(newCard, () => '11111111-2222-4333-8444-555555555555')
  const request = {
    operationId: 'agent-create-character:程立:1',
    expectedRevision: before.revision,
    expectedIdentityRevision: before.identityRevision,
    schemaVersion: 1 as const,
    intent: 'manual_edit' as const,
    entries: [...cards, withId].map(characterRosterEntryFromCard),
  }
  const receipt = commitAuthorCharacterRoster(db, request, { projectId: '创作测试', epoch: '原会话' }, () => {})
  expect(receipt.snapshot.entries.some(e => e.name === '程立')).toBe(true)

  const after = CharacterRosterRepository.read(db)
  expect(after.status).toBe('ready')
  expect(after.entries.some(e => e.name === '程立')).toBe(true)
  expect(db.prepare("SELECT COUNT(*) FROM characters WHERE retired=0 AND name='程立'").pluck().get()).toBe(1)
})
