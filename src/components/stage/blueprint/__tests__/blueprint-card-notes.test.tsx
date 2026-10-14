import { afterAll, describe, expect, it } from 'vitest'

const previousTimeZone = process.env.TZ
process.env.TZ = 'Asia/Shanghai'

import { renderToStaticMarkup } from 'react-dom/server'
import { useLocaleStore } from '../../../../stores/locale-store'
import BlueprintCard from '../BlueprintCard'

const originalLocale = useLocaleStore.getState()
afterAll(() => {
  useLocaleStore.setState(originalLocale)
  if (previousTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = previousTimeZone
})

const ignore = () => undefined

describe('蓝图卡的章节要点日期（固定在东八区）', () => {
  it('数据库记的 UTC 2026-10-13 23:30 在东八区是 10 月 14 日', () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    const html = renderToStaticMarkup(
      <BlueprintCard
        blueprint={{ chapterNumber: 3, title: '雾钟', role: '发展', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '',
          notes: '林岚发现钟声提前一刻。', notesUpdatedAt: '2026-10-13 23:30:00' }}
        row={undefined}
        saving={false}
        onField={ignore}
        onSave={ignore}
        onDelete={ignore}
      />,
    )
    expect(html).toContain('定稿后自动生成 · 2026/10/14')
  })
})
