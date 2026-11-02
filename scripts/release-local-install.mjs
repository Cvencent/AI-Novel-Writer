/**
 * 覆盖安装（robocopy → 安装目录）的判据与命令构造（issue #83 附带修复）。
 *
 * 单独成模块是为了**可测**：这段逻辑原先只写在 `release-local.mjs` 顶层，
 * 于是它出事故时没人能写测试。实测踩到的两次：
 *
 *   1. 运行中的安装版锁住 `better_sqlite3.node`，robocopy 报「错误 32 · 另一个程序正在
 *      使用此文件」后按默认 `/R`（重试 100 万次 × 每次等 30 秒）**静默挂死 19 分钟**、
 *      复制 0 个文件。
 *   2. 进程被 kill 掉之后 `spawnSync().status === null`，而老代码写的是
 *      `(result.status ?? 0) >= 8` —— null 被折成 0，于是「被中止」读成了**成功**，
 *      并打印 `installed to: ...`。装完一个文件都没换。
 *
 * 所以判据必须显式覆盖三种失败：被中止、退出码 ≥ 8、以及**退出码正常但 asar 没换**
 * （robocopy 退出码 <8 只表示「没有致命错误」，仍可能有文件没复制成功）。
 */

/** robocopy 的参数：/MIR 镜像、静音输出，并把重试压到可失败的量级。 */
export function robocopyArgs(unpackedDir, installDir) {
  return [
    unpackedDir, installDir, '/MIR', '/NFL', '/NDL', '/NJH', '/NP',
    // `/R:2 /W:2`：默认是「重试 100 万次、每次等 30 秒」。锁没解开时我们想在
    // 几秒内明确报错，而不是挂到天荒地老。
    '/R:2', '/W:2',
  ]
}

/**
 * 一次 robocopy 覆盖安装的可判定事实。
 *
 * @typedef {object} InstallVerification
 * @property {number|null} status            spawnSync().status；被信号/强杀中止时为 null。
 * @property {number|null} actualAsarBytes   安装目录里 resources/app.asar 的字节数；不存在时 null。
 * @property {number} expectedAsarBytes      打包产物 release/<ver>/win-unpacked/resources/app.asar 的字节数。
 * @property {string} installDir             安装目录绝对路径。
 */

/**
 * 判定一次 robocopy 覆盖安装是否**真的装上了**。不通过就抛错。
 *
 * 抛错而不是返回布尔：调用点没有「继续」这个选项——装不上就是整条发布链失败。
 */
export function assertInstallSucceeded(input) {
  if (input.status === null) {
    throw new Error('robocopy was terminated before completing the install (status=null)')
  }
  if (input.status >= 8) {
    throw new Error(`robocopy failed (${input.status})`)
  }
  if (input.actualAsarBytes === null) {
    throw new Error(`installed app.asar missing under ${input.installDir}`)
  }
  if (input.actualAsarBytes !== input.expectedAsarBytes) {
    throw new Error(`installed app.asar is ${input.actualAsarBytes} bytes, expected `
      + `${input.expectedAsarBytes} — the overwrite install did not take`)
  }
}

/**
 * 关掉**安装目录**里正在运行的实例的 PowerShell 脚本。
 *
 * 按可执行文件路径**精确匹配**：`F:\aiNovelWriter\qa-run\*` 下的 QA 隔离副本不属于
 * 本次覆盖安装的范围，绝不能被误杀。路径里的单引号按 PowerShell 的转义规则加倍。
 */
export function stopInstallDirInstancesScript(executablePath) {
  const quoted = String(executablePath).replace(/'/gu, "''")
  return `Get-Process -Name 'AI小说作家' -ErrorAction SilentlyContinue `
    + `| Where-Object { $_.Path -eq '${quoted}' } `
    + `| ForEach-Object { Stop-Process -Id $_.Id -Force }`
}

/** 数还有几个匹配实例（0 表示句柄该放开了，可以安全 robocopy）。 */
export function countInstallDirInstancesScript(executablePath) {
  const quoted = String(executablePath).replace(/'/gu, "''")
  return `Get-Process -Name 'AI小说作家' -ErrorAction SilentlyContinue `
    + `| Where-Object { $_.Path -eq '${quoted}' } `
    + `| Measure-Object | Select-Object -ExpandProperty Count`
}