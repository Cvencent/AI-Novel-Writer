import { useEffect } from 'react'
import { create } from 'zustand'

/** 设置页里还没保存的输入：各页用 useUnsavedSettings 登记，离开设置页或换页前由 leaveSettings 统一确认。 */
const unsaved = new Set<symbol>()

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

export function leaveSettings(action: () => void): void {
  if (unsaved.size === 0) action()
  else useSettingsLeave.setState({ pending: action })
}
