import { describe, expect, it } from 'vitest'

import { acknowledgementTitleOf } from '../acknowledgement-title'
import { stripEmphasis, toAuthorVisibleText } from '../author-visible-text'

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

describe('toAuthorVisibleText (issue #154)', () => {
  const finding = {
    stableFactKey: 'prose-flavor:motif:9',
    severity: 'warning' as const,
    sourceChapter: 9,
    evidence: '第9章「盐包」出现 **7** 次',
    issue: { zhCN: '同一条**骨架**重复', enUS: 'the same **shape** repeats' },
    suggestion: { zhCN: '换**措辞**', enUS: 'change the **wording**' },
  }

  it('strips every author-visible field and keeps the rest of the finding intact', () => {
    const visible = toAuthorVisibleText(finding)
    for (const text of [visible.issue.zhCN, visible.issue.enUS, visible.suggestion.zhCN, visible.suggestion.enUS, visible.evidence]) {
      expect(text).not.toContain('*')
    }
    expect(visible.stableFactKey).toBe(finding.stableFactKey)
    expect(visible.sourceChapter).toBe(9)
  })

  it('does not mutate the source finding (prompt paths still need the markers)', () => {
    toAuthorVisibleText(finding)
    expect(finding.issue.zhCN).toContain('**')
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
