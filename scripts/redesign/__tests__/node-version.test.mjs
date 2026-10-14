import assert from 'node:assert/strict'
import { it } from 'vitest'
import { assertNodeRunsTypeScript } from '../node-version.mjs'

it('Node 22.18、23.6 起能直接 import .ts，驱动照常运行', () => {
  for (const version of ['v22.18.0', 'v22.23.1', 'v23.6.0', 'v24.18.0', 'v26.7.0']) assert.doesNotThrow(() => assertNodeRunsTypeScript(version))
})

it('更早的 Node 在加载 .ts 之前就报清楚：要哪个版本、当前是哪个、怎么换', () => {
  for (const version of ['v20.19.0', 'v22.17.1', 'v23.5.0']) {
    assert.throws(() => assertNodeRunsTypeScript(version), {
      message: `驱动脚本直接 import 应用里的 .ts，需要 Node 22.18 或 23.6 以上，当前是 ${version}。可以用 fnm exec --using=22.23.1 -- node scripts/redesign/drive.mjs …`,
    })
  }
})
