/**
 * 把 better-sqlite3 切回 Node ABI（本地 vitest 用）。
 *
 * 发布链里这一步曾经是 `prebuild-install` 现下/现编。现在先试 ABI 缓存
 * （`scripts/native-abi-cache.mjs`）：命中时是一次文件复制，未命中才回退到
 * prebuild-install，成功后再存回缓存。
 *
 * 缓存条目校验 size 与 sha256；恢复出来的二进制还要**实际探测一次**——宁可重下
 * 也不用坏文件。忘记切回 Node ABI 会让下一次 vitest 全线崩，代价远大于省下的两秒。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { restore, save } from './native-abi-cache.mjs'

const require = createRequire(import.meta.url)
const packageRoot = path.dirname(require.resolve('better-sqlite3/package.json'))
const packageRequire = createRequire(path.join(packageRoot, 'package.json'))

function verifyNodeBinding() {
  const Database = packageRequire('better-sqlite3')
  const db = new Database(':memory:')
  try {
    const result = db.prepare('select 1 as ok').get()
    if (result?.ok !== 1) throw new Error('better-sqlite3 Node ABI verification query failed')
  } finally {
    db.close()
  }
}

if (restore('node')) {
  try {
    verifyNodeBinding()
    console.log(`Restored better-sqlite3 for Node ABI ${process.versions.modules} from ABI cache`)
    process.exit(0)
  } catch {
    // 缓存恢复出来的二进制探测失败：继续走下面的 prebuild-install 重新拉一份。
  }
}

const prebuildInstall = packageRequire.resolve('prebuild-install/bin.js')
const install = spawnSync(process.execPath, [prebuildInstall], {
  cwd: packageRoot,
  env: {
    ...process.env,
    npm_config_runtime: 'node',
    npm_config_target: process.versions.node,
  },
  encoding: 'utf8',
  stdio: 'inherit',
  windowsHide: true,
})
if (install.error) throw install.error
if (install.status !== 0) {
  throw new Error(`Failed to prepare better-sqlite3 for Node ${process.versions.node}`)
}

verifyNodeBinding()
try { save('node') } catch { /* 缓存只是优化，不承担正确性 */ }
console.log(`Verified better-sqlite3 for Node ABI ${process.versions.modules}`)
