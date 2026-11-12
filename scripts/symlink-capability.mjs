import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let cached

/**
 * Whether the current environment permits creating symlinks. Windows without
 * the symlink privilege (or Developer Mode) fails with EPERM; security tests
 * that need a symlink fixture should skip gracefully there instead of failing.
 */
export function symlinkSupported() {
  if (cached !== undefined) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-probe-'))
  try {
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file')
    cached = true
  } catch {
    cached = false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return cached
}