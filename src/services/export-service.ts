/**
 * 导出服务 — 将小说项目导出为多种格式
 *
 * 支持：
 * - 合并 Markdown（全书合并为单个 .md）
 * - 分章 Markdown（每章一个 .md）
 * - 纯文本 TXT
 */
import { ipc } from './ipc-client'
import { requireIpcSuccess } from './ipc-result'
import { useWorkflowStore } from '../stores/workflow-store'
import { useLocaleStore } from '../stores/locale-store'
import type { Locale } from '../i18n/types'
import type { FileWriteCommitState, ProjectSessionContext } from '../shared/ipc-channels'
import type {
  FinalizedDraftExportAuthorityReceipt,
  FinalizedDraftExportSnapshot,
} from '../../electron/repositories/finalization-repository'
import {
  getActiveProjectSessionContext,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import type { WritingLanguage } from '../shared/writing-language'
import { pluralEn } from '../shared/plural-en'
import { plotOutlineChapterSpans } from '../shared/plot-outline-contract'


export type ExportFormat = 'merged-md' | 'split-md' | 'txt'

interface ExportOptions {
  format: ExportFormat
  /** 由主进程选择目录后签发的受限授权，绝不是绝对路径。 */
  grantId: string
  includeOutline?: boolean
  includeCharacters?: boolean
}

/** 导出任务冻结的项目展示数据；项目路径本身绝不作为访问凭据。 */
export interface ExportProjectSnapshot {
  id: string
  sessionLease: string
  path: string
  name: string
  novelConfig: Readonly<{
    genre: string
    targetAudience: string
    writingLanguage: WritingLanguage
  }>
}

function isProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(projectSession, getActiveProjectSessionContext())
}

function isMatchingProjectSnapshot(
  project: ExportProjectSnapshot,
  projectSession: ProjectSessionContext,
): boolean {
  return project.id === projectSession.projectId
    && project.sessionLease === projectSession.leaseId
    && sameProjectPathKey(project.path, projectSession.projectPath)
}

function staleExportResult(locale: Locale): { success: false; error: string } {
  return {
    success: false,
    error: locale === 'en-US'
      ? 'The project session changed. This export was cancelled.'
      : '项目会话已变化，本次导出已取消',
  }
}

type ExportWriteFailureCommitState = Exclude<FileWriteCommitState, 'committed'>

function requireExportWriteSuccess(
  result: { success: boolean; commitState?: FileWriteCommitState; error?: string },
  action: string,
  fallbackMessage: string,
): void {
  try {
    requireIpcSuccess(result, action, fallbackMessage)
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      {
        commitState: result.commitState === 'unknown'
          ? 'unknown'
          : 'not_committed',
      } satisfies { commitState: ExportWriteFailureCommitState },
    )
  }
}

function exportWriteFailureCommitState(error: unknown): ExportWriteFailureCommitState | undefined {
  if (!error || typeof error !== 'object' || !('commitState' in error)) return undefined
  const value = (error as { commitState?: unknown }).commitState
  return value === 'not_committed' || value === 'unknown' ? value : undefined
}

function splitWriteDetail(
  locale: Locale,
  confirmedWritten: readonly string[],
  possiblyWritten: readonly string[],
  definitelyFailed?: string,
): string {
  const none = locale === 'en-US' ? 'none' : '无'
  const detail = locale === 'en-US'
    ? `; confirmed written: ${confirmedWritten.join(', ') || none}; possibly written: ${possiblyWritten.join(', ') || none}; definitely failed: ${definitelyFailed || none}`
    : `；已确认写入: ${confirmedWritten.join(', ') || none}；可能已写入: ${possiblyWritten.join(', ') || none}；确定写入失败: ${definitelyFailed || none}`
  if (possiblyWritten.length === 0) return detail
  return `${detail}${locale === 'en-US'
    ? '; verify possibly written files before retrying; do not retry blindly'
    : '；请先核对可能已写入的文件，不要盲目重试'}`
}

function staleSplitExportResult(
  locale: Locale,
  confirmedWritten: readonly string[],
  possiblyWritten: readonly string[] = [],
  definitelyFailed?: string,
): { success: false; error: string } {
  const stale = staleExportResult(locale)
  return {
    ...stale,
    error: `${stale.error}${splitWriteDetail(
      locale,
      confirmedWritten,
      possiblyWritten,
      definitelyFailed,
    )}`,
  }
}

