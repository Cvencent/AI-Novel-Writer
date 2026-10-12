import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { guardArchitectureGeneration, guardCharacterRegeneration } from '../../services/workflow-guards'
import { createDefaultArchitectureSelection, type ArchStepKey } from '../../services/architecture-step-selection'
import { toast } from '../ui/Toast'
import { useLocaleStore } from '../../stores/locale-store'
import { ipc } from '../../services/ipc-client'
import { assertPlanningActionRange, DEFAULT_PLANNING_ACTION_CHAPTERS, DEFAULT_PLANNING_TARGET_UNITS, parsePlanningTargetUnits, PLANNING_ACTION_CHAPTER_LIMIT, PLANNING_TARGET_UNITS_LIMIT } from '../../shared/plot-outline-contract'

export const ARCH_STEP_LABELS: Record<ArchStepKey, [string, string]> = {
  premise: ['故事前提', 'Premise'],
  characters: ['角色图谱', 'Characters'],
  worldbuilding: ['世界观', 'World building'],
  synopsis: ['情节大纲', 'Synopsis'],
}

/**
 * 每节在本次生成里的结果：已有内容且勾选为覆盖，未勾选为保留，还没有内容为新生成。
 * 已有大纲时从第 2 章以后起生成是分批续写，起始章之前的章保留，标为续写。
 */
export type ArchStepMark = 'overwrite' | 'keep' | 'new' | 'continue'

export interface ArchitectureConfirmFormOptions {
  isOpen: boolean
  onClose: () => void
  archStatus: Record<string, boolean>
  initialSelectedSteps?: ArchStepKey[]
  initialSynopsisRange?: { from: number; to: number } | null
  onConfirm: (
    selectedSteps: ArchStepKey[],
    stepGuidance: Record<string, string>,
    synopsisRange?: { from: number; to: number },
    targetUnits?: number,
  ) => Promise<void>
}

