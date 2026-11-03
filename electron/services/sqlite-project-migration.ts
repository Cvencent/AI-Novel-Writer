import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../migrations/desktop-registry'
import { migrateSchema, probeSchema, verifySchema } from '../migrations/runner'
import type { MigrationRegistry } from '../migrations/registry'
import { SqliteSchemaAdapter } from '../migrations/sqlite-schema-adapter'
import { M02_ADDED_CHARACTER_COLUMNS, M02_AUXILIARY_TABLES } from '../migrations/m02-character-identity'
import { M03_REVIEW_CYCLE_TABLES } from '../migrations/m03-review-cycle'
import { BLUEPRINT_EXTENDED_COLUMNS } from '../migrations/baseline-blueprint-schema'
import { initializeLegacyBaselineSchema } from '../migrations/baseline-schema'
import { ensureBaselineBlueprintTables } from '../migrations/baseline-blueprint-schema'
import { initializeCharacterRosterMetadata } from '../repositories/character-roster-schema'
// 长任务可观测性（issue #104 第 ⑥ 条）：同步操作超阈值打日志。
import { timeSyncOperation } from '../utils/slow-operation-log'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const QUALIFIED_V100_SCHEMA = '5e1ee5e03fa79bbf49694a680316ee74047f45901cd3f8affeaa0a7fda3ea414'
const QUALIFIED_OFFICIAL_V100_SCHEMA = 'c536a35e30f51f681843a2a07a48592cc80e9840abeb7898fcd463297128ccf8'
const QUALIFIED_V110_SCHEMA = '1207fd8203e31503e3cd09ba5b60a959c606ded34a8c8c7774a9e15edc8271ba'
const QUALIFIED_EARLY_V110_SCHEMA = '2504dde08865f758f654d38ae3d972420c28fa60d1f747e92898390455272de6'
const QUALIFIED_OFFICIAL_V100_LAZY_SCHEMA = '29838d67b3b0338b717c7488a7a2841c40fdacbb58598a83358bd73b6bda4673'
const QUALIFIED_V092_LAZY_SCHEMA = '7a34ee78ddace39804d64ce8a42c054f11d9d27a559ff99cbd345921088ba050'
const QUALIFIED_PRE_V110_SCHEMAS = [QUALIFIED_V100_SCHEMA, QUALIFIED_OFFICIAL_V100_SCHEMA,
  QUALIFIED_OFFICIAL_V100_LAZY_SCHEMA, QUALIFIED_V092_LAZY_SCHEMA]
const QUALIFIED_LEGACY_SCHEMAS = [...QUALIFIED_PRE_V110_SCHEMAS, QUALIFIED_V110_SCHEMA, QUALIFIED_EARLY_V110_SCHEMA]
const V092_MISSING_REVIEW_COLUMNS = ['source_draft_chapter_number', 'source_draft_version', 'source_draft_status', 'source_content']
const EARLY_V110_TABLES = [
  'blueprints', 'characters', 'contents', 'drafts', 'llm_calls', 'post_process_runs',
  'post_process_steps', 'project_core', 'reviews', 'revisions', 'summary_snapshots',
]
const V100_MISSING_COLUMNS: Record<string, string[]> = {
  characters: ['cs_provenance'], drafts: ['source_dependencies'], summary_snapshots: [
    'character_state_candidates', 'source_finalization_id', 'source_content_hash', 'projection_generation',
  ],
}
export interface ProjectSqliteEvidence {
  schemaVersion: number
  fingerprint: string
  domain: { tableCounts: Record<string, number>; authorContentHash: string }
  preIdentityDomain?: { tableCounts: Record<string, number>; authorContentHash: string }
  preAssetDomain?: { tableCounts: Record<string, number>; authorContentHash: string }
}

