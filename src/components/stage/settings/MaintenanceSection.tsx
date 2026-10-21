import { useCallback, useEffect, useMemo, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession } from '../../project-session-gate'
import { appErrorMessage } from '../../../i18n/app-errors'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { pluralEn } from '../../../shared/plural-en'
import { Button } from '../../ui/Button'
import { requireIpcSuccess } from '../../../services/ipc-result'
import { GENERATION_PROMPT_RETENTION } from '../../../shared/generation-log-retention'

interface PromptStorageStats {
  totalCalls: number
  callsWithPrompt: number
  callsTrimmed: number
  promptBytes: number
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(1) + ' MB'
}

/**
 * 项目维护：生成日志占了多少、按保留策略能回收多少。
 *
 * 日志每次都记录完整 Prompt（查到问题时能回看模型到底收到什么），但只有最近
 * GENERATION_PROMPT_RETENTION 次保留全文。运行期自动清理只是把旧 Prompt 置空，
 * SQLite 不会自己把文件缩小，要 VACUUM 才行——那一步在几百 MB 的库上要十几秒，
 * 所以放在这里由作者明确触发，而不是挡在打开作品的路上。
 */
export default function MaintenanceSection() {
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const [stats, setStats] = useState<PromptStorageStats | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')

  /**
   * 会话与路径按当前作品的**身份**取，而不是按对象引用。
   *
   * 这里刻意用 useMemo 把 session 钉在「作品路径 + 租约」上：设置页每次重渲染都会拿到
   * 新的 project 对象，如果直接把对象放进依赖，load 的 useCallback 每轮都变，
   * 下面的 useEffect 就会无限重取。
   */
  const projectKey = project?.path ?? ''
  const lease = project?.sessionLease ?? ''
  const session = useMemo(
    () => (project ? captureProjectSession(project) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity, not object reference
    [projectKey, lease],
  )
  const projectPath = project?.path ?? ''

  const load = useCallback(async () => {
    if (!session || !projectPath) return
    try {
      const next = await ipc.invokeWithProjectSession(session, 'db:generation-log-stats', projectPath)
      setStats(next)
      setError('')
    } catch (cause) {
      setError(appErrorMessage(useLocaleStore.getState().locale, cause))
    }
  }, [session, projectPath])

  // 挂载与切作品时读取占用；load 内部只做远端读取后的 setState。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const compact = async () => {
    if (!session || !projectPath || busy) return
    setBusy(true)
    setResult('')
    setError('')
    try {
      const outcome = await ipc.invokeWithProjectSession(session, 'db:generation-log-compact', projectPath)
      requireIpcSuccess(outcome, text('回收生成日志失败', 'Could not reclaim generation logs'))
      if (outcome.after) setStats(outcome.after)
      setResult(
        outcome.trimmed && outcome.trimmed > 0
          ? text(
            `已清理 ${outcome.trimmed} 次调用的 Prompt，并压缩了数据库。返回文本与用途都还在。`,
            `Trimmed prompts for ${outcome.trimmed} ${pluralEn(outcome.trimmed ?? 0, "call")} and compacted the database. Responses and purposes are kept.`,
          )
          : text('没有可回收的 Prompt：当前都在保留范围内。', 'Nothing to reclaim: every prompt is within the retention window.'),
      )
    } catch (cause) {
      setError(appErrorMessage(useLocaleStore.getState().locale, cause))
    } finally {
      setBusy(false)
    }
  }

  const reclaimable = stats ? (stats.callsWithPrompt > GENERATION_PROMPT_RETENTION
    ? Math.max(0, stats.callsWithPrompt - GENERATION_PROMPT_RETENTION)
    : 0) : 0

  return (
    <div className="stage-set-rows">
      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">
            {text('生成日志的 Prompt', 'Prompts in generation logs')}
          </p>
          <p className="stage-set-row-desc">
            {text(
              `每次调用都记录完整 Prompt，便于回看模型收到了什么。只保留最近 ${GENERATION_PROMPT_RETENTION} 次的全文，更早的会清掉 Prompt、保留返回文本。`,
              `Every call records its full prompt so you can see what the model received. Only the most recent ${GENERATION_PROMPT_RETENTION} keep full prompts; earlier ones lose the prompt but keep the response.`,
            )}
          </p>
        </div>
      </div>

      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('当前占用', 'Current usage')}</p>
          <p className="stage-set-row-desc">
            {stats
              ? text(
                `${stats.totalCalls} 次调用 · 其中 ${stats.callsWithPrompt} 次带 Prompt（${formatSize(stats.promptBytes)}）· 已清理 ${stats.callsTrimmed} 次`,
                `${stats.totalCalls} ${pluralEn(stats.totalCalls, "call")} · ${stats.callsWithPrompt} with a prompt (${formatSize(stats.promptBytes)}) · ${stats.callsTrimmed} trimmed`,
              )
              : text('正在读取…', 'Loading…')}
          </p>
        </div>
      </div>

      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('回收空间', 'Reclaim space')}</p>
          <p className="stage-set-row-desc">
            {reclaimable > 0
              ? text(
                `超出保留范围的还有 ${reclaimable} 次调用。回收会清理这些 Prompt 并压缩数据库，正文与大纲不受影响；大库可能花十几秒。`,
                `${reclaimable} ${pluralEn(reclaimable, "call")} ${pluralEn(reclaimable, "is", "are")} outside the retention window. Reclaiming trims their prompts and compacts the database; your text and outlines are untouched. Large books may take ten seconds or more.`,
              )
              : text('当前没有超出保留范围的 Prompt。', 'No prompts are outside the retention window.')}
          </p>
          {result && <p className="stage-set-row-desc">{result}</p>}
          {error && <p className="stage-set-row-desc" role="alert">{error}</p>}
        </div>
        <div className="stage-set-row-ctl">
          <Button variant="secondary" size="sm" disabled={busy || reclaimable === 0} onClick={() => { void compact() }}>
            <HardDrive size={14} aria-hidden />
            {busy ? text('回收中…', 'Reclaiming…') : text('回收空间', 'Reclaim space')}
          </Button>
        </div>
      </div>
    </div>
  )
}