/** 架构确认对话框的表单：步骤勾选、大纲范围、每章目标字数、作者指导与提交前校验。新旧两种外壳的对话框共用。 */
export function useArchitectureConfirmForm({
  isOpen, onClose, archStatus, initialSelectedSteps, initialSynopsisRange = null, onConfirm,
}: ArchitectureConfirmFormOptions) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)

  // 默认：未生成的全部勾选；或使用 initialSelectedSteps 覆盖
  const [checked, setChecked] = useState<Record<ArchStepKey, boolean>>(() => {
    return createDefaultArchitectureSelection(archStatus, initialSelectedSteps)
  })
  const wasOpen = useRef(false)

  const [stepGuidance, setStepGuidance] = useState<Record<string, string>>({})
  const [showGuidance, setShowGuidance] = useState(false)
  const [synopsisFrom, setSynopsisFrom] = useState('')
  const [synopsisTo, setSynopsisTo] = useState('')
  const [targetUnits, setTargetUnits] = useState(String(DEFAULT_PLANNING_TARGET_UNITS))
  const [preferenceLoading, setPreferenceLoading] = useState(true)
  const [isConfirming, setIsConfirming] = useState(false)
  const [guardError, setGuardError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let disposed = false
    void ipc.invoke('config:get').then(config => {
      if (!disposed) setTargetUnits(String(parsePlanningTargetUnits(config.outlineTargetUnits)))
    }).catch(error => {
      if (!disposed) setGuardError(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (!disposed) setPreferenceLoading(false) })
    return () => { disposed = true; setPreferenceLoading(true) }
  }, [isOpen])

  // 每次弹窗打开时重置选中状态；续批入口会预填起止章并勾选情节大纲
  const resetChecked = useCallback(() => {
    const defaults = createDefaultArchitectureSelection(archStatus, initialSelectedSteps)
    if (initialSynopsisRange) {
      defaults.synopsis = true
      setSynopsisFrom(String(initialSynopsisRange.from))
      setSynopsisTo(String(Math.min(initialSynopsisRange.to, initialSynopsisRange.from + PLANNING_ACTION_CHAPTER_LIMIT - 1)))
    } else {
      const total = Number(currentProject?.novelConfig.totalChapters) || 0
      setSynopsisFrom('1')
      setSynopsisTo(String(Math.min(total, DEFAULT_PLANNING_ACTION_CHAPTERS)))
    }
    setChecked(defaults)
  }, [archStatus, currentProject?.novelConfig.totalChapters, initialSelectedSteps, initialSynopsisRange])

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      resetChecked()
    }
    wasOpen.current = isOpen
  }, [isOpen, resetChecked])

  const toggleStep = (key: ArchStepKey) =>
    setChecked(prev => ({ ...prev, [key]: !prev[key] }))
  const selectAll = () => setChecked({ premise: true, characters: true, worldbuilding: true, synopsis: true })

  const selectedSteps = (Object.keys(checked) as ArchStepKey[]).filter(k => checked[k])
  const noneSelected = selectedSteps.length === 0
  const stepMark = (key: ArchStepKey): ArchStepMark => {
    if (!archStatus[key]) return 'new'
    if (!checked[key]) return 'keep'
    return key === 'synopsis' && Number(synopsisFrom) > 1 ? 'continue' : 'overwrite'
  }

  const config = currentProject?.novelConfig
  const totalChapters = Number(config?.totalChapters) > 0 ? Number(config?.totalChapters) : 0
  const resolveSynopsisRange = (): { ok: true; range?: { from: number; to: number } } | { ok: false } => {
    if (!checked.synopsis) return { ok: true }
    const range = { from: Number(synopsisFrom), to: Number(synopsisTo) }
    try { assertPlanningActionRange(range) } catch { return { ok: false } }
    return range.to <= totalChapters ? { ok: true, range } : { ok: false }
  }

  const handleConfirm = async () => {
    if (noneSelected) return
    setIsConfirming(true)
    try {
      // 前置校验 1：小说配置是否填写
      const configGuard = guardArchitectureGeneration()
      if (!configGuard.ok) {
        setGuardError(configGuard.message || text('配置校验失败', 'Configuration validation failed.'))
        return
      }

      // 范围合法性（超出总章数或起大于止）
      const resolution = resolveSynopsisRange()
      if (!resolution.ok) {
        setGuardError(text(
          `情节大纲范围无效。请选择第 1–${totalChapters} 章内连续的 1–${PLANNING_ACTION_CHAPTER_LIMIT} 章。`,
          `Invalid plot-outline range. Select 1-${PLANNING_ACTION_CHAPTER_LIMIT} consecutive chapters within chapters 1-${totalChapters}.`,
        ))
        return
      }

      // 前置校验 2：如果勾选了角色图谱（意味着将重新生成角色卡），则必须确保蓝图为空
      if (selectedSteps.includes('characters') && archStatus.characters) {
        const charGuard = await guardCharacterRegeneration(undefined, locale)
        if (!charGuard.ok) {
          setGuardError(charGuard.message || text('角色卡不可重新生成', 'Character cards cannot be regenerated.'))
          return
        }
      }

      setGuardError(null)
      let target: number | undefined
      if (checked.synopsis) {
        try { target = parsePlanningTargetUnits(Number(targetUnits)) } catch {
          setGuardError(text(`每章大纲目标须为 1–${PLANNING_TARGET_UNITS_LIMIT} 的整数。`, `The outline target must be an integer from 1 to ${PLANNING_TARGET_UNITS_LIMIT}.`))
          return
        }
        try {
          const saved = await ipc.invoke('config:set', { outlineTargetUnits: target })
          if (!saved.success) throw new Error(saved.error)
        } catch {
          setGuardError(text('目标字数偏好保存失败。请重试，输入已保留。', 'Could not save the target preference. Your input is retained. Please retry.'))
          return
        }
      }
      await onConfirm(selectedSteps, stepGuidance, resolution.range, target)
      onClose()
      const stepNames = selectedSteps.map(k => text(...ARCH_STEP_LABELS[k])).join(text('、', ', '))
      toast.info(text(`已提交：正在生成${stepNames}...`, `Submitted: generating ${stepNames}...`))
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsConfirming(false)
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose()
    } else {
      resetChecked()
    }
  }

  return {
    config,
    checked,
    toggleStep,
    selectAll,
    selectedSteps,
    noneSelected,
    stepMark,
    stepGuidance,
    setStepGuidance: (key: ArchStepKey, value: string) => setStepGuidance(prev => ({ ...prev, [key]: value })),
    showGuidance,
    setShowGuidance,
    synopsisFrom,
    setSynopsisFrom,
    synopsisTo,
    setSynopsisTo,
    targetUnits,
    setTargetUnits,
    preferenceLoading,
    isConfirming,
    guardError,
    totalChapters,
    handleConfirm,
    handleOpenChange,
  }
}
