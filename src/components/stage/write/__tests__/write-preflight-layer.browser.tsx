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

/**
 * issue #137 跨层排队：告诉作者「这一层不是最后一批」。
 *
 * 缺口：`planRepairCalls` 会把可修提醒按层排好，但界面只取第一批——「全部修复」
 * 实际只修一层，而按钮写的是「全部」。现在每层仍由作者逐次确认，但界面上说清还剩几层。
 */
describe('跨层修复的剩余层提示 (issue #137)', () => {
  const mountWithRemaining = async (remainingLayers: number | undefined) => {
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    document.body.append(host)
    root = createRoot(host)
    const common = {
      preflight, busy: false,
      onIgnoreOnce: vi.fn(), onRerun: vi.fn(), onSave: vi.fn(), onRevoke: vi.fn(),
      onAcknowledge: vi.fn(), onUnacknowledge: vi.fn(),
      onOpenLayer: vi.fn(), currentChapter: 45,
      onRepair: vi.fn(), onRepairAll: vi.fn(),
      repairProposal: {
        layerLabel: '本章蓝图', chapterNumber: 45,
        diffs: [{ field: 'keyEvents', before: '旧', after: '新', reason: '' }],
        ...(remainingLayers === undefined ? {} : { remainingLayers }),
      },
      onApplyRepairField: vi.fn(), onApplyRepairAll: vi.fn(), onDismissRepair: vi.fn(),
    }
    await act(async () => root!.render(<WritePreflight {...common} />))
  }

  it('says how many layers are still queued', async () => {
    await mountWithRemaining(2)
    await expect.element(page.getByText(/另外 2 层/)).toBeVisible()
  })

  it('says nothing extra when this is the last layer', async () => {
    await mountWithRemaining(0)
    expect(host!.textContent).not.toContain('还会继续提出')
  })

  it('stays silent when the caller does not track a queue at all', async () => {
    await mountWithRemaining(undefined)
    expect(host!.textContent).not.toContain('还会继续提出')
  })
})

/**
 * issue #154：预检弹层里判据文案的 Markdown 粗体必须被剥掉。
 *
 * 实测 57%~81% 的提醒带 `**`，作者看到的是满屏星号——它会让人以为界面坏了
 * （`**` 像是没渲染的模板），而且越强调越糟。
 */
describe('预检正文剥离 Markdown 粗体 (issue #154)', () => {
  it('renders the emphasis as plain text', async () => {
    const emphasised = {
      ...preflight,
      findings: [{
        stableFactKey: 'prose-flavor:motif:9',
        severity: 'warning' as const,
        sourceChapter: 9,
        evidence: '第9章「盐包」出现 7 次',
        issue: { zhCN: '同一条**骨架**重复。', enUS: 'The same **shape** repeats.' },
        suggestion: { zhCN: '换**措辞**。', enUS: 'Change the **wording**.' },
      }],
    } as ConsistencyPreflightResult
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(
      <WritePreflight
        preflight={emphasised} busy={false}
        onIgnoreOnce={vi.fn()} onRerun={vi.fn()} onSave={vi.fn()} onRevoke={vi.fn()}
        onAcknowledge={vi.fn()} onUnacknowledge={vi.fn()}
      />,
    ))
    expect(host!.textContent).not.toContain('**')
    // 文字内容还在（不是把整句删掉了）。
    expect(host!.textContent).toContain('同一条骨架重复')
    expect(host!.textContent).toContain('换措辞')
  })
})

/**
 * issue #165：底部动作行**不许把按钮甩出弹层**。
 *
 * 现场（1.5.175）：四个「核对…」按钮全部渲染到 `.pi-popover` 左边界之外，
 * 鼠标落点被下层 `.arch-arc-review-panel` 接管——功能实现了（`element.click()`
 * 能跑、7 秒后出提示），但作者**一个都点不到**。
 *
 * 几何原因：动作行容器 288px，七个按钮合计 658px，`justify-content:flex-end`
 * 在溢出时把左侧甩出去，而外层 `.stage-shell` 是 `overflow:hidden`，横向滚不到。
 *
 * ⚠️ 断言用**逐个按钮的左边界 vs 弹层左边界**（issue 建议 4）：
 * `scrollWidth <= clientWidth` 抓不出来——溢出被上层裁掉后量的是裁后值（288/288）。
 */
