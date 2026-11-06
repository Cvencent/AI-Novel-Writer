/**
 * 安装窗口判定（issue #188 / #218）——从 `user-sim.mjs` 抽出来单独可测。
 *
 * 现场：找茬卡与修卡每轮必撞（六次崩溃全部落在覆盖安装后 61–78 秒），
 * 而「这次崩溃算不算产品缺陷」以前靠人每次手比 mtime（已经因此犯过两次错）。
 */
import fs from 'node:fs'
import path from 'node:path'
/**
 * 「安装目录被换过」要看**哪些文件**（issue #218）。
 *
 * ⚠️ 原来只看 `resources/app.asar` 一个文件，实测**漏报过一次**：
 *   12:06:52 起跑（安装目录 asar 是 11:27:23，合规）
 *   12:11:51 修卡构建出 1.5.207（release 侧 asar mtime 落进本次运行窗口）
 *   12:13:07 应用崩溃、sim 收工 → 报告读到安装目录 asar 仍是 11:27:23 → installWindowSuspect=false
 * 也就是说：**覆盖安装是整目录 robocopy /MIR**，应用完全可能先被替换掉别的文件
 * （exe、unpacked 里的原生模块）就已经死了，而 app.asar 还没轮到 —— 单文件判据就看不见。
 *
 * 所以取这一组的**最新** mtime：任意一个变了都算「撞上安装窗口」。
 *
 * ⚠️ 不看目录 mtime：实测 robocopy 覆盖时目录 mtime 会被**回写成源目录的值**
 * （甚至比原值更早），拿它比大小会得出错误结论 —— 只有文件 mtime 可靠。
 */
function installMtimeCandidates(exePath) {
  const installRoot = path.dirname(exePath)
  return [
    path.join(installRoot, 'resources', 'app.asar'),
    exePath,
    // 每次打包都会重新产出的原生绑定（prepare:native-node / rebuild:electron 都要动它）。
    path.join(installRoot, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  ]
}

function asarMtimeMs(exePath) {
  if (!exePath) return null
  let newest = null
  for (const candidate of installMtimeCandidates(exePath)) {
    try {
      const stamp = Math.round(fs.statSync(candidate).mtimeMs)
      if (newest === null || stamp > newest) newest = stamp
    } catch { /* 试下一个 */ }
  }
  return newest
}

/**
 * release 目录下各版本包的 asar mtime（issue #218）。
 *
 * 「有没有新构建」是这一轮有没有撞安装窗口的**第二路证据**：修卡的顺序是
 * 构建 → robocopy /MIR 到安装目录，所以构建那一刻就已经可能扰动正在跑的应用。
 */
function releaseAsarMtimes(repoRoot, window) {
  const releases = path.join(repoRoot, 'release')
  const stamps = []
  try {
    for (const name of fs.readdirSync(releases)) {
      if (!/^\d+\.\d+\.\d+$/.test(name)) continue
      const asar = path.join(releases, name, 'win-unpacked', 'resources', 'app.asar')
      try { stamps.push(Math.round(fs.statSync(asar).mtimeMs)) } catch { /* 还没打完 */ }
    }
  } catch { /* 没有 release 目录 */ }
  if (stamps.length === 0) return { startedAtMax: null, endedAtMax: null, newestInRunWindow: null }
  const startedAt = Number(window?.startedAtMs)
  const finishedAt = Number(window?.finishedAtMs)
  const inWindow = stamps.filter(stamp => stamp >= startedAt && stamp <= finishedAt)
  return {
    startedAtMax: Math.max(...stamps),
    endedAtMax: Math.max(...stamps),
    newestInRunWindow: inWindow.length === 0 ? null : Math.max(...inWindow),
  }
}

export { installMtimeCandidates, asarMtimeMs, releaseAsarMtimes }
