import { useEffect } from 'react'
import { create } from 'zustand'
import { useAppearanceStore } from '../../stores/appearance-bootstrap'
import { useLayoutStore } from '../../stores/layout-store'

/** 设置页里还没保存的输入：各页用 useUnsavedSettings 登记，离开设置页或换页前由 leaveSettings 统一确认。 */
const unsaved = new Set<symbol>()
/** 显示放弃确认的新外壳设置页挂着几个。旧外壳的设置弹窗也会登记脏输入，但没有确认框，这时离开照旧执行。 */
let hosts = 0

export function useUnsavedSettings(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const token = Symbol('unsaved-settings')
    unsaved.add(token)
    return () => { unsaved.delete(token) }
  }, [dirty])
}

/** 等作者确认放弃修改的离开动作；为空时没有确认框。 */
export const useSettingsLeave = create<{ pending: (() => void) | null }>(() => ({ pending: null }))

export function useSettingsLeaveHost(): void {
  useEffect(() => {
    hosts += 1
    return () => {
      hosts -= 1
      useSettingsLeave.setState({ pending: null })
    }
  }, [])
}

export function leaveSettings(action: () => void): void {
  if (unsaved.size === 0 || hosts === 0) action()
  else useSettingsLeave.setState({ pending: action })
}

/**
 * 会让新外壳设置页收起的导航（去别的阶段、回到书房、打开或新建作品）：有没保存的输入时先确认，取消就不走；
 * 确认后先收起设置页再执行，之后的自动落点（打开作品后落到哪一步）不会再问一次。
 * 旧外壳照原样直接执行：它的设置弹窗没有放弃确认，也不该被这些导航关掉。
 */
export function leaveSettingsThen(action: () => void): void {
  if (useAppearanceStore.getState().resolvedShell !== 'stage') {
    action()
    return
  }
  leaveSettings(() => {
    useLayoutStore.getState().closeSettings()
    action()
  })
}
