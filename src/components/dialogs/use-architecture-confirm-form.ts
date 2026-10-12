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
 * 情节大纲紧接已有章节起生成是分批续写，标为续写；后台会拒绝的范围标为无效。
 */
export type ArchStepMark = 'overwrite' | 'keep' | 'new' | 'continue' | 'invalid'

/** 已有大纲的分批进度：已确认到第 coveredTo 章（0 为没有分批进度），interrupted 为有一批被输出长度打断、待断点续写。 */
export interface SynopsisProgress {
  coveredTo: number
  interrupted: boolean
}

export interface ArchitectureConfirmFormOptions {
  isOpen: boolean
  onClose: () => void
  archStatus: Record<string, boolean>
  initialSelectedSteps?: ArchStepKey[]
  initialSynopsisRange?: { from: number; to: number } | null
  /** 不知道进度的入口（单节文档里的生成）不传，此时只能从第 1 章起生成。 */
  synopsisProgress?: SynopsisProgress
  onConfirm: (
    selectedSteps: ArchStepKey[],
    stepGuidance: Record<string, string>,
    synopsisRange?: { from: number; to: number },
    targetUnits?: number,
  ) => Promise<void>
}

/** 架构确认对话框的表单：步骤勾选、大纲范围、每章目标字数、作者指导与提交前校验。新旧两种外壳的对话框共用。 */
export function useArchitectureConfirmForm({
  isOpen, onClose, archStatus, initialSelectedSteps, initialSynopsisRange = null, synopsisProgress, onConfirm,
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

  // 每次弹窗打开时重置选中状态；续批入口只勾情节大纲并预填起止章：同批再生成别的节会改变大纲的源事实，续批会被后台拒绝
  const resetChecked = useCallback(() => {
    const defaults = initialSynopsisRange
      ? { premise: false, characters: false, worldbuilding: false, synopsis: true }
      : createDefaultArchitectureSelection(archStatus, initialSelectedSteps)
    if (initialSynopsisRange) {
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
  const setAll = (value: boolean) => setChecked({ premise: value, characters: value, worldbuilding: value, synopsis: value })

  const selectedSteps = (Object.keys(checked) as ArchStepKey[]).filter(k => checked[k])
  const noneSelected = selectedSteps.length === 0
  const config = currentProject?.novelConfig
  const totalChapters = Number(config?.totalChapters) > 0 ? Number(config?.totalChapters) : 0
  const from = Number(synopsisFrom)
  const to = Number(synopsisTo)

  /**
   * 与 architecture.command 的大纲范围规则一致，在对话框里就拦下后台会拒绝的范围：
   * 第 1 章起是覆盖重写，但不能只写到已确认章节的中间；第 1 章以后只能紧接已确认的最后一章续写，且没有待断点续写的批次。
   */
  const rangeIssue = (): string | null => {
    if (!checked.synopsis || !synopsisFrom.trim() || !synopsisTo.trim() || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) return null
    const coveredTo = synopsisProgress?.coveredTo ?? 0
    if (from === 1) {
      return !synopsisProgress?.interrupted && coveredTo > to
        ? text(`本批只写到第 ${to} 章，会丢掉已有的第 ${to + 1}–${coveredTo} 章大纲。请至少写到第 ${coveredTo} 章，或从第 ${coveredTo + 1} 章续写。`,
          `This batch stops at chapter ${to} and would drop the existing outline for chapters ${to + 1}–${coveredTo}. Go to chapter ${coveredTo} or later, or continue from chapter ${coveredTo + 1}.`)
        : null
    }
    if (!synopsisProgress) return text('这里只能从第 1 章起生成大纲。要接着已有大纲往后写，请用架构页情节大纲一节的续写。', 'Here the outline can only start at chapter 1. To extend an existing outline, use Continue in the outline section of the architecture page.')
    if (synopsisProgress.interrupted) return text('上一批大纲停在半途，请先在情节大纲一节断点续写，再生成下一批。', 'The previous outline batch stopped partway. Resume it in the outline section before starting the next batch.')
    if (coveredTo <= 0) return text('还没有分批生成的大纲，请从第 1 章起生成。', 'There is no batched outline yet. Start at chapter 1.')
    if (from !== coveredTo + 1) return text(`已有大纲写到第 ${coveredTo} 章：请从第 ${coveredTo + 1} 章续写，或从第 1 章起覆盖重写。`, `The outline reaches chapter ${coveredTo}. Continue from chapter ${coveredTo + 1}, or rewrite from chapter 1.`)
    return null
  }
  const synopsisRangeIssue = rangeIssue()

  const stepMark = (key: ArchStepKey): ArchStepMark => {
    if (!checked[key]) return archStatus[key] ? 'keep' : 'new'
    if (key === 'synopsis' && synopsisRangeIssue) return 'invalid'
    if (!archStatus[key]) return 'new'
    return key === 'synopsis' && from > 1 ? 'continue' : 'overwrite'
  }

  const resolveSynopsisRange = (): { ok: true; range?: { from: number; to: number } } | { ok: false; message?: string } => {
    if (!checked.synopsis) return { ok: true }
    if (synopsisRangeIssue) return { ok: false, message: synopsisRangeIssue }
    const range = { from, to }
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
        setGuardError(resolution.message ?? text(
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
    setAll,
    selectedSteps,
    noneSelected,
    stepMark,
    synopsisRangeIssue,
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