function unknownSingleWriteDetail(locale: Locale, relativePath: string): string {
  return locale === 'en-US'
    ? `; ${relativePath} may have been written; verify it before retrying and do not retry blindly`
    : `；${relativePath} 可能已写入；请先核对，不要盲目重试`
}

function staleCommittedSingleExportResult(locale: Locale, relativePath: string): { success: false; error: string } {
  const stale = staleExportResult(locale)
  return {
    ...stale,
    error: `${stale.error}${locale === 'en-US'
      ? `; the exported file was already written: ${relativePath}`
      : `；导出文件已确认写入: ${relativePath}`}`,
  }
}

function changedFinalizationResult(
  locale: Locale,
  confirmedWritten: readonly string[] = [],
): { success: false; error: string } {
  const error = locale === 'en-US'
    ? 'The finalized chapters changed. Review the latest versions and confirm the export again.'
    : '定稿章节已变化，请检查最新版本并重新确认导出'
  return {
    success: false,
    error: confirmedWritten.length > 0
      ? `${error}${splitWriteDetail(locale, confirmedWritten, [])}`
      : error,
  }
}

function requireFinalizedExportSnapshot(value: unknown): FinalizedDraftExportSnapshot[] {
  if (!Array.isArray(value)) throw new Error('定稿导出快照无效')
  const seenChapters = new Set<number>()
  const rows = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('定稿导出快照无效')
    const row = candidate as Partial<FinalizedDraftExportSnapshot>
    const { draftId, chapterNumber, version, title, content, finalizationId, contentHash } = row
    if (
      typeof draftId !== 'number' || !Number.isSafeInteger(draftId) || draftId < 1
      || typeof chapterNumber !== 'number' || !Number.isSafeInteger(chapterNumber) || chapterNumber < 1
      || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
      || typeof title !== 'string'
      || typeof content !== 'string'
      || content.trim().length === 0
      || !(finalizationId === null
        || (typeof finalizationId === 'string' && finalizationId.trim().length > 0))
      || typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(contentHash)
    ) throw new Error('定稿导出快照身份或正文无效')
    if (seenChapters.has(chapterNumber)) throw new Error(`第 ${chapterNumber} 章存在重复定稿`)
    seenChapters.add(chapterNumber)
    return Object.freeze({
      draftId,
      chapterNumber,
      version,
      title,
      content,
      finalizationId,
      contentHash,
    })
  })
  return rows.sort((left, right) => left.chapterNumber - right.chapterNumber)
}

function exportAuthorityReceipt(
  drafts: readonly FinalizedDraftExportSnapshot[],
): FinalizedDraftExportAuthorityReceipt {
  return drafts.map(({
    draftId,
    chapterNumber,
    version,
    finalizationId,
    contentHash,
  }) => ({ draftId, chapterNumber, version, finalizationId, contentHash }))
}

function renderMarkdownChapter(
  chapterNumber: number,
  title: string,
  content: string,
  writingLanguage: WritingLanguage,
): string {
  const chapterTitle = writingLanguage === 'en-US'
    ? `Chapter ${chapterNumber}${title ? ` ${title}` : ''}`
    : `第${chapterNumber}章${title ? ` ${title}` : ''}`
  const heading = `# ${chapterTitle}`
  const firstLineEnd = content.indexOf('\n')
  const firstLine = content
    .slice(0, firstLineEnd === -1 ? content.length : firstLineEnd)
    .replace(/\r$/u, '')
  const firstAtxHeading = firstLine.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u)

  if (firstAtxHeading?.[1]?.trim() === chapterTitle) {
    return `${heading}${firstLineEnd === -1 ? '' : content.slice(firstLineEnd)}`
  }
  return `${heading}\n\n${content}`
}

/**
 * 合并导出里的大纲段（issue #57）。
 *
 * 三条规则：
 * 1. **写明覆盖范围**：只覆盖前几章时，段首直接写「故事大纲（第 1–3 章；全书已定稿 21 章）」，
 *    不让读者以为这寥寥三条概括了全书；
 * 2. **标题降级**：大纲条目从二级标题降成三级标题——正文用一级标题，
 *    同一文件里不再出现同名同标点的两个标题；
 * 3. **结构提示**：大纲没覆盖到的章节直接说清「之后的章节没有对应大纲条目」，
 *    下面是从「正文」开始的正式稿；这里不做词法清洗（那属于生成侧的事）。
 */
