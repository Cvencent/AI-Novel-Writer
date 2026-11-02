import { describe, expect, it } from 'vitest'

import {
  assertInstallSucceeded,
  countInstallDirInstancesScript,
  robocopyArgs,
  stopInstallDirInstancesScript,
} from '../release-local-install.mjs'

const install = { expectedAsarBytes: 1000, installDir: 'F:\\aiNovel\\ai-novel-writer' }

describe('robocopyArgs', () => {
  it('mirrors the packaged dir and caps retries so a locked file fails fast', () => {
    const args = robocopyArgs('F:\\repo\\release\\1.5.108\\win-unpacked', install.installDir)
    expect(args).toContain('/MIR')
    // 默认是「重试 100 万次 × 每次等 30 秒」——锁没解开时会静默挂死 19 分钟（实测）。
    expect(args).toContain('/R:2')
    expect(args).toContain('/W:2')
  })
})

describe('assertInstallSucceeded', () => {
  it('accepts a real overwrite: asar bytes match the packaged dir', () => {
    expect(() => assertInstallSucceeded({ ...install, status: 1, actualAsarBytes: 1000 })).not.toThrow()
    // robocopy 退出码 0–7 都算成功。
    expect(() => assertInstallSucceeded({ ...install, status: 7, actualAsarBytes: 1000 })).not.toThrow()
  })

  it('rejects a terminated robocopy even though the old check folded null into success', () => {
    // 实测事故：进程被 kill 后 status === null，而 `(status ?? 0) >= 8` 把它读成了 0，
    // 于是「装了一个文件都没换」被打印成 `installed to: ...`。
    expect(() => assertInstallSucceeded({ ...install, status: null, actualAsarBytes: null }))
      .toThrow(/terminated/u)
  })

  it('rejects a robocopy exit code of 8 or more', () => {
    expect(() => assertInstallSucceeded({ ...install, status: 8, actualAsarBytes: 1000 }))
      .toThrow(/robocopy failed \(8\)/u)
  })

  it('rejects a missing installed asar', () => {
    expect(() => assertInstallSucceeded({ ...install, status: 1, actualAsarBytes: null }))
      .toThrow(/app\.asar missing/u)
  })

  it('rejects an exit code below 8 when the asar was not actually replaced', () => {
    // 这是本次真正踩到的形态：robocopy 退出码 2（有额外文件）看着成功，
    // 而 app.asar 还是上一版（18:27 那份，152511740 字节）。
    expect(() => assertInstallSucceeded({ ...install, status: 2, actualAsarBytes: 152511740 }))
      .toThrow(/did not take/u)
  })
})

describe('install-dir instance scripts', () => {
  it('matches the process by executable path, not by name', () => {
    // 按名字杀会连 QA 隔离副本（同名的 AI小说作家.exe）一起杀掉——那不在本次范围内。
    const script = stopInstallDirInstancesScript('F:\\aiNovel\\ai-novel-writer\\AI小说作家.exe')
    expect(script).toContain("$_.Path -eq 'F:\\aiNovel\\ai-novel-writer\\AI小说作家.exe'")
    expect(script).toContain('Stop-Process -Id $_.Id -Force')
  })

  it('doubles single quotes so a path cannot break out of the PowerShell string', () => {
    const script = stopInstallDirInstancesScript("F:\\it's\\app.exe")
    expect(script).toContain("F:\\it''s\\app.exe")
  })

  it('counts instances to know when the file handles have been released', () => {
    expect(countInstallDirInstancesScript('F:\\aiNovel\\ai-novel-writer\\AI小说作家.exe'))
      .toContain('Measure-Object')
  })
})