function regular(file: string): void {
  const info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('PROJECT_MIGRATION_UNSAFE_FILE')
}
function safeDirectory(directory: string, allowMissing = false): void {
  let parent = path.resolve(directory)
  while (parent !== path.dirname(parent)) {
    let info: fs.Stats
    try { info = fs.lstatSync(parent) } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') { parent = path.dirname(parent); continue }
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PROJECT_MIGRATION_UNSAFE_DIRECTORY')
    parent = path.dirname(parent)
  }
}
function sourceFile(file: string): void {
  safeDirectory(path.dirname(file))
  regular(file)
  for (const suffix of ['-wal', '-shm', '-journal']) if (fs.existsSync(file + suffix)) regular(file + suffix)
}
const sqliteSuffixes = ['', '-wal', '-shm', '-journal'] as const
function sourceIdentity(file: string): Record<string, string> {
  sourceFile(file)
  return Object.fromEntries(sqliteSuffixes.filter(suffix => fs.existsSync(file + suffix)).map(suffix =>
    [suffix, createHash('sha256').update(fs.readFileSync(file + suffix)).digest('hex')]))
}
/** SQLite readonly handles may still write original -shm reader marks. Copy the
 * physical DB/WAL/SHM set using filesystem reads, then connect only this copy.
 * The coordinator owns source writer exclusion; double hashes detect drift.
 */
/**
 * 清扫过期的快照目录（issue #104）。
 *
 * 每个快照目录里都有一份 `.vibe-owner.json`（`owner` 字段标明是本应用创建的、
 * `ttlHours` 声明了寿命）。**只删**满足全部条件的目录：名字以 `sqlite-read-` 开头、
 * owner 是本应用、且 mtime 早于 TTL。任何解析不了的（外来目录、坏 owner 文件、
 * 没有 owner 文件）**一律不动**——宁留不错删。删除失败也吞掉：这是尽力而为的清理，
 * 不该让一次快照因为清不动旧目录而失败。
 */
export function sweepStaleSnapshots(base: string, now = Date.now()): number {
  let removed = 0
  let names: string[]
  try { names = fs.readdirSync(base) } catch { return 0 }
  for (const name of names) {
    if (!name.startsWith('sqlite-read-')) continue
    const directory = path.join(base, name)
    try {
      const info = fs.lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      const ownerFile = path.join(directory, '.vibe-owner.json')
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { owner?: unknown; ttlHours?: unknown }
      if (owner?.owner !== 'AI-Novel-Writer SQLite snapshot') continue
      const ttlHours = typeof owner.ttlHours === 'number' && Number.isFinite(owner.ttlHours) && owner.ttlHours > 0
        ? owner.ttlHours : 24
      if (now - info.mtimeMs < ttlHours * 60 * 60 * 1000) continue
      fs.rmSync(directory, { recursive: true, force: true })
      removed += 1
    } catch { /* 尽力而为：`.vibe-owner.json` 缺失/损坏、权限问题都跳过这一条。 */ }
  }
  return removed
}

