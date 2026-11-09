import { ipcMain } from 'electron'
import { assertGlobalDataReady } from './services/app-data-locator'
import { getCurrentProjectPath, getProjectDb } from './database'

import { registerConfigController } from './controllers/config-controller'
import { registerProjectController } from './controllers/project-controller'
import { registerProjectArchiveController } from './controllers/project-archive-controller'
import { registerCloudBackupController } from './controllers/cloud-backup-controller'
import { registerFSController } from './controllers/fs-controller'
import { registerLLMController } from './controllers/llm-controller'
import { registerGenerationController } from './controllers/generation-controller'
import { registerDatabaseController } from './controllers/db-controller'
import { registerKBController } from './controllers/kb-controller'
import { registerImportController } from './controllers/import-controller'
import { registerWindowController } from './controllers/window-controller'
import { registerOfficialHomepageController } from './controllers/official-homepage-controller'
import { registerModelProviderResourceController } from './controllers/model-provider-resource-controller'
import { registerFinalizationController } from './controllers/finalization-controller'
import { registerChapterLifecycleController } from './controllers/chapter-lifecycle-controller'
import { registerExternalFileGrantController } from './controllers/external-file-grant-controller'
import { registerAppDataController } from './controllers/app-data-controller'
import { registerCharacterAvatarController } from './controllers/character-avatar-controller'
import { CharacterAssetService } from './services/character-asset-service'
import { projectAccess } from './services/project-access'
import { getProjectDataRoot } from './services/project-data-locator'
import { CloudProjectBindingStore } from './services/cloud-project-binding-store'

/**
 * issue #245：主进程是单线程，任何一个同步处理超过几百毫秒，窗口消息泵就停摆，
 * 作者看到的是「未响应」。这里给所有 invoke 通道加上耗时，≥300ms 才打一行；
 * 常规通道零噪音，日志与 [perf-open] 同一条 stderr 流。
 */
const SLOW_IPC_MS = 300
/** 文件通道把文件/目录名带上：每次安全文件操作都要起 PowerShell 助手，慢调用必须一眼看出是谁。 */
function ipcArgHint(channel: string, args: readonly unknown[]): string {
  if (!channel.startsWith('fs:')) return ''
  const candidate = args.find(value => typeof value === 'string' && /[\\/]/u.test(value))
  return typeof candidate === 'string' ? ` path=${candidate.split(/[\\/]/u).pop() ?? ''}` : ''
}
function instrumentIpcDurations(): void {
  const target = ipcMain as unknown as {
    handle: (channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void
  }
  const original = target.handle.bind(ipcMain)
  target.handle = (channel, listener) => original(channel, async (event, ...args) => {
    const startedAt = Date.now()
    try {
      return await listener(event, ...args)
    } finally {
      const elapsed = Date.now() - startedAt
      if (elapsed >= SLOW_IPC_MS) console.error(`[perf-ipc] ${channel} took ${elapsed}ms${ipcArgHint(channel, args)}`)
    }
  })
}

/**
 * 注册所有 IPC 通道 — 在主进程启动时调用
 * (采用多控制器路由模式，解耦各个模块的庞大逻辑)
 */
export function registerIPCHandlers() {
  assertGlobalDataReady()
  instrumentIpcDurations()

  // 挂载控制器路由
  registerWindowController()
  registerOfficialHomepageController()
  registerModelProviderResourceController()
  registerConfigController()
  registerAppDataController()
  const cloudProjectBindings = new CloudProjectBindingStore()
  registerProjectController({
    removeDeletedProjectBinding: projectId => { cloudProjectBindings.removeDeletedProject(projectId) },
  })
  registerProjectArchiveController()
  registerCloudBackupController()
  registerFSController()
  registerExternalFileGrantController()
  registerGenerationController(registerLLMController())
  registerDatabaseController()
  registerCharacterAvatarController({
    resolveService(_event, context) {
      let active
      try {
        active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      } catch { return null }
      const database = getProjectDb()
      if (!database) return null
      const service = new CharacterAssetService({ projectId: context.projectId, sessionLease: context.leaseId,
        storageRoot: getProjectDataRoot(active.rootPath), database })
      service.recordReclaimableOrphans()
      return service
    },
  })
  registerFinalizationController()
  registerChapterLifecycleController()
  registerKBController()
  registerImportController()

  console.log('[AI Novel IPC] 所有 Controller 已注册完成')
}
