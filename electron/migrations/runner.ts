import {
  LATEST_SCHEMA_VERSION, MIGRATION_LANE, SchemaMigrationError, createMigrationRegistry,
  type MigrationRegistry, type SchemaReader, type SchemaWriter,
} from './registry'

export interface SchemaProbe {
  readonly version: number
  readonly fingerprint: string
}

/**
 * `skipIntegrityCheck` 只给「同一次打开里这批字节刚刚被完整校验过」的调用方用。
 *
 * 打开作品时 `integrity_check` 要跑两次（迁移探针一次、拿到句柄后再一次），
 * 实测 140MB 库上 223ms 热 / 1132ms 冷。调用方只有在**进程内已经按内容哈希
 * 证明过这批字节完整**时才可置位；否则必须走完整校验（默认就是完整）。
 * 版本、指纹与各迁移的领域校验**一律照跑**，只有全页 B-tree 校验被省掉一次。
 */
export interface SchemaProbeOptions { skipIntegrityCheck?: boolean }

/** Read-only probe. A familiar version number alone never authorizes writes. */
export function probeSchema(db: SchemaReader, registry: MigrationRegistry, options: SchemaProbeOptions = {}): SchemaProbe {
  const version = db.readUserVersion()
  if (!Number.isInteger(version) || version < 0) throw new SchemaMigrationError('INVALID_SCHEMA_VERSION')
  if (version > LATEST_SCHEMA_VERSION) throw new SchemaMigrationError('NEWER_SCHEMA_READ_ONLY')
  if (!options.skipIntegrityCheck && !db.integrityCheck()) throw new SchemaMigrationError('CORRUPT_SCHEMA')
  if (!db.foreignKeyCheck()) throw new SchemaMigrationError('CORRUPT_SCHEMA')
  const fingerprint = db.readSchemaFingerprint()
  if (!registry.recognizedSchemas.some(item => item.version === version && item.fingerprint === fingerprint)) {
    throw new SchemaMigrationError('UNRECOGNIZED_SCHEMA')
  }
  return Object.freeze({ version, fingerprint })
}

/** Separate read-only verification; does not acquire a session or reopen repositories. */
export function verifySchema(
  db: SchemaReader,
  registry: MigrationRegistry,
  target: number,
  options: SchemaProbeOptions = {},
): SchemaProbe {
  const probe = probeSchema(db, registry, options)
  if (probe.version !== target) throw new SchemaMigrationError('SCHEMA_VERSION_MISMATCH')
  if (target > 0) {
    const implementation = registry.implementations.find(step => step.to === target)
    if (!implementation) throw new SchemaMigrationError('MIGRATION_NOT_INSTALLED')
    if (!implementation.verify(db)) throw new SchemaMigrationError('MIGRATION_VERIFICATION_FAILED')
  }
  return probe
}

export interface MigrationResult extends SchemaProbe {
  readonly status: 'schema-verified'
  readonly completedSteps: readonly string[]
  readonly sessionFenced: false
  readonly repositoriesOpened: false
}

/** One transaction per step; a committed preceding step is retained after later failure.
 * Restart re-probes the actual version/fingerprint and never reruns an already committed step.
 * S04 closes source/staging handles and coordinates physical cutover separately.
 */
export function migrateSchema(
  db: SchemaWriter,
  suppliedRegistry: MigrationRegistry,
  target = LATEST_SCHEMA_VERSION,
): MigrationResult {
  // Revalidate even if a caller constructed an object instead of using the constructor.
  const registry = createMigrationRegistry(suppliedRegistry.implementations, suppliedRegistry.recognizedSchemas)
  if (!Number.isInteger(target) || target < 0 || target > LATEST_SCHEMA_VERSION) {
    throw new SchemaMigrationError('INVALID_TARGET_VERSION')
  }
  let current = probeSchema(db, registry)
  if (target < current.version) throw new SchemaMigrationError('SCHEMA_DOWNGRADE_REFUSED')
  current = verifySchema(db, registry, current.version)
  const pending = MIGRATION_LANE.filter(step => step.from >= current.version && step.to <= target)
  // Discover every missing function before the first transaction, never stamp an empty step.
  const installed = pending.map(slot => {
    const implementation = registry.implementations.find(item => item.id === slot.id)
    if (!implementation) throw new SchemaMigrationError('MIGRATION_NOT_INSTALLED')
    if (!registry.recognizedSchemas.some(item => item.version === slot.to)) {
      throw new SchemaMigrationError('TARGET_SCHEMA_NOT_REGISTERED')
    }
    return implementation
  })
  const completedSteps: string[] = []
  for (const step of installed) {
    const expected = current
    current = db.transaction(() => {
      const before = verifySchema(db, registry, step.from)
      if (before.version !== step.from || before.fingerprint !== expected.fingerprint) {
        throw new SchemaMigrationError('SCHEMA_CHANGED_SINCE_PROBE')
      }
      step.migrate(db)
      // The runner alone owns version advancement; business functions cannot skip the lane.
      if (db.readUserVersion() !== step.from) throw new SchemaMigrationError('MIGRATION_CHANGED_VERSION')
      if (!db.integrityCheck() || !db.foreignKeyCheck() || !step.verify(db)) {
        throw new SchemaMigrationError('MIGRATION_VERIFICATION_FAILED')
      }
      const fingerprint = db.readSchemaFingerprint()
      if (!registry.recognizedSchemas.some(item => item.version === step.to && item.fingerprint === fingerprint)) {
        throw new SchemaMigrationError('MIGRATION_FINGERPRINT_MISMATCH')
      }
      db.writeUserVersion(step.to)
      return verifySchema(db, registry, step.to)
    })
    completedSteps.push(step.id)
  }
  const verified = verifySchema(db, registry, target)
  return Object.freeze({ ...verified, status: 'schema-verified', completedSteps: Object.freeze(completedSteps),
    sessionFenced: false, repositoriesOpened: false })
}
