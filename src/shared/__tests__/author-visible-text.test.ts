import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { acknowledgementTitleOf } from '../acknowledgement-title'
import { stripEmphasis } from '../author-visible-text'

/**
 * issue #154：判据文案里的 Markdown 粗体在界面上被**原样显示**。
 *
 * 实测（两本语料 `auditFinalizedProse` 只读）：52–53 条提醒里 `issue.zhCN` 含 `**` 的
 * 29 条（57%）、`suggestion.zhCN` 的 40 条（77%），涉及 19 个判据族；
 * 四条作者可见路径（预检弹层 / ack 标题 / 编辑台质检 / 修复提示）全都原样输出。
 */
describe('stripEmphasis (issue #154)', () => {
  it('removes paired bold markers', () => {
    expect(stripEmphasis('最近 10 章里有 **4 章（40%）** 的**最后一句话**是同一个骨架'))
      .toBe('最近 10 章里有 4 章（40%） 的最后一句话是同一个骨架')
  })

  it('removes a lone marker so a half-finished bold never reaches the author', () => {
    // 截断点可能落在一对 `**` 中间——半截标记在界面上同样是噪音。
    expect(stripEmphasis('卡上写的是**右小指')).toBe('卡上写的是右小指')
    expect(stripEmphasis('单个 * 星号')).toBe('单个 星号')
  })

  it('keeps Chinese punctuation and brackets untouched', () => {
    // 这些文案里大量「」、方括号与插值——不得误伤（所以没引整库 Markdown）。
    const text = '蓝图【时点：次日清晨】写着「回执摊在桌上」'
    expect(stripEmphasis(text)).toBe(text)
  })

  it('collapses the double space a stripped marker can leave behind', () => {
    expect(stripEmphasis('章里有 **4 章** 是同一骨架')).toBe('章里有 4 章 是同一骨架')
  })
})

describe('author-visible exports never carry ** (issue #154)', () => {
  it('the ack title is plain text', () => {
    // 「已标记稍后处理」是纯文本一行标题——一行里两对星号就完全读不出这是什么。
    const title = acknowledgementTitleOf('prose-flavor:motif:9', {
      issue: { zhCN: '同一个词在本章被**反复**用来承担情绪。', enUS: 'One **word** carries it.' },
    })
    expect(title.zhCN).not.toContain('*')
    expect(title.enUS).not.toContain('*')
  })

  it('a freshly added detector’s output is clean too', () => {
    // #153 刚上线的身体标志判据也带粗体——新代码在继续加，所以这条要一起钉。
    const text = '角色卡写的是**右小指**（缺）'
    expect(stripEmphasis(text)).not.toContain('**')
  })
})

/**
 * issue #158：**「单入口」必须真的被用上**。
 *
 * #154 的说明里写着「只要都走这一个入口，就不会再出现某条路径忘了剥」，但落地时
 * 用的是单函数 `stripEmphasis`、三处各调一次，`toAuthorVisibleText` **0 个调用点**
 * （已在本轮删除）——于是「防止下一个出口忘记」的那层保护根本没接上，
 * 而 `ReviewSheet` 的证据行就真的被漏了（`quote` 原样带 `**`）。
 *
 * 这条守卫钉的是**落库口径 vs 渲染口径的分界**：凡是把判据文案写进落库报告的地方，
 * 必须原样保留；凡是把判据文案渲染给作者的地方，必须剥。两侧各自扫一遍，漏一边会红。
 */
describe('剥离必须在渲染侧、落库侧必须原样 (issue #158/#159)', () => {
  const src = join(__dirname, '..', '..')
  const read = (relative: string) => readFileSync(join(src, relative), 'utf8')

  it('the persisted-report builder keeps the finding text verbatim', () => {
    // 落库口径：`mergeConsistencyFindingsIntoReview`（被 review-revision-generation 拿去算哈希）。
    const source = read('shared/consistency-preflight.ts')
    const block = source.slice(source.indexOf('export function mergeConsistencyFindingsIntoReview'))
    expect(block).toContain('description: locale === \'en-US\' ? finding.issue.enUS : finding.issue.zhCN')
    expect(block).toContain('quote: finding.evidence')
    // ⚠️ 只认**调用**，不认注释里提到这个名字（那一段注释正是在解释「为什么绝不能剥」）。
    expect(block).not.toMatch(/stripEmphasis\s*\(/u)
  })

  it('the author-facing renderers strip both the description and the evidence line', () => {
    // 渲染口径：审稿单与编辑台面板。
    const sheet = read('components/stage/chapter/ReviewSheet.tsx')
    expect(sheet).toContain('stripEmphasis(item.description)')
    expect(sheet).toContain('stripEmphasis(item.quote)')
    const editorial = read('components/stage/chapter/EditorialPanelSection.tsx')
    expect(editorial).toContain('stripEmphasis(finding.description)')
    expect(editorial).toContain('stripEmphasis(finding.evidence)')
  })

  it('the preflight popover strips the issue, the suggestion and the evidence', () => {
    const source = read('components/stage/write/WritePreflight.tsx')
    expect(source).toContain('stripEmphasis(locale === \'en-US\' ? finding.issue.enUS : finding.issue.zhCN)')
    expect(source).toContain('stripEmphasis(locale === \'en-US\' ? finding.suggestion.enUS : finding.suggestion.zhCN)')
    expect(source).toContain('finding.evidence')
  })
})
