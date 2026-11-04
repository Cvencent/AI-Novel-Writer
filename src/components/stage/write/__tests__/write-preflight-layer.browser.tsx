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

async function mount(options: { withLayerButton?: boolean; currentChapter?: number } = {}) {
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
      : <WritePreflight {...common} onOpenLayer={route => opened.push(route)}
          {...(options.currentChapter === undefined ? {} : { currentChapter: options.currentChapter })} />,
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
    // ⚠️ 断言「给出了原因」而不是钉死整句文案：文案会随判据口径调整（旧章也是这一档）。
    await expect.element(page.getByText(/写前这一刻改不动|落在已定稿的章上|本章写完后/).first()).toBeVisible()
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
/**
 * issue #137 第二维：**旧章**的提醒与「要读正文」的提醒一样，写前改不动。
 *
 * 第一版只看「层」，把 39 条里 30 条标成可修，而它们的源章全部早于当前章——
 * 照那个标记做「一键修复」，改的是已定稿的旧章。
 */
describe('旧章的提醒不给可修按钮 (issue #137)', () => {
  it('marks a plan-layer finding whose chapter is already finalized as blocked', async () => {
    // 上面那个 fixture 里 `chapter-time:anchor-unmet:45` 的 sourceChapter = 45；
    // 当前章是 46 时它已是旧账 → 不能点「去本章蓝图改」。
    await mount({ currentChapter: 46 })
    expect([...host!.querySelectorAll('button')].map(node => node.textContent)).not.toContain('去本章蓝图改')
    await expect.element(page.getByText(/落在已定稿的章上/).first()).toBeVisible()
  })

  it('still offers the button for a finding that belongs to the upcoming chapter', async () => {
    // 当前章 = 45 时同一条提醒落在「即将写的这一章」上 → 可以改。
    await mount({ currentChapter: 45 })
    await expect.element(page.getByRole('button', { name: '去本章蓝图改' })).toBeVisible()
  })
})

/**
 * issue #137 第二层：**「修复」= 模型改写 + 作者确认差异**。
 *
 * 用户要求：改完先给差异，确认后才落库。所以按钮点下去只产生「建议」，不写任何东西。
 */
describe('修复出口与差异确认 (issue #137)', () => {
  const mountWithRepair = async (proposal: { layerLabel: string; chapterNumber: number | null; diffs: Array<{ field: string; before: string; after: string; reason: string }> }, source: ConsistencyPreflightResult = preflight) => {
    const applied: string[] = []
    let dismissed = false
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    document.body.append(host)
    root = createRoot(host)
    const common = {
      preflight: source, busy: false,
      onIgnoreOnce: vi.fn(), onRerun: vi.fn(), onSave: vi.fn(), onRevoke: vi.fn(),
      onAcknowledge: vi.fn(), onUnacknowledge: vi.fn(),
      onOpenLayer: vi.fn(), currentChapter: 45,
      onRepair: vi.fn(), onRepairAll: vi.fn(),
      repairProposal: proposal,
      onApplyRepairField: (field: string) => applied.push(field),
      onApplyRepairAll: () => applied.push('ALL'),
      onDismissRepair: () => { dismissed = true },
    }
    await act(async () => root!.render(<WritePreflight {...common} />))
    return { applied, dismissedNow: () => dismissed }
  }

  it('offers a 修复 button only for the layers that have a field-level write channel', async () => {
    // ⚠️ 这一条要能证明**层闸门**存在：共享 fixture 里 cast 那条是旧章（会被第二维挡住），
    // 所以这里单独构造一条「可修的角色层提醒」——角色层仍然不该出现「修复」按钮
    // （它的写通道要完整 CAS 载荷，薄服务半实现会写错账本）。
    // 上面 fixture：cast（全叔）、blueprint（anchor-unmet:45）、prose（sentence-reuse）。
    await mountWithRepair({ layerLabel: '本章蓝图', chapterNumber: 45, diffs: [] })
    const labels = [...host!.querySelectorAll('button')].map(node => node.textContent)
    // 蓝图层给「修复」；cast 层（角色名单的 CAS 提交）与 prose 层（只能重定稿）不给。
    expect(labels.filter(label => label === '修复')).toHaveLength(1)

    // 同一条断言换成「可修的角色层提醒」：仍然不给「修复」——那一层要走自己的 CAS 提交。
    await act(async () => root?.unmount())
    host?.remove()
    root = undefined
    await mountWithRepair({ layerLabel: '角色名单', chapterNumber: 45, diffs: [] }, {
      ...preflight,
      findings: [finding('cast:absent:全叔', 45)],
    })
    const castLabels = [...host!.querySelectorAll('button')].map(node => node.textContent)
    expect(castLabels.filter(label => label === '修复')).toHaveLength(0)
    // 但「去角色名单改」照给（那是它正确的出口）。
    expect(castLabels).toContain('去角色名单改')
    await expect.element(page.getByRole('button', { name: '全部修复' })).toBeVisible()
  })

  it('shows before/after per field and writes nothing until the author picks', async () => {
    const { applied } = await mountWithRepair({
      layerLabel: '本章蓝图', chapterNumber: 45,
      diffs: [{ field: 'keyEvents', before: '他把回执摊在桌上。', after: '次日清晨，他把回执摊在桌上。', reason: '补了日界' }],
    })
    // 精确匹配：after 里也含 before 的字面，非精确匹配会命中两个元素。
    await expect.element(page.getByText('他把回执摊在桌上。', { exact: true })).toBeVisible()
    await expect.element(page.getByText('次日清晨，他把回执摊在桌上。', { exact: true })).toBeVisible()
    // 默认一处都没勾：不勾就点不动「采纳」。
    const applyButton = page.getByRole('button', { name: /采纳勾选的/ })
    await expect.element(applyButton).toBeDisabled()
    expect(applied).toEqual([])
  })

  it('applies exactly the field the author picked', async () => {
    const { applied } = await mountWithRepair({
      layerLabel: '本章蓝图', chapterNumber: 45,
      diffs: [{ field: 'keyEvents', before: '旧', after: '新', reason: '' }],
    })
    await act(async () => page.getByRole('button', { name: '只采纳这一处' }).click())
    expect(applied).toEqual(['keyEvents'])
  })

  it('lets the author keep everything as is', async () => {
    const { dismissedNow } = await mountWithRepair({
      layerLabel: '本章蓝图', chapterNumber: 45,
      diffs: [{ field: 'title', before: '旧', after: '新', reason: '' }],
    })
    await act(async () => page.getByRole('button', { name: '都不改' }).click())
    expect(dismissedNow()).toBe(true)
  })
})
