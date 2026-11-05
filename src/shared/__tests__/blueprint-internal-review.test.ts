import { describe, expect, it } from 'vitest'

import Database from 'better-sqlite3'

import {
  BLUEPRINT_INTERNAL_RECENT_CHAPTERS,
  blueprintInternalFindings,
  buildBlueprintInternalPrompt,
  parseBlueprintInternalReview,
} from '../blueprint-internal-review'

/**
 * issue #172：同一章蓝图**自己**对同一件事给了两套值。
 *
 * 现场（第 79 章 `notes`，逐字）：
 * ```
 * - [触发] …认出其绕法与温珩收缆绕法一致（先绕半圈、从左往右收尾、收完压一道）。
 * - [结果] …温珩的结要压三道、第三道收紧时绳头朝里咬住，他压不下去…
 * ```
 * 正文照抄这两句（第 1 段「收完压一道」/ 第 35 段「要压三道」），而全章落幅正是
 * 「他打不成温珩的结法」——读者无法判断他差在哪一步。
 *
 * ⚠️ issue 建议 ① 是「数词 + 量词 + 同一名词」的正则，但它要判「两个『道』是不是同一属性」
 * （同章还有「三道缆桩」「第二道闸」），那必须读懂句子。所以整条交模型；
 * 本文件里**没有任何词表或数字正则**。
 */
const CHAPTER_79 = {
  chapterNumber: 79,
  text: [
    '- [触发] 周叙在第三根缆桩桩脚发现一段绳，认出其绕法与温珩收缆绕法一致（先绕半圈、从左往右收尾、收完压一道）。',
    '- [结果] 周叙回船解开绳按温珩绕法尝试：打一遍松，再打仍松；温珩的结要压三道、第三道收紧时绳头朝里咬住，他压不下去。',
  ].join('\n'),
}

describe('buildBlueprintInternalPrompt (issue #172)', () => {
  it('puts the raw plan text in front of the model', () => {
    const { user } = buildBlueprintInternalPrompt({ chapters: [CHAPTER_79], language: 'zh-CN' })
    expect(user).toContain('压一道')
    expect(user).toContain('压三道')
    expect(user).toContain('第79章')
  })

  it('asks only for a conflict inside ONE chapter, never across chapters', () => {
    const { system } = buildBlueprintInternalPrompt({ chapters: [CHAPTER_79], language: 'zh-CN' })
    expect(system).toContain('同一章')
    expect(system).toContain('不要跨章比较')
  })

  it('excludes the two look-alikes: agreeing repeats and words that merely coincide', () => {
    const { system } = buildBlueprintInternalPrompt({ chapters: [CHAPTER_79], language: 'zh-CN' })
    // 「同一件事提两次而说法一致」不算；「两件不同的事共用一个词」也不算。
    expect(system).toContain('说法一致')
    expect(system).toContain('共用一个词')
  })

  it('does not build a number or unit word list (the number may be spelled out)', () => {
    const { system } = buildBlueprintInternalPrompt({ chapters: [CHAPTER_79], language: 'zh-CN' })
    expect(system).toContain('按**意思**判断')
    expect(system).not.toMatch(/以下词|命中任一|封闭集合/u)
    // 提示词里**可以**用一句实例说明「什么叫互斥」（压一道 vs 压三道）——那是给模型看的例子，
    // 不是判据自己去匹配的模式。真正的证据是上一行：没有「命中任一」这种形态。
    expect(system).toContain('按**意思**判断')
  })

  it('requires both quotes and forbids guessing', () => {
    const { system } = buildBlueprintInternalPrompt({ chapters: [CHAPTER_79], language: 'zh-CN' })
    expect(system).toContain('逐字引用')
    expect(system).toContain('不确定就不要报')
  })

  it('bounds the window to the recent chapters', () => {
    const many = Array.from({ length: BLUEPRINT_INTERNAL_RECENT_CHAPTERS + 3 }, (_, index) => ({
      chapterNumber: index + 1, text: `第${index + 1}章蓝图：压一道。`,
    }))
    const { user } = buildBlueprintInternalPrompt({ chapters: many, language: 'zh-CN' })
    expect(user).toContain(`第${BLUEPRINT_INTERNAL_RECENT_CHAPTERS + 3}章`)
    expect(user).not.toContain('### 第1章蓝图')
  })
})

