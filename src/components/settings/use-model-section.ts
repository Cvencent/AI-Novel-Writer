import { useEffect, useState } from 'react'
import { useLLMStore } from '../../stores/llm-store'
import type { ModelProfile } from '../../shared/ipc-channels'
import { createModelProfileDraft } from '../../shared/model-profile-draft'
import { randomUUID } from '../../utils/id'

/**
 * 一类模型（生成或向量）的列表与编辑：按用途过滤、新增草稿、保存（该类第一个自动设为默认）、删除、设为默认。
 * 旧外壳设置弹窗与新外壳设置页共用。
 */
export function useModelSection(purposes: ModelProfile['purposes']) {
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const defaultEmbeddingModelId = useLLMStore(s => s.defaultEmbeddingModelId)
  const loaded = useLLMStore(s => s.loaded)
  const loadModels = useLLMStore(s => s.loadModels)
  const saveModel = useLLMStore(s => s.saveModel)
  const deleteModel = useLLMStore(s => s.deleteModel)
  const setDefaultModel = useLLMStore(s => s.setDefaultModel)
  const setDefaultEmbeddingModel = useLLMStore(s => s.setDefaultEmbeddingModel)
  const [editingModel, setEditingModel] = useState<ModelProfile | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!loaded) loadModels()
  }, [loaded, loadModels])

  const filtered = models.filter((m) =>
    m.purposes?.some((p) => purposes.includes(p as ModelProfile['purposes'][number]))
  )
  const isEmbeddingSection = purposes.includes('embedding')
  const defaultId = isEmbeddingSection ? defaultEmbeddingModelId : defaultModelId

  /** 向量模型由工厂选择完整的 SiliconFlow 默认值。 */
  const add = () => {
    setEditingModel(createModelProfileDraft({
      id: randomUUID(),
      purposes: [...purposes],
    }))
  }

  const setDefault = (modelId: string) => isEmbeddingSection
    ? setDefaultEmbeddingModel(modelId)
    : setDefaultModel(modelId)

  const save = async () => {
    if (!editingModel) return
    setSaving(true)
    const saved = await saveModel(editingModel)
    if (!saved) {
      setSaving(false)
      return
    }
    if (filtered.length === 0 && !await setDefault(editingModel.id)) {
      setSaving(false)
      return
    }
    setEditingModel(null)
    setSaving(false)
  }

  return {
    models: filtered,
    defaultId,
    isEmbeddingSection,
    editingModel,
    setEditingModel,
    saving,
    add,
    edit: (model: ModelProfile) => setEditingModel({ ...model }),
    cancelEdit: () => setEditingModel(null),
    save,
    remove: (modelId: string) => deleteModel(modelId),
    setDefault,
  }
}
