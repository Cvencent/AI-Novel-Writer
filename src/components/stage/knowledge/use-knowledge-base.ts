import { useCallback, useEffect, useRef, useState } from 'react'
import { appErrorMessage } from '../../../i18n/app-errors'
import { ipc } from '../../../services/ipc-client'
import {
  selectPlanningMaterials,
  unwrapKnowledgeValue,
  type KBDocument, type KBStatsData, type SearchResult, type VectorRebuildStatus,
} from '../../../services/knowledge-service'
import {
  createPlanningMaterialCharacterExtractionWorkflow,
  createPlanningMaterialWorkflow,
} from '../../../services/workflows/planning-material-workflow'
import { globalEventBus } from '../../../shared/event-bus'
import type { ModelProfile, ProjectSessionContext } from '../../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../../shared/project-session-context'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../../stores/workflow-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { toast } from '../../ui/Toast'

const EMPTY_STATS: KBStatsData = { documentCount: 0, totalChunks: 0, vectorDimension: 0 }

export interface DocumentCopy {
  available: boolean
  content?: string
  contentHash?: string
  edited?: boolean
  indexStatus: 'current' | 'stale' | 'unavailable'
}

/** 定稿章节由定稿自动收入，要改就改正文；其余都是作者导入的资料。 */
export function isImportedDocument(document: KBDocument): boolean {
  return document.finalizedChapter === undefined
}

/**
 * 检索索引的状态与检查重建。新外壳把它放在设置的检索模型页，旧外壳仍在知识库页；
 * 状态检查只读本地数据，重建会按当前检索模型补全或重建。
 */
export function useKnowledgeIndex() {
  const currentProject = useProjectStore(s => s.currentProject)
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)
  const [status, setStatus] = useState<VectorRebuildStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [backfilling, setBackfilling] = useState(false)

  const loadStatus = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    try {
      const result = await ipc.invokeWithProjectSession(projectSession, 'kb:get-vector-rebuild-status', projectSession.projectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      setStatus(unwrapKnowledgeValue(result))
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) setStatusError(appErrorMessage(locale, error))
    }
  }, [currentProject, locale])

  const backfill = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    setBackfilling(true)
    try {
      const result = await ipc.invokeWithProjectSession(projectSession, 'kb:backfill-vectors', expectedProjectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      if (result.success) {
        toast.success(result.processed === 0
          ? text('向量索引检查完成，当前模型无需重建', 'Vector index check complete; the current model does not need a rebuild')
          : text(`向量索引重建完成：已处理 ${result.processed} 块${result.failed > 0 ? `，${result.failed} 块失败` : ''}`, `Vector index rebuilt: ${result.processed} chunks processed${result.failed > 0 ? `, ${result.failed} failed` : ''}`))
      } else {
        toast.error(result.error || text('向量回填失败', 'Vector backfill failed'))
      }
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(appErrorMessage(locale, error))
    } finally {
      if (isProjectSessionCurrent(projectSession)) {
        setBackfilling(false)
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'], projectPath: expectedProjectPath, projectSession })
      }
    }
  }, [currentProject, locale, text])

  const reset = useCallback(() => {
    setStatus(null)
    setStatusError('')
    setBackfilling(false)
  }, [])

  return { status, statusError, backfilling, loadStatus, backfill, reset }
}

/**
 * 知识库的数据：资料列表与统计、资料原文的项目副本（读、改、存、更新本地索引）、检索、清空与导入创作资料。
 * 新外壳的知识库页与旧外壳的 KnowledgeOverview 共用。确认（切换时放弃修改、清空、外发提取）由页面各自呈现，
 * 这里只在确认之后执行。
 */