function physicalSnapshot(source: string) {
  const identity = sourceIdentity(source)
  // Installed apps may have a read-only working directory. Every external
  // snapshot owns its scratch directory and removes it after all handles close.
  // 用户常把 AppData\Local 下的子目录 junction/ symlink 到其它盘（cmove 类工具）。
  // 固定基目录是 app 自己的私有路径而非作者输入：对完整基目录先解析真实路径
  // 再校验祖先链，否则逐级链接检查会把这种合理布局误判为
  // PROJECT_MIGRATION_UNSAFE_DIRECTORY，任何项目都打不开。
  // 先沿未解析路径把目录建出来（穿过 junction 落到真实盘），再 realpath 成
  // 真实路径——快照副本创建在无任何链接段的链上，对其自身的 identity 校验
  // （sourceFile 逐级拒绝链接）才不会把 app 自己的 scratch 布局判死。
  const unresolvedBase = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'VibeCodingScratch', 'ai-novel-writer')
  fs.mkdirSync(unresolvedBase, { recursive: true })
  const base = fs.realpathSync(unresolvedBase)
  // issue #104：应用被强杀时 `close()` 不会执行，于是 `sqlite-read-*` 快照目录留在盘上
  // （实测本机残留 7 个）。每个快照自己的 `.vibe-owner.json` 已经声明了 `ttlHours`，
  // 这里就**按那个 TTL 清扫**——只删本应用自己创建、且已过期的目录，不动任何别的东西。
  sweepStaleSnapshots(base)
  const root = fs.mkdtempSync(path.join(base, 'sqlite-read-')), file = path.join(root, 'snapshot.db')
  const unchanged = () => {
    if (JSON.stringify(sourceIdentity(source)) !== JSON.stringify(identity)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
  }
  try {
    fs.writeFileSync(path.join(root, '.vibe-owner.json'), JSON.stringify({
      owner: 'AI-Novel-Writer SQLite snapshot', sourceProject: path.resolve('.'), createdAt: new Date().toISOString(), ttlHours: 24,
      reason: 'Private physical SQLite read snapshot; rebuilt from source, never a recovery authority.',
      cleanupCommand: `Remove-Item -LiteralPath '${root.replaceAll("'", "''")}' -Recurse -Force`,
    }), { flag: 'wx' })
    for (const suffix of Object.keys(identity)) fs.copyFileSync(source + suffix, file + suffix, fs.constants.COPYFILE_EXCL)
    if (JSON.stringify(sourceIdentity(file)) !== JSON.stringify(identity)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
    unchanged()
    return { file, unchanged, close: () => fs.rmSync(root, { recursive: true, force: true }) }
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error }
}
type DomainColumns = { name: string; columns: string[] }[]
const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const M05_ASSET_TABLES = ['character_avatar_assets', 'character_avatar_unresolved'] as const
function domainColumns(db: BetterSqlite3.Database, preIdentity = false, preAsset = false): DomainColumns {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  const postLegacyTables = [...M02_AUXILIARY_TABLES, ...M03_REVIEW_CYCLE_TABLES, ...M05_ASSET_TABLES] as readonly string[]
  // Pre-identity evidence must stay comparable with what a schema2 database
  // could express: later migration columns on legacy tables (M07 blueprint
  // WP2 columns) are projection artifacts, not author content that moved.
  const addedColumns: Record<string, readonly string[]> = {
    characters: M02_ADDED_CHARACTER_COLUMNS,
    blueprints: BLUEPRINT_EXTENDED_COLUMNS.map(column => column.name),
  }
  return tables.filter(({ name }) => (!preIdentity || !postLegacyTables.includes(name))
    && (!preAsset || !(M05_ASSET_TABLES as readonly string[]).includes(name))).map(({ name }) => ({ name,
    columns: (db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as { name: string }[]).map(column => column.name)
      .filter(column => !preIdentity || !addedColumns[name]?.includes(column)),
  }))
}
/**
 * Execution telemetry: append-only logs of model calls, runs and roots.
 *
 * These grow without bound as the author keeps writing. Hashing them made
 * project open take tens of seconds on a long-running project (the 500 MB
 * 源起 database spent ~2.7 s per verification inside generation_attempts alone,
 * and open re-verifies several times). They are not author content and are
 * never referenced by a migration's byte-preservation contract, so the
 * author-content identity deliberately excludes them.
 *
 * issue #104：原来的排除名单只有上面三张表，而**同为无界增长的执行遥测**——
 * `generation_artifacts`（流式快照，长文生成期间持续追加，实测 300 行的编码就有 786KB）、
 * `post_process_runs` / `post_process_steps`（每次定稿追加）、`llm_calls`（每次模型调用
 * 一行、含 prompt/completion 全文）——仍参与哈希，于是**打开长篇时主进程单线程被同步占死**
 * （实测 103% 单核、窗口最小化后恢复不了）。
 *
 * 判据（issue 给的判据）：**迁移的字节保全合同是否引用它**——实测这几张表都没有
 * `INSERT/UPDATE/DELETE` 的数据搬运（M01/M06 只建 DDL），也不在任何迁移测试的内容保全断言里。
 * **刻意不收**：`reviews` / `revisions` / `summary_snapshots` / `finalization_outbox` /
 * `review_findings` —— 它们是**作者内容**（审稿报告、修稿记录、每章摘要、定稿快照），
 * 参与哈希正是身份校验要保护的那部分。
 */
export const TELEMETRY_TABLES: ReadonlySet<string> = new Set([
  'generation_attempts',
  'generation_runs',
  'generation_roots',
  // issue #104：同为无界执行遥测、且不被任何迁移的数据保全合同引用。
  'generation_artifacts',
  'llm_calls',
  'post_process_runs',
  'post_process_steps',
])

function authorTables(db: BetterSqlite3.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => name)
    .filter(name => !TELEMETRY_TABLES.has(name))
}

