/** 驱动经 stage-sample 直接 import 应用里的 .ts，靠 Node 自带的类型剥离：22.18 起默认开启，23.x 要 23.6 起。 */
export function assertNodeRunsTypeScript(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  if (major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)) return
  throw new Error(`驱动脚本直接 import 应用里的 .ts，需要 Node 22.18 或 23.6 以上，当前是 ${version}。可以用 fnm exec --using=22.23.1 -- node scripts/redesign/drive.mjs …`)
}