export function useKnowledgeBase() {
  const currentProject = useProjectStore(s => s.currentProject)
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)
  const index = useKnowledgeIndex()
  const { loadStatus, reset: resetIndex } = index
  const [documents, setDocuments] = useState<KBDocument[]>([])
  const [stats, setStats] = useState<KBStatsData>(EMPTY_STATS)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [topK, setTopK] = useState(10)
  const [clearing, setClearing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [documentCopy, setDocumentCopy] = useState<DocumentCopy | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [documentBusy, setDocumentBusy] = useState(false)
  const documentRequest = useRef(0)

  const loadData = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    try {
      const [documentsResult, statsResult] = await Promise.all([
        ipc.invokeWithProjectSession(projectSession, 'kb:list-documents', expectedProjectPath),
        ipc.invokeWithProjectSession(projectSession, 'kb:stats', expectedProjectPath),
      ])
      if (!isProjectSessionCurrent(projectSession)) return
      setDocuments(unwrapKnowledgeValue(documentsResult))
      setStats(unwrapKnowledgeValue(statsResult))
      setLoadError('')
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      setLoadError(appErrorMessage(locale, error))
    }
  }, [currentProject, locale])

  useEffect(() => {
    let mounted = true
    Promise.resolve().then(() => {
      const projectSession = captureProjectSession(currentProject)
      if (!mounted || !projectSession) return
      setDocuments([])
      setStats(EMPTY_STATS)
      setSearchResults([])
      setSelectedDocId(null)
      documentRequest.current++
      setDocumentCopy(null)
      setDraftContent('')
      resetIndex()
      setLoadError('')
      setSearching(false)
      setClearing(false)
      setDocumentBusy(false)
      void loadData()
      void loadStatus()
    })
    return () => { mounted = false }
  }, [currentProject, loadData, loadStatus, resetIndex])

  useEffect(() => {
    Promise.resolve().then(() => loadStatus())
  }, [loadStatus, documents])

  useEffect(() => {
    const offRefresh = globalEventBus.on('REFRESH_RESOURCE', (payload) => {
      const projectSession = captureProjectSession(currentProject)
      if (
        projectSession
        && sameProjectSessionContext(projectSession, payload.projectSession)
        && (payload.resources.includes('all') || payload.resources.includes('fileTree'))
      ) {
        void loadData()
        void loadStatus()
      }
    })
    const offFinalize = globalEventBus.on('FINALIZE_COMPLETE', ({ projectSession: eventSession }) => {
      const projectSession = captureProjectSession(currentProject)
      if (!projectSession || !sameProjectSessionContext(projectSession, eventSession)) return
      void loadData()
      void loadStatus()
    })
    return () => { offRefresh(); offFinalize() }
  }, [currentProject, loadData, loadStatus])

  /** 项目副本改过但还没保存。 */
  const dirty = Boolean(documentCopy?.available && draftContent !== documentCopy.content)

  /** 打开一份资料的项目副本。有未保存的修改时调用方须先征得作者同意。 */
  const openDocument = async (docId: string, reload = false) => {
    const session = captureProjectSession(currentProject)
    if (!session) return
    if (!reload && docId === selectedDocId) return
    const request = ++documentRequest.current
    setSelectedDocId(docId)
    setDocumentCopy(null)
    try {
      const result = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(session, 'kb:read-document-copy', docId, session.projectPath))
      if (!isProjectSessionCurrent(session) || request !== documentRequest.current) return
      setDocumentCopy(result)
      setDraftContent(result.content ?? '')
    } catch (error) {
      if (isProjectSessionCurrent(session) && request === documentRequest.current) toast.error(appErrorMessage(locale, error))
    }
  }

  const saveDocument = async () => {
    const session = captureProjectSession(currentProject)
    if (!session || !selectedDocId || !documentCopy?.available || !documentCopy.contentHash) return
    setDocumentBusy(true)
    try {
      const result = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(session, 'kb:save-document-copy', selectedDocId, draftContent, documentCopy.contentHash, session.projectPath))
      if (!isProjectSessionCurrent(session)) return
      if (!result.success) { toast.error(result.error || text('保存失败', 'Save failed')); return }
      await openDocument(selectedDocId, true)
      setSearchResults([])
      toast.success(text('项目副本已保存，索引待更新', 'Project copy saved; index update needed'))
    } catch (error) {
      if (isProjectSessionCurrent(session)) toast.error(appErrorMessage(locale, error))
    } finally { if (isProjectSessionCurrent(session)) setDocumentBusy(false) }
  }

  const reindexDocument = async () => {
    const session = captureProjectSession(currentProject)
    if (!session || !selectedDocId) return
    setDocumentBusy(true)
    try {
      const result = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(session, 'kb:reindex-document-copy', selectedDocId, session.projectPath))
      if (!isProjectSessionCurrent(session)) return
      if (!result.success || !result.docId) { toast.error(result.error || text('重建失败', 'Rebuild failed')); return }
      await loadData()
      await loadStatus()
      await openDocument(result.docId, true)
      setSearchResults([])
      toast.success(text('本地全文索引已更新', 'Local text index updated'))
    } catch (error) {
      if (isProjectSessionCurrent(session)) toast.error(appErrorMessage(locale, error))
    } finally { if (isProjectSessionCurrent(session)) setDocumentBusy(false) }
  }

  const search = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    setSearching(true)
    try {
      const result = await ipc.invokeWithProjectSession(projectSession, 'kb:search', searchQuery, topK, projectSession.projectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      setSearchResults(unwrapKnowledgeValue(result))
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(appErrorMessage(locale, error))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSearching(false)
    }
  }

  /** 清空当前作品的知识库。session 是作者确认前取下的会话；确认期间换了作品就不清。 */
  const clearAll = async (projectSession: ProjectSessionContext) => {
    if (!isProjectSessionCurrent(projectSession)) {
      toast.error(text('项目已切换，本次清空操作已取消', 'The project changed, so the clear operation was cancelled'))
      return
    }
    const expectedProjectPath = projectSession.projectPath
    setClearing(true)
    try {
      const result = await ipc.invokeWithProjectSession(projectSession, 'kb:clear-all', expectedProjectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      if (result.success) {
        documentRequest.current++
        setSelectedDocId(null)
        setDocumentCopy(null)
        setDraftContent('')
        setDocuments([])
        setStats(EMPTY_STATS)
        setSearchResults([])
        resetIndex()
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'], projectPath: expectedProjectPath, projectSession })
        toast.success(text('知识库已清空', 'Knowledge base cleared'))
      } else {
        toast.error(result.error || text('清空知识库失败', 'Could not clear the knowledge base'))
      }
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(appErrorMessage(locale, error))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setClearing(false)
    }
  }

  /**
   * 导入创作资料：先只存进本地知识库；配置了生成模型时，再经 confirmExtraction 征得同意，把选中的文本发给模型提取角色卡。
   */
  const importPlanningMaterials = async (confirmExtraction: (model: ModelProfile) => Promise<boolean>) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || importing) return
    setImporting(true)
    try {
      const materials = await selectPlanningMaterials()
      if (materials.length === 0 || !isProjectSessionCurrent(projectSession)) return
      const workflowStore = useWorkflowStore.getState()
      const localRunId = await workflowStore.startWorkflow(createPlanningMaterialWorkflow({ projectSession, materials }))
      const localRun = useWorkflowStore.getState().history.find(run => run.id === localRunId)
      if (localRun?.status !== 'completed' || !isProjectSessionCurrent(projectSession)) return

      const llmState = useLLMStore.getState()
      const model = llmState.models.find(candidate => candidate.id === llmState.defaultModelId)
      if (!model) {
        toast.success(text(
          '创作资料已仅导入本地知识库；配置生成模型后可提取角色卡',
          'Planning material was imported only into the local knowledge base. Configure a generation model to extract character cards.',
        ))
        return
      }
      const shouldExtract = await confirmExtraction(model)
      if (!shouldExtract || !isProjectSessionCurrent(projectSession)) return

      const extractionWorkflow = createPlanningMaterialCharacterExtractionWorkflow({ projectSession, materials, generationModelId: model.id })
      const conflict = useWorkflowStore.getState().getResourceConflict(extractionWorkflow)
      if (conflict) {
        toast.warning(workflowResourceConflictMessage(locale, conflict.title))
        return
      }
      navigate({ kind: 'run', facet: 'tasks' })
      await useWorkflowStore.getState().startWorkflow(extractionWorkflow, true)
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) toast.error(appErrorMessage(locale, error))
    } finally {
      setImporting(false)
    }
  }

  return {
    index, reload: loadData,
    documents, stats, loadError,
    selectedDocId, documentCopy, draftContent, setDraftContent, documentBusy, dirty,
    openDocument, saveDocument, reindexDocument,
    searchQuery, setSearchQuery, topK, setTopK, searchResults, setSearchResults, searching, search,
    clearing, clearAll,
    importing, importPlanningMaterials,
  }
}