describe('parseBlueprintInternalReview (issue #172)', () => {
  const request = { chapters: [CHAPTER_79] }
  const conflict = {
    chapterNumber: 79,
    firstQuote: '收完压一道',
    secondQuote: '温珩的结要压三道',
    explanation: '同一个结的收法给了两个道数',
  }

  it('keeps a report whose two quotes both locate verbatim in that plan', () => {
    expect(parseBlueprintInternalReview(JSON.stringify({ issues: [conflict] }), request)).toEqual([conflict])
  })

  it('drops a report whose quote the model paraphrased', () => {
    // 「压一遭」不在蓝图里 → 作者按它去核会找不到。
    expect(parseBlueprintInternalReview(
      JSON.stringify({ issues: [{ ...conflict, firstQuote: '收完压一遭' }] }), request,
    )).toEqual([])
  })

  it('drops the same quote reported as both sides (not a conflict)', () => {
    expect(parseBlueprintInternalReview(
      JSON.stringify({ issues: [{ ...conflict, secondQuote: conflict.firstQuote }] }), request,
    )).toEqual([])
  })

  it('drops reports about chapters outside the request', () => {
    expect(parseBlueprintInternalReview(JSON.stringify({ issues: [{ ...conflict, chapterNumber: 999 }] }), request)).toEqual([])
  })

  it('rejects malformed output instead of silently adopting nothing', () => {
    expect(parseBlueprintInternalReview('{not json', request)).toBeNull()
    expect(parseBlueprintInternalReview(JSON.stringify({ contradictions: [] }), request)).toBeNull()
  })

  it('dedupes the same report twice', () => {
    expect(parseBlueprintInternalReview(JSON.stringify({ issues: [conflict, conflict] }), request)).toHaveLength(1)
  })
})

describe('blueprintInternalFindings (issue #172)', () => {
  const conflict = {
    chapterNumber: 79,
    firstQuote: '收完压一道',
    secondQuote: '温珩的结要压三道',
    explanation: '同一个结的收法给了两个道数',
  }

  it('names both sides and anchors the key on the chapter', () => {
    const [finding] = blueprintInternalFindings([conflict])
    expect(finding!.stableFactKey).toBe('blueprint:internal-contradiction:79')
    expect(finding!.sourceChapter).toBe(79)
    expect(finding!.evidence).toContain('压一道')
    expect(finding!.evidence).toContain('压三道')
  })

  it('keeps the key stable (chapter number is a fact, not a roll)', () => {
    // 与 #86/#89/#98/#108 的区别：那几族嵌的是**当前章号**（会滚），这里嵌的是章节本身。
    const [finding] = blueprintInternalFindings([conflict])
    const again = blueprintInternalFindings([{ ...conflict, explanation: '换个说明' }])
    expect(again[0]!.stableFactKey).toBe(finding!.stableFactKey)
  })

  it('merges several conflicts in one chapter into one finding (ack must not swallow the rest)', () => {
    const second = { ...conflict, firstQuote: '两行脚印', secondQuote: '另半个小脚印' }
    const findings = blueprintInternalFindings([conflict, second])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidence).toContain('压一道')
    expect(findings[0]!.evidence).toContain('两行脚印')
  })

  it('offers two concrete repairs and points at the prose side', () => {
    const [finding] = blueprintInternalFindings([conflict])
    expect(finding!.suggestion.zhCN).toContain('选一个值当权威')
    // 「两处本来讲的是两件事」也行——但要在第二处写清区别。
    expect(finding!.suggestion.zhCN).toContain('两件事')
    // 正文照抄了蓝图：修蓝图之后正文那两句也得跟着统一。
    expect(finding!.suggestion.zhCN).toContain('正文')
  })

  it('gives the English side too', () => {
    const [finding] = blueprintInternalFindings([conflict])
    expect(finding!.issue.enUS).toContain('contradicts itself')
    expect(finding!.suggestion.enUS).toContain('authoritative')
  })

  it('says nothing when no conflict was reported', () => {
    expect(blueprintInternalFindings([])).toEqual([])
  })
})