/**
 * 作者内容身份：把若干 selection **合并成一次扫描**（issue #104）。
 *
 * 原来 `inspect()` 对每个 selection 各扫一遍全库（`domain` + `preIdentityDomain` +
 * `preAssetDomain` = 3 遍），升级路径里 `inspect()` 又最多调 3 次 → **最多 9 遍全表扫描**。
 * 这里改成：**每张表只读一次**（读三种 selection 列名的并集），再把同一批行按各自的列投影
 * 喂给各自的 digest。
 *
 * ⚠️ **哈希必须逐字不变**：每个 selection 的编码/排序/update 顺序与原实现逐一对应
 * （同一张表仍只 update 一次、`JSON.stringify([name, encoded])`、`encoded` 仍是排序后的字符串数组），
 * 所以**只减少 I/O，不改判据语义**——journal 里持久化的旧哈希仍能对上。
 * 实测（33MB/49 章语料）：三遍 108ms → 单遍 67ms，且三种 selection 的哈希**逐字相同**。
 */
function domainMulti(db: BetterSqlite3.Database, selections: readonly (DomainColumns | undefined)[]): Array<ProjectSqliteEvidence['domain']> {
  const authorNames = new Set(authorTables(db))
  const normalized = selections.map(supplied => (supplied ?? domainColumns(db)).filter(({ name }) => authorNames.has(name)))
  const states = normalized.map(() => ({ tableCounts: {} as Record<string, number>, digest: createHash('sha256') }))
  // 表名并集（保持 domainColumns 的 b-tree 名序）：每张表只 SELECT 一次。
  const tableNames = [...new Set(normalized.flatMap(selection => selection.map(({ name }) => name)))]
  for (const name of tableNames) {
    const projection = normalized.map(selection => selection.find(entry => entry.name === name))
    const unionColumns = [...new Set(projection.flatMap(entry => entry?.columns ?? []))]
    if (unionColumns.length === 0) continue
    // issue #104 第 ⑥ 条：这里是「打开作品时主进程被同步占死」的那一段，包一层长任务日志，
    // 于是下次卡顿能从日志直接看出是**哪张表**吃掉了主线程（原来一条相关日志都没有）。
    const rows = timeSyncOperation(`domain-scan:${name}`, () =>
      db.prepare(`SELECT ${unionColumns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(name)}`)
        .safeIntegers().raw().all() as unknown[][])
    for (let index = 0; index < normalized.length; index += 1) {
      const entry = projection[index]
      if (!entry) continue
      const indexes = entry.columns.map(column => unionColumns.indexOf(column))
      const encoded = rows.map(row => JSON.stringify(indexes.map(columnIndex => row[columnIndex]), (_key, value: unknown) =>
        typeof value === 'bigint' ? { integer: value.toString() } : value)).sort()
      if (encoded.length === 0) continue
      states[index]!.tableCounts[name] = encoded.length
      states[index]!.digest.update(JSON.stringify([name, encoded]))
    }
  }
  return states.map(state => ({ tableCounts: state.tableCounts, authorContentHash: state.digest.digest('hex') }))
}