describe('动作行不许把按钮甩出弹层 (issue #165)', () => {
  const mountWithAllActions = async () => {
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    // 模拟真实弹层：固定 360 宽、overflow visible 的内层，外层 overflow hidden。
    host.style.cssText = 'width:360px;overflow:hidden;position:relative'
    document.body.append(host)
    root = createRoot(host)
    const common = {
      preflight, busy: false,
      onIgnoreOnce: vi.fn(), onRerun: vi.fn(), onSave: vi.fn(), onRevoke: vi.fn(),
      onAcknowledge: vi.fn(), onUnacknowledge: vi.fn(),
      onOpenLayer: vi.fn(), currentChapter: 45,
      onRepair: vi.fn(), onRepairAll: vi.fn(),
      onCheckAppearance: vi.fn(), onCheckSensory: vi.fn(),
      onCheckStyle: vi.fn(), onCheckContent: vi.fn(), onCheckAbility: vi.fn(),
      onCheckBlueprintFacts: vi.fn(),
    }
    await act(async () => root!.render(<WritePreflight {...common} />))
  }

  it('keeps every action button inside the popover’s left and right edges', async () => {
    await mountWithAllActions()
    const shell = host!.getBoundingClientRect()
    const buttons = [...host!.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(6)
    for (const button of buttons) {
      const rect = button.getBoundingClientRect()
      // 左边界：不许跑到弹层外面（这正是 1.5.175 的缺陷）。
      expect(rect.left, `${button.textContent} 左边越界`).toBeGreaterThanOrEqual(shell.left - 0.5)
      expect(rect.right, `${button.textContent} 右边越界`).toBeLessThanOrEqual(shell.right + 0.5)
    }
  })

  it('puts the slow model-check buttons on their own row, not mixed with instant actions', async () => {
    // 「核对…」是一次 60 秒级模型调用；和「带提醒继续写」这种即时动作挤一行是这次
    // 溢出的直接原因，所以结构性上也要求分开（issue #165 建议 2）。
    await mountWithAllActions()
    expect(host!.querySelector('.stage-preflight-checks')?.textContent).toContain('核对能力限制')
    expect(host!.querySelector('.stage-preflight-actions')?.textContent).not.toContain('核对能力限制')
    // issue #157 的第七个「核对…」也必须在那一行里（新按钮不许挪到即时动作行）。
    expect(host!.querySelector('.stage-preflight-checks')?.textContent).toContain('核对蓝图与前文')
  })
})

/**
 * issue #160：提醒**自己说要建卡**的时候，界面上就得能点。
 *
 * 现场：文案写着「就在角色名单里为「徐汐」建卡」，弹层里 `建卡` 两个字一次都点不到，
 * 于是那条提醒从第 64 章重报到第 70 章。这条测试钉住三件事：
 *   1. 带 `action.create-character` 的提醒渲染出这个按钮，并把名字带给调用方；
 *   2. 不带动作的提醒**不**渲染它（绝大多数提醒不该多出一个按钮）；
 *   3. 批量写作（不传 `onCreateCharacter`）不渲染它——那里作者还没进那一章的上下文。
 */
describe('未建档角色的一键建卡出口 (issue #160)', () => {
  const castFinding = {
    stableFactKey: 'blueprint-cast:unregistered:徐汐',
    severity: 'warning' as const,
    sourceChapter: 70,
    evidence: '「徐汐」进了第64–70章的蓝图出场名单、正文 9 段台词，角色卡名册里没有这个人',
    issue: { zhCN: '徐汐持续出场但没有角色卡。', enUS: '徐汐 appears but has no card.' },
    suggestion: { zhCN: '点「为「徐汐」建卡」。', enUS: 'Use “Create a card for 徐汐”.' },
    action: { kind: 'create-character' as const, name: '徐汐' },
  }

  const mountWithAction = async (options: { withHandler?: boolean; findings?: unknown[] } = {}) => {
    const created: string[] = []
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    host.style.cssText = 'width:360px;overflow:hidden;position:relative'
    document.body.append(host)
    root = createRoot(host)
    const common = {
      preflight: { ...preflight, findings: (options.findings ?? [castFinding]) as never },
      busy: false,
      onIgnoreOnce: vi.fn(), onRerun: vi.fn(), onSave: vi.fn(), onRevoke: vi.fn(),
      onAcknowledge: vi.fn(), onUnacknowledge: vi.fn(),
      onOpenLayer: vi.fn(), currentChapter: 75,
    }
    const extra = options.withHandler === false ? {} : { onCreateCharacter: (name: string) => created.push(name) }
    await act(async () => root!.render(<WritePreflight {...common} {...extra} />))
    return created
  }

  it('renders the create-card button and hands the name to the caller', async () => {
    const created = await mountWithAction()
    await expect.element(page.getByRole('button', { name: '为「徐汐」建卡' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '为「徐汐」建卡' }).click())
    expect(created).toEqual(['徐汐'])
  })

  it('does not render it for findings that carry no action', async () => {
    await mountWithAction({ findings: [finding('cast:absent:全叔', 9)] })
    expect([...host!.querySelectorAll('button')].map(node => node.textContent).filter(t => t?.includes('建卡'))).toEqual([])
  })

  it('stays hidden in the batch dialog (no handler): there is no single chapter context', async () => {
    await mountWithAction({ withHandler: false })
    expect([...host!.querySelectorAll('button')].map(node => node.textContent).filter(t => t?.includes('建卡'))).toEqual([])
    // 「我已知」仍在，作者不是没有出口。
    await expect.element(page.getByRole('button', { name: '我已知，稍后处理' }).first()).toBeVisible()
  })

  it('keeps the new button inside the popover edges (issue #165 不会因此复发)', async () => {
    await mountWithAction()
    const shell = host!.getBoundingClientRect()
    for (const button of [...host!.querySelectorAll('button')]) {
      const rect = button.getBoundingClientRect()
      expect(rect.left, `${button.textContent} 左边越界`).toBeGreaterThanOrEqual(shell.left - 0.5)
      expect(rect.right, `${button.textContent} 右边越界`).toBeLessThanOrEqual(shell.right + 0.5)
    }
  })
})
