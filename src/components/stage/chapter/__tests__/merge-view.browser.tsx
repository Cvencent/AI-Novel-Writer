import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../../../../stores/locale-store'
import MergeView from '../MergeView'
import { ORIGINAL, REVISED } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined
let completed: string[]

const data = { originalContent: ORIGINAL, modifiedContent: REVISED, revisionPath: 'ai-novel://revision/9', targetSnapshot: { content: ORIGINAL, contentRevision: 0 }, staleReason: null }

async function mount(onLater = vi.fn()) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(
    <MergeView data={data} versionLabel="草稿 v1" recheck onComplete={async text => { completed.push(text); return true }} onLater={onLater} />,
  ))
}

const click = (name: string) => act(async () => page.getByRole('button', { name, exact: true }).click())
const choose = (paragraph: number, option: '用原稿' | '用修稿' | '手动编辑') =>
  act(async () => page.getByRole('group', { name: `第 ${paragraph} 段用哪一版` }).getByRole('button', { name: option }).click())

beforeEach(() => {
  completed = []
  useLocaleStore.setState({ locale: 'zh-CN' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('修稿合并视图', () => {
  it('只列出改动的段落，未改动的段落一行带过', async () => {
    await mount()
    expect([...host!.querySelectorAll('.stage-ch-hunk b, .stage-ch-same')].map(node => node.textContent))
      .toEqual(['第 1 段未改动', '第 2 段', '第 3 段未改动', '第 4 段'])
  })

  it('逐段选择：合并结果与每段的选择逐字一致', async () => {
    await mount()
    await choose(2, '用修稿')
    await choose(4, '手动编辑')
    await act(async () => page.getByRole('textbox', { name: '第 4 段的合并文字' }).fill('他想起旧报纸上那则很短的消息。'))
    await expect.element(page.getByText('2 处改动：已选 1 处用修稿，1 处手动编辑')).toBeVisible()
    await click('完成合并')
    expect(completed).toEqual([[
      '雨从傍晚开始就没有停过。',
      '最后一班列车晚点了十七分钟，广播里的道歉一遍遍落进空站台。',
      '他第三次展开信纸。',
      '他想起旧报纸上那则很短的消息。',
    ].join('\n\n')])
  })

  it('全部用修稿得到修稿全文，全部用原稿回到原稿全文；手动改过的段落也被覆盖', async () => {
    await mount()
    await choose(4, '手动编辑')
    await act(async () => page.getByRole('textbox', { name: '第 4 段的合并文字' }).fill('临时改写'))
    await click('全部用修稿')
    await click('完成合并')
    await click('全部用原稿')
    await click('完成合并')
    expect(completed).toEqual([REVISED, ORIGINAL])
  })

  it('稍后再合并只收起视图，不提交', async () => {
    const onLater = vi.fn()
    await mount(onLater)
    await click('稍后再合并')
    expect([onLater.mock.calls.length, completed]).toEqual([1, []])
  })
})