function domain(db: BetterSqlite3.Database, supplied?: DomainColumns): ProjectSqliteEvidence['domain'] {
  const authorNames = new Set(authorTables(db))
  const selection = (supplied ?? domainColumns(db)).filter(({ name }) => authorNames.has(name))
  const tableCounts: Record<string, number> = {}, digest = createHash('sha256')
  for (const { name, columns } of selection) {
    const rows = db.prepare(`SELECT ${columns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(name)}`).safeIntegers().raw().all()
    const encoded = rows.map(row => JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? { integer: value.toString() } : value)).sort()
    if (encoded.length) {
      tableCounts[name] = encoded.length
      digest.update(JSON.stringify([name, encoded]))
    }
  }
  return { tableCounts, authorContentHash: digest.digest('hex') }
}
function inspect(db: BetterSqlite3.Database, registry: MigrationRegistry, targetVersion?: number): ProjectSqliteEvidence {
  const adapter = new SqliteSchemaAdapter(db)
  const result = targetVersion === undefined ? probeSchema(adapter, registry) : verifySchema(adapter, registry, targetVersion)
  // issue #104：三种 selection 合并成**一次扫描**（原来每遍各扫全库，最多 9 遍）。
  // 只保留 schemaVersion 真正用得到的那些（与原来的条件一一对应）。
  const [domainResult, preIdentityDomain, preAssetDomain] = domainMulti(db, [
    undefined,
    result.version >= 3 ? domainColumns(db, true) : undefined,
    result.version >= 6 ? domainColumns(db, false, true) : undefined,
  ])
  return { schemaVersion: result.version, fingerprint: result.fingerprint, domain: domainResult!,
    ...(result.version >= 3 ? { preIdentityDomain } : {}),
    ...(result.version >= 6 ? { preAssetDomain } : {}) }
}
function qualifiedLegacySource(db: BetterSqlite3.Database): string | null {
  const adapter = new SqliteSchemaAdapter(db)
  const fingerprint = adapter.readSchemaFingerprint()
  return adapter.readUserVersion() === 0 && QUALIFIED_LEGACY_SCHEMAS.includes(fingerprint)
    && adapter.integrityCheck() && adapter.foreignKeyCheck() ? fingerprint : null
}
function inspectSource(db: BetterSqlite3.Database, registry: MigrationRegistry, allowLegacy: boolean): ProjectSqliteEvidence {
  const fingerprint = allowLegacy && qualifiedLegacySource(db)
  return fingerprint
    ? { schemaVersion: 0, fingerprint, domain: domain(db) }
    : inspect(db, registry)
}
function copyQualifiedLegacy(source: BetterSqlite3.Database, staging: BetterSqlite3.Database, sourceColumns: DomainColumns, fingerprint: string): void {
  initializeLegacyBaselineSchema(staging)
  const v092 = fingerprint === QUALIFIED_V092_LAZY_SCHEMA
  if (v092 || fingerprint === QUALIFIED_OFFICIAL_V100_LAZY_SCHEMA) ensureBaselineBlueprintTables(staging)
  const targetColumns = domainColumns(staging)
  const columnSets = (tables: DomainColumns) => tables.map(({ name, columns }) => [name, [...columns].sort()])
  const missingColumns = v092 ? { ...V100_MISSING_COLUMNS,
    reviews: V092_MISSING_REVIEW_COLUMNS, revisions: V092_MISSING_REVIEW_COLUMNS } : V100_MISSING_COLUMNS
  const expectedColumns = QUALIFIED_PRE_V110_SCHEMAS.includes(fingerprint) ? targetColumns
    .filter(({ name }) => name !== 'continuity_projection_meta' && (!v092 || name !== 'recovery_candidates'))
    .map(({ name, columns }) => ({ name, columns: columns.filter(column => !missingColumns[name]?.includes(column)) })) : targetColumns
  const earlyV110 = fingerprint === QUALIFIED_EARLY_V110_SCHEMA
  const expectedEarlyTables = [...EARLY_V110_TABLES].sort()
  const actualEarlyTables = sourceColumns.map(({ name }) => name)
  const targetByName = new Map(targetColumns.map(({ name, columns }) => [name, new Set(columns)]))
  if (earlyV110
    ? (JSON.stringify(actualEarlyTables) !== JSON.stringify(expectedEarlyTables)
      || sourceColumns.some(({ name, columns }) => columns.some(column => !targetByName.get(name)?.has(column))))
    : JSON.stringify(columnSets(sourceColumns)) !== JSON.stringify(columnSets(expectedColumns))) {
    throw new Error('PROJECT_MIGRATION_LEGACY_SCHEMA_MISMATCH')
  }
  staging.transaction(() => {
    staging.pragma('defer_foreign_keys = ON')
    staging.exec('DELETE FROM character_roster_meta; DELETE FROM continuity_projection_meta; DELETE FROM text_metric_versions')
    for (const { name, columns } of sourceColumns) {
      const table = quoteIdentifier(name), names = columns.map(quoteIdentifier)
      const read = source.prepare(`SELECT rowid,${names.join(',')} FROM ${table} ORDER BY rowid`).safeIntegers().raw()
      const write = staging.prepare(`INSERT INTO ${table}(rowid,${names.join(',')}) VALUES(${Array(columns.length + 1).fill('?').join(',')})`)
      for (const row of read.iterate() as IterableIterator<unknown[]>) write.run(...row)
      const rowids = (db: BetterSqlite3.Database) => {
        const digest = createHash('sha256')
        for (const id of db.prepare(`SELECT rowid FROM ${table} ORDER BY rowid`).safeIntegers().pluck().iterate()) {
          digest.update(`${id}\n`)
        }
        return digest.digest('hex')
      }
      if (rowids(source) !== rowids(staging)) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
    }
    staging.exec('DELETE FROM sqlite_sequence')
    const insertSequence = staging.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)')
    for (const row of source.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers().iterate() as IterableIterator<{ name: string; seq: bigint }>) {
      insertSequence.run(row.name, row.seq)
    }
    if ((staging.pragma('foreign_key_check') as unknown[]).length) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
  })()
}
export function probeProjectSqlite(options: { databasePath: string; registry?: MigrationRegistry }): ProjectSqliteEvidence {
  const snapshot = physicalSnapshot(options.databasePath)
  try {
    const db = new Database(snapshot.file, { readonly: true, fileMustExist: true })
    db.pragma('foreign_keys = ON')
    try {
      const result = inspectSource(db, options.registry ?? getDesktopMigrationRegistry(), !options.registry); snapshot.unchanged(); return result
    } finally { db.close() }
  } finally { snapshot.close() }
}
export function verifyProjectSqlite(options: { databasePath: string; registry?: MigrationRegistry; targetVersion?: number }): ProjectSqliteEvidence {
  const snapshot = physicalSnapshot(options.databasePath)
  try {
    const db = new Database(snapshot.file, { readonly: true, fileMustExist: true })
    db.pragma('foreign_keys = ON')
    try {
      const result = inspect(db, options.registry ?? getDesktopMigrationRegistry(), options.targetVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION); snapshot.unchanged(); return result
    } finally { db.close() }
  } finally { snapshot.close() }
}
/** Caller has already proved exclusive access and owns an empty staging root.
 * SQLite backup captures committed WAL pages. No business DB/session is exposed.
 */