/**
 * 真书复算（只读副本）。这条钉住「现场那一章确实会在被喂进去的文本里」——
 * 判据本身是模型的，但**取数**必须覆盖 `notes`：第 79 章的两句都在 notes 里，
 * 而写作弹层的 prefill 不含 notes（这正是它此前 50 条预检里 0 次提及的原因之一）。
 */
describe('real corpus: chapter 79 blueprint text (issue #172)', () => {
  const file = 'F:/aiNovelWriter/qa-run/sim2/projects/QA 夜航船 4941/.ai-novel/project.db'

  it('carries both contradictory phrases into the prompt text', () => {
    let db: Database.Database | null = null
    try {
      db = new Database(file, { readonly: true })
    } catch {
      // 副本不在本机时跳过（不把环境依赖变成红）。
      return
    }
    try {
      const row = db.prepare('SELECT notes, key_events, foreshadowing, costs_and_turns FROM blueprints WHERE chapter_number = 79').get() as Record<string, unknown> | undefined
      if (!row) return
      const text = [row.notes, row.key_events, row.foreshadowing, row.costs_and_turns]
        .map(value => String(value ?? '')).join('\n')
      expect(text).toContain('压一道')
      expect(text).toContain('压三道')
      // 关键：两句都在 notes 里 → 只用 keyEvents 组成的文本会漏掉一半。
      expect(String(row.notes)).toContain('压一道')
      expect(String(row.notes)).toContain('压三道')
    } finally {
      db.close()
    }
  })
})
/**
 * issue #180：建议里原来写死了本书样本（「若『压三道』才是设定，就把前面那句改成
 * 『收完压三道』…只写『绕法认得』，不报数」），于是**每一条** finding 的建议里都挂着
 * 那段绳结话——包括讲按字口供、讲油布包的那两条。作者照它去改根本无从下手。
 *
 * 一条建议必须**只讲这一条 finding 自己的两处原文**。
 */
describe('建议不许写死样本 (issue #180)', () => {
  const unrelated = {
    chapterNumber: 77,
    firstQuote: '称记得柜台上铜墨盒推过去、『他』攥着周叙的手往下压',
    secondQuote: '徐汐从暗格出来，说她记得邵广海逼温珩按字的经过',
    explanation: '同一按字场景，被按手的人一处写周叙，一处写温珩',
  }

  it('quotes this finding’s own two sides, not a sample from another chapter', () => {
    const [finding] = blueprintInternalFindings([unrelated])
    // 这一条讲的是按字，建议里必须出现它自己的两处原文……
    expect(finding!.suggestion.zhCN).toContain('攥着周叙的手往下压')
    expect(finding!.suggestion.zhCN).toContain('逼温珩按字')
    // ……而绝不能出现别的章的样本词。
    expect(finding!.suggestion.zhCN).not.toContain('压三道')
    expect(finding!.suggestion.zhCN).not.toContain('绕法认得')
    expect(finding!.suggestion.enUS).not.toContain('压三道')
  })

  it('the rope-knot finding still gets a usable suggestion (quoting itself)', () => {
    const [finding] = blueprintInternalFindings([{
      chapterNumber: 79,
      firstQuote: '收完压一道',
      secondQuote: '温珩的结要压三道',
      explanation: '同一个结的收法给了两个道数',
    }])
    expect(finding!.suggestion.zhCN).toContain('收完压一道')
    expect(finding!.suggestion.zhCN).toContain('温珩的结要压三道')
    // 第三条出路（不报具体值）保留——它是唯一与具体样本无关的那条。
    expect(finding!.suggestion.zhCN).toContain('不报具体值')
  })

  it('merges several contradictions without borrowing text from any of them as a sample', () => {
    const [finding] = blueprintInternalFindings([
      unrelated,
      { chapterNumber: 77, firstQuote: '甲值', secondQuote: '乙值', explanation: '' },
    ])
    // 合并时引用的是**第一条**的两处原文（不是随机挑一条当样本）。
    expect(finding!.suggestion.zhCN).toContain('攥着周叙的手往下压')
    expect(finding!.suggestion.zhCN).not.toContain('压三道')
  })
})