export function renderOutlineSection(synopsis: string, finalizedChapters: number, writingLanguage: WritingLanguage): string {
  const body = String(synopsis ?? '').replace(/\r\n?/gu, '\n').trim()
  if (!body) return ''
  const entries = plotOutlineChapterSpans(body)
  const covered = entries.length ? entries[entries.length - 1]!.chapter : null
  const coveredFrom = entries.length ? entries[0]!.chapter : null
  const title = writingLanguage === 'en-US' ? '## Story outline' : '## 故事大纲'
  const scope = entries.length === 0
    ? (writingLanguage === 'en-US'
      ? '(no per-chapter entries found in the outline)'
      : '（大纲里没有按章条目）')
    : writingLanguage === 'en-US'
      ? `(chapters ${coveredFrom}-${covered}; ${finalizedChapters} chapters are finalized)`
      : `（第 ${coveredFrom}–${covered} 章；全书已定稿 ${finalizedChapters} 章）`
  // 标题降级：只动标题行，正文逐字保留。
  const demoted = body.replace(/^ {0,3}##(?!#)([ 	]+)/gmu, '###$1')
  const missing = covered !== null && covered < finalizedChapters
    ? (writingLanguage === 'en-US'
      ? '\n\n> The outline only covers chapters ' + `${coveredFrom}-${covered}; later chapters have no outline entry. The prose below is the manuscript itself.`
      : '\n\n> 大纲只覆盖到第 ' + `${covered} 章，之后的章节没有对应大纲条目；下面是从「正文」开始的正式稿。`)
    : ''
  return `${title} ${scope}` + '\n\n' + `${demoted}${missing}`
}

/**
 * 分章导出目录名里的时间戳（issue #56）。
 *
 * 用本地时间而不是 UUID：UUID 对用户是噪音，而时间戳既保证「每次导出是新目录」
 * （不残留上一次的章），又能让人看懂这是哪一次的导出。
 * 形如 `20261102-153012`（精确到秒）。
 *
 * 必须精确到秒：同一分钟内连导两次是常见操作（改一处再导一次看效果），
 * 分钟级粒度会让两次落到同一目录——那正是「上一次的章残留在本次产物里」的老问题，
 * 而授权通道没有删除目录的能力，只能靠目录名不同来保证干净。
 */
function exportStamp(drafts: readonly FinalizedDraftExportSnapshot[], now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  // 后缀取**本次导出内容的短哈希**，不是随机数：同一批定稿重复导出会落到同一目录
  // （覆盖干净，不再并存两个目录）；内容变了才换目录（不会把上一次的章留在里面）。
  // 只取 6 位hex，是给人看的标识而不是内部 UUID。
  let seed = 0
  for (const draft of drafts) {
    const input = `${draft.chapterNumber}:${draft.contentHash};`
    for (let index = 0; index < input.length; index += 1) {
      seed = (seed * 31 + input.charCodeAt(index)) % 0xffffffff
    }
  }
  return `${stamp}-${seed.toString(16).padStart(6, '0')}`
}

/**
 * 三种格式共用的「故事大纲」写入（issue #56）。
 *
 * 原来只有合并 Markdown 读了 `options.includeOutline`，split-md 与 txt 从头到尾
 * 没有出现过这个字段——而对话框里那个勾是**默认已勾选**的，用户以为大纲跟着走了。
 *
 * 返回：
 *  - `null`  —— 选项关闭，或项目没有大纲（无需写、也不算失败）；
 *  - `string` —— 出错说明（调用方直接当失败结果返回）；
 *  - `true`   —— 已写入。
 */
async function writeOutlineFile(
  relativePath: string,
  grantId: string,
  project: ExportProjectSnapshot,
  chapters: number,
  projectSession: ProjectSessionContext,
  uiLocale: 'zh-CN' | 'en-US',
): Promise<null | true | { success: false; error: string }> {
  const core = await ipc.invokeWithProjectSession(
    projectSession,
    'db:project-core-get',
    projectSession.projectPath,
  ).catch(() => null)
  if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
  if (!core?.synopsis?.trim()) return null
  const content = renderOutlineSection(core.synopsis, chapters, project.novelConfig.writingLanguage)
  const writeResult = await ipc.invoke('fs:grant-write-file', grantId, relativePath, content)
  requireExportWriteSuccess(
    writeResult,
    uiLocale === 'en-US' ? 'Write outline file' : '写入大纲文件',
    uiLocale === 'en-US' ? 'Failed to write the outline file.' : '写入大纲文件失败。',
  )
  return true
}

/** 导出全书 */
export async function exportNovel(
  options: ExportOptions,
  project: ExportProjectSnapshot,
  projectSession: ProjectSessionContext,
): Promise<{ success: boolean; path?: string; error?: string }> {
  const uiLocale = useLocaleStore.getState().locale
  const text = (zhCNText: string, enUSText: string) => uiLocale === 'en-US' ? enUSText : zhCNText
  const writtenSplitFiles: string[] = []
  let activeWritePath: string | undefined
  if (!isMatchingProjectSnapshot(project, projectSession) || !isProjectSessionCurrent(projectSession)) {
    return staleExportResult(uiLocale)
  }

  const addLog = useWorkflowStore.getState().addLog
  addLog('info', text(
    `开始导出（${formatLabel(options.format, uiLocale)}）...`,
    `Starting export (${formatLabel(options.format, uiLocale)})...`,
  ), uiLocale)

  try {
    const frozenDrafts = requireFinalizedExportSnapshot(await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-export-snapshot',
      projectSession.projectPath,
    ))
    const authorityReceipt = exportAuthorityReceipt(frozenDrafts)
    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    // 章节文件名零填充（issue #56）：`chapter_2.md` 排在 `chapter_10.md` 之后，
    // 21 章就已经乱序，100 章会整层乱掉；外部工具（pandoc/Calibre/脚本）按文件名
    // 拼接正文时，顺序一错就是正本错。按**最大章号的位数**补零，
    // 不做固定 3 位——否则 12 章的书写出 chapter_001.md 反而不自然。
    const digits = Math.max(2, String(Math.max(...frozenDrafts.map(draft => draft.chapterNumber), 1)).length)
    const chapterContents = frozenDrafts.map(draft => ({
      chapterNumber: draft.chapterNumber,
      title: draft.title.trim(),
      name: `chapter_${String(draft.chapterNumber).padStart(digits, '0')}.md`,
      content: draft.content,
      markdownContent: renderMarkdownChapter(
        draft.chapterNumber,
        draft.title.trim(),
        draft.content,
        project.novelConfig.writingLanguage,
      ),
    }))

    if (chapterContents.length === 0) {
      return {
        success: false,
        error: text('无可导出的章节（无定稿章节）', 'There are no finalized chapters to export.'),
      }
    }

    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    addLog('info', text(
      `找到 ${chapterContents.length} 个已定稿章节`,
      `Found ${chapterContents.length} finalized ${pluralEn(chapterContents.length, 'chapter')}.`,
    ), uiLocale)

    let outputPath = ''
    const projectFileStem = exportFileStem(project.name)

    switch (options.format) {
      case 'merged-md': {
        // 合并为单个 Markdown
        let content = `# ${project.name}\n\n`
        content += `> ${project.novelConfig.genre} · ${project.novelConfig.targetAudience}\n\n---\n\n`

        // 可选：包含大纲（issue #57）
        //
        // 旧写法直接把 `project_core.synopsis` 贴进来。它只覆盖最初几章（本样本 21 章定稿、
        // synopsis 只有第 1–3 章），于是导出文件开头是三条写作计划、紧接着又是同样标题的正文，
        // 读者拿不准哪份是书；而这份大纲描述的有些情节正文里从未发生。
        // 现在：① 段首写明大纲实际覆盖到第几章、全书已定稿几章；② 大纲条目降级为三级标题
        // （正文是一级），同一文件里不再出现两种层级、两种标点的同名标题；
        // ③ 正文段前加一条明确的分节标题，两段之间不再只隔一条分隔线。
        if (options.includeOutline) {
          const core = await ipc.invokeWithProjectSession(
            projectSession,
            'db:project-core-get',
            projectSession.projectPath,
          )
          if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
          if (core?.synopsis) {
            content += renderOutlineSection(core.synopsis, chapterContents.length, project.novelConfig.writingLanguage)
              + '\n\n---\n\n'
          }
        }
        content += project.novelConfig.writingLanguage === 'en-US' ? '# Chapters\n\n' : '# 正文\n\n'

        // 章节内容
        for (const ch of chapterContents) {
          content += ch.markdownContent + '\n\n---\n\n'
        }

        outputPath = `${projectFileStem}.md`
        const authorityCurrent = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-export-authority-current',
          authorityReceipt,
          projectSession.projectPath,
        )
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        if (!authorityCurrent) return changedFinalizationResult(uiLocale)
        activeWritePath = outputPath
        const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, outputPath, content)
        requireExportWriteSuccess(
          writeResult,
          text('写入导出文件', 'Write export file'),
          text('写入导出文件失败', 'Failed to write the exported file.'),
        )
        activeWritePath = undefined
        if (!isProjectSessionCurrent(projectSession)) {
          return staleCommittedSingleExportResult(uiLocale, outputPath)
        }
        break
      }

      case 'split-md': {
        // 每章一个 Markdown。
        //
        // 目录名不再带内部 UUID（issue #56）：原来写的是 `${projectFileStem}-${randomUUID()}`，
        // 内部 run 标识直接落进用户的文件系统，同一目标目录里连导两次就并存两个看不懂的目录。
        // 但仍然必须**每次导出都是新目录**——否则上一次导出的章（比如后来被移除/归档的
        // 第 4 章）会留在目录里冒充本次的产物（`export-service-integration` 里有一条
        // 用例专门守这个属性，而授权通道没有删除目录的能力）。
        // 折中：用可读的时间戳做后缀，人看得懂、每次又都不同。
        const splitDir = `${projectFileStem}（分章 ${exportStamp(frozenDrafts)}）`
        const authorityCurrent = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-export-authority-current',
          authorityReceipt,
          projectSession.projectPath,
        )
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        if (!authorityCurrent) return changedFinalizationResult(uiLocale)
        const mkdirResult = await ipc.invoke('fs:grant-mkdir', options.grantId, splitDir)
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        requireIpcSuccess(
          mkdirResult,
          text('创建导出目录', 'Create export directory'),
          text('创建导出目录失败', 'Failed to create the export directory.'),
        )

        // 「包含故事大纲」在分章导出里原来被静默忽略（issue #56）：只有 merged-md
        // 读了 options.includeOutline，split-md 与 txt 从来没有出现过这个字段——
        // 而分章导出恰恰是最需要大纲的那一种（作者常拿分章文件做逐章对照）。
        // 现在写一个独立的大纲文件，文件名用 00 前缀保证排在第一章之前。
        if (options.includeOutline) {
          const outlineFile = `${splitDir}/outline_00.md`
          const written = await writeOutlineFile(
            outlineFile, options.grantId, project, chapterContents.length, projectSession, uiLocale)
          if (written && typeof written === 'object') return written
          if (written === true) writtenSplitFiles.push(outlineFile)
          if (!isProjectSessionCurrent(projectSession)) {
            return staleSplitExportResult(uiLocale, writtenSplitFiles)
          }
        }

        for (const ch of chapterContents) {
          const stillCurrent = await ipc.invokeWithProjectSession(
            projectSession,
            'db:draft-export-authority-current',
            authorityReceipt,
            projectSession.projectPath,
          )
          if (!isProjectSessionCurrent(projectSession)) {
            return staleSplitExportResult(uiLocale, writtenSplitFiles)
          }
          if (!stillCurrent) return changedFinalizationResult(uiLocale, writtenSplitFiles)
          activeWritePath = `${splitDir}/${ch.name}`
          const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, activeWritePath, ch.markdownContent)
          requireExportWriteSuccess(
            writeResult,
            text(`导出章节 ${ch.name}`, `Export chapter ${ch.name}`),
            text(`导出章节 ${ch.name} 失败`, `Failed to export chapter ${ch.name}.`),
          )
          writtenSplitFiles.push(activeWritePath)
          activeWritePath = undefined
          if (!isProjectSessionCurrent(projectSession)) {
            return staleSplitExportResult(uiLocale, writtenSplitFiles)
          }
        }

        outputPath = splitDir
        break
      }

      case 'txt': {
        // 纯文本（去除 Markdown 格式）。
        // 「包含故事大纲」原来在这里也被静默忽略（issue #56）。TXT 没有目录结构，
        // 所以把大纲接在书名之后、正文之前，并像合并模式那样写明覆盖范围。
        let content = `${project.name}\n${'='.repeat(project.name.length * 2)}\n\n`
        if (options.includeOutline) {
          const core = await ipc.invokeWithProjectSession(
            projectSession, 'db:project-core-get', projectSession.projectPath,
          ).catch(() => null)
          if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
          if (core?.synopsis?.trim()) {
            const outline = renderOutlineSection(
              core.synopsis, chapterContents.length, project.novelConfig.writingLanguage)
              .replace(/^#{1,6}\s+/gmu, '')
              .replace(/\*\*(.*?)\*\*/gu, '$1')
              .trim()
            content += `${outline}\n\n${'-'.repeat(40)}\n\n`
          }
        }

        for (const ch of chapterContents) {
          // 简单去除 Markdown 标记
          const plainText = ch.markdownContent
            .replace(/^#{1,6}\s+/gm, '')  // 去掉标题标记
            .replace(/\*\*(.*?)\*\*/g, '$1')  // 去掉加粗
            .replace(/\*(.*?)\*/g, '$1')  // 去掉斜体
            .replace(/`(.*?)`/g, '$1')  // 去掉代码标记
            .replace(/---+/g, '\n')  // 分隔线
            .trim()

          content += `${plainText}\n\n`
        }

        outputPath = `${projectFileStem}.txt`
        const authorityCurrent = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-export-authority-current',
          authorityReceipt,
          projectSession.projectPath,
        )
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        if (!authorityCurrent) return changedFinalizationResult(uiLocale)
        activeWritePath = outputPath
        const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, outputPath, content)
        requireExportWriteSuccess(
          writeResult,
          text('写入导出文件', 'Write export file'),
          text('写入导出文件失败', 'Failed to write the exported file.'),
        )
        activeWritePath = undefined
        if (!isProjectSessionCurrent(projectSession)) {
          return staleCommittedSingleExportResult(uiLocale, outputPath)
        }
        break
      }
    }

    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    addLog('info', text(`导出完成: ${outputPath}`, `Export complete: ${outputPath}`), uiLocale)
    return { success: true, path: outputPath }
  } catch (error) {
    const commitState = activeWritePath
      ? exportWriteFailureCommitState(error)
      : undefined
    const possiblyWritten = activeWritePath && commitState === 'unknown'
      ? [activeWritePath]
      : []
    const definitelyFailed = activeWritePath && commitState === 'not_committed'
      ? activeWritePath
      : undefined
    if (!isProjectSessionCurrent(projectSession)) {
      if (options.format === 'split-md' && (writtenSplitFiles.length > 0 || activeWritePath)) {
        return staleSplitExportResult(
          uiLocale,
          writtenSplitFiles,
          possiblyWritten,
          definitelyFailed,
        )
      }
      const stale = staleExportResult(uiLocale)
      return activeWritePath && commitState === 'unknown'
        ? { ...stale, error: `${stale.error}${unknownSingleWriteDetail(uiLocale, activeWritePath)}` }
        : stale
    }
    const partialWriteDetail = options.format === 'split-md' && (writtenSplitFiles.length > 0 || activeWritePath)
      ? splitWriteDetail(uiLocale, writtenSplitFiles, possiblyWritten, definitelyFailed)
      : activeWritePath && commitState === 'unknown'
        ? unknownSingleWriteDetail(uiLocale, activeWritePath)
        : ''
    const errorMessage = `${String(error)}${partialWriteDetail}`
    addLog('error', text(`导出失败: ${errorMessage}`, `Export failed: ${errorMessage}`), uiLocale)
    return { success: false, error: errorMessage }
  }
}

/** Windows 与 POSIX 都安全的导出相对路径段，禁止项目名改变授权目录边界。 */
function exportFileStem(name: string): string {
  const normalized = Array.from(name, (character) => (
    character.charCodeAt(0) < 32 ? '_' : character
  )).join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return normalized || 'novel'
}

function formatLabel(format: ExportFormat, locale: Locale): string {
  const labels: Record<ExportFormat, readonly [string, string]> = {
    'merged-md': ['合并 Markdown', 'Merged Markdown'],
    'split-md': ['分章 Markdown', 'Split Markdown'],
    'txt': ['纯文本 TXT', 'Plain text (TXT)'],
  }
  return labels[format][locale === 'en-US' ? 1 : 0]
}