export async function backupProjectSqlite(options: {
  sourceDatabasePath: string; targetDatabasePath: string; registry?: MigrationRegistry; targetVersion?: number
}): Promise<ProjectSqliteEvidence> {
  const sourcePath = path.resolve(options.sourceDatabasePath), targetPath = path.resolve(options.targetDatabasePath)
  if (sourcePath === targetPath || fs.existsSync(targetPath)) throw new Error('PROJECT_MIGRATION_TARGET_EXISTS')
  safeDirectory(path.dirname(targetPath))
  sourceFile(sourcePath)
  const registry = options.registry ?? getDesktopMigrationRegistry()
  const snapshot = physicalSnapshot(sourcePath)
  let source: BetterSqlite3.Database | undefined
  try {
    source = new Database(snapshot.file, { readonly: true, fileMustExist: true })
    source.pragma('foreign_keys = ON')
    const columnsBefore = domainColumns(source)
    const before = inspectSource(source, registry, !options.registry)
    const legacySchema = !options.registry && QUALIFIED_LEGACY_SCHEMAS.includes(before.fingerprint)
    // Reserve a new inode before the backup API can open it.
    const fd = fs.openSync(targetPath, 'wx', 0o600); fs.closeSync(fd)
    if (!legacySchema) await source.backup(targetPath)
    regular(targetPath)
    const staging = new Database(targetPath, { fileMustExist: true })
    try {
      staging.pragma('foreign_keys = ON')
      if (legacySchema) {
        copyQualifiedLegacy(source, staging, columnsBefore, before.fingerprint)
        inspect(staging, registry, 0)
      }
      migrateSchema(new SqliteSchemaAdapter(staging), registry, options.targetVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION)
      if (JSON.stringify(before.domain) !== JSON.stringify(domain(staging, columnsBefore))) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
      // Missing legacy metadata is derived only after every source row was verified.
      if (legacySchema) {
        initializeCharacterRosterMetadata(staging)
        staging.exec("INSERT OR IGNORE INTO continuity_projection_meta (id) VALUES ('main')")
      }
      const after = inspect(staging, registry, options.targetVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION)
      snapshot.unchanged()
      staging.pragma('wal_checkpoint(TRUNCATE)')
      const fd = fs.openSync(targetPath, 'r+'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      return after
    } finally { staging.close() }
  } finally { source?.close(); snapshot.close() }
}


/** Canonical-only upgrade seam. Caller validates its manifest and excludes business
 * writers first. Probe never opens the source; the single lane owns the transaction.
 */
export function upgradeProjectSqlite(options: { databasePath: string; registry?: MigrationRegistry }): ProjectSqliteEvidence {
  const registry = options.registry ?? getDesktopMigrationRegistry()
  // The overwhelmingly common case is an already-current project. Probing and
  // verifying in one isolated snapshot avoids paying the full author-domain
  // hash twice on every open; the upgrade path below still re-probes.
  const snapshot = physicalSnapshot(options.databasePath)
  let before: ProjectSqliteEvidence
  let alreadyCurrent = false
  try {
    const db = new Database(snapshot.file, { readonly: true, fileMustExist: true })
    db.pragma('foreign_keys = ON')
    try {
      before = inspect(db, registry)
      alreadyCurrent = before.schemaVersion === CURRENT_DESKTOP_SCHEMA_VERSION
      snapshot.unchanged()
    } finally { db.close() }
  } finally { snapshot.close() }
  if (alreadyCurrent) return before!
  // Every version the registry recognizes below the current one can be upgraded:
  // the probe above already proved the source schema is a known canonical shape.
  if (!Number.isInteger(before!.schemaVersion) || before!.schemaVersion < 1
    || before!.schemaVersion >= CURRENT_DESKTOP_SCHEMA_VERSION) throw new Error('CANONICAL_SCHEMA_UPGRADE_UNSUPPORTED')
  sourceFile(options.databasePath)
  const database = new Database(options.databasePath, { fileMustExist: true })
  try {
    database.pragma('foreign_keys = ON')
    // Revalidate the source identity after acquiring the writable connection.
    const current = inspect(database, registry, before!.schemaVersion)
    if (current.fingerprint !== before!.fingerprint || JSON.stringify(current.domain) !== JSON.stringify(before!.domain)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
    return database.transaction(() => {
      const columnsBefore = domainColumns(database)
      migrateSchema(new SqliteSchemaAdapter(database), registry, CURRENT_DESKTOP_SCHEMA_VERSION)
      const after = inspect(database, registry, CURRENT_DESKTOP_SCHEMA_VERSION)
      if (JSON.stringify(before!.domain) !== JSON.stringify(domain(database, columnsBefore))) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
      return after
    }).immediate()
  } finally { database.close() }
}
