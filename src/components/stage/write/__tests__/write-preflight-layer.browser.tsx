import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../../../../stores/locale-store'
import WritePreflight from '../WritePreflight'
import type { ConsistencyPreflightResult } from '../../../../services/consistency-preflight'
import type { PreflightRoute } from '../../../../shared/preflight-route'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined
let opened: PreflightRoute[]

const finding = (stableFactKey: string, sourceChapter = 3) => ({
  stableFactKey,
  severity: 'warning' as const,
  sourceChapter,
  evidence: `第${sourceChapter}章：「证据」`,
  issue: { zhCN: `问题（${stableFactKey}）`, enUS: `Issue (${stableFactKey})` },
  suggestion: { zhCN: '建议这样改。', enUS: 'Fix it like this.' },
})

const preflight: ConsistencyPreflightResult = {
  findings: [
    finding('cast:absent:全叔', 9),
    finding('chapter-time:anchor-unmet:45', 45),
    finding('prose:sentence-reuse:59:周叙看了两息', 59),
  ],
  exemptions: [],
  acknowledgements: [],
  castNames: [],
} as ConsistencyPreflightResult

async function mount(options: { withLayerButton?: boolean } = {}) {
  opened = []
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  document.body.append(host)
  root = createRoot(host)
  const common = {
    preflight, busy: false,
    onIgnoreOnce: vi.fn(), onRerun: vi.fn(), onSave: vi.fn(), onRevoke: vi.fn(),
    onAcknowledge: vi.fn(), onUnacknowledge: vi.fn(),
  }
  await act(async () => root!.render(
    options.withLayerButton === false
      ? <WritePreflight {...common} />
      : <WritePreflight {...common} onOpenLayer={route => opened.push(route)} />,
  ))
}

beforeEach(() => useLocaleStore.setState({ locale: 'zh-CN' }))
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

/**
 * issue #137：每条提醒要有「去该层改」的出口，而不是让作者自己判断去哪一层
 * （13 条提醒原来要跨 5 个页面手工找 13 次）。
 */
describe('写前预检的分层出口 (issue #137)', () => {
  it('offers a layer link per repairable finding, naming the layer', async () => {
    await mount()
    // 角色层与蓝图层可写 → 各自一个按钮，且写明去哪一层。
    await expect.element(page.getByRole('button', { name: '去角色名单改' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '去本章蓝图改' })).toBeVisible()
  })

  it('sends the author to the destination page of that finding’s layer', async () => {
    await mount()
    await act(async () => page.getByRole('button', { name: '去角色名单改' }).click())
    expect(opened).toEqual([{ layer: 'cast', destination: { kind: 'stage', stage: 'setup' }, repairable: true }])
    await act(async () => page.getByRole('button', { name: '去本章蓝图改' }).click())
    expect(opened.at(-1)).toEqual({ layer: 'blueprint', destination: { kind: 'stage', stage: 'blueprint' }, repairable: true })
  })

  it('explains why a prose finding cannot be fixed now, instead of offering a dead button', async () => {
    await mount()
    // 「prose:*」读的是已定稿正文，写前那一刻改不了（本章正文还不存在）。
    await expect.element(page.getByText('这条要改正文，本章写完后可回来处理')).toBeVisible()
    expect([...host!.querySelectorAll('button')].map(node => node.textContent)).not.toContain('去已定稿正文改')
  })

  it('omits the layer outlet entirely where it cannot answer “which chapter” (batch dialog)', async () => {
    // 批量写作（一次写多章）不传 onOpenLayer：那里的提醒可能属于任意一章。
    await mount({ withLayerButton: false })
    expect([...host!.querySelectorAll('button')].map(node => node.textContent).filter(t => t?.startsWith('去'))).toEqual([])
    // 其余两个出口不受影响（3 条提醒各一条）。
    await expect.element(page.getByRole('button', { name: '我已知，稍后处理' }).first()).toBeVisible()
  })
})