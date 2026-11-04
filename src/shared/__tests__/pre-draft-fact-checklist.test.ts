import { describe, expect, it } from 'vitest'

import { preDraftFactChecklist } from '../pre-draft-fact-checklist'

/**
 * issue #128：把「事实账本 / 角色卡 / 世界观」前移到起草前做一次显式对账。
 *
 * 项目里已有一份 `draft-reconciliation`，但那是一次**模型调用**——模型漏看的东西它也会漏。
 * 本模块补的是另一半：**不调模型、可逐字核对**的正名与时点状态。
 */
describe('preDraftFactChecklist (issue #128)', () => {
  const base = {
    chapterNumber: 26,
    blueprintCharacters: ['周叙', '柯明远'],
    writingLanguage: 'zh-CN' as const,
    keyEvents: '周叙核账。【时点：次日上午】',
  }
  const cast = [
    { name: '周叙', role: 'protagonist', state: {
      location: { value: '码头栈桥', chapterNumber: 25 },
      physicalState: { value: '指腹有墨', chapterNumber: 25 },
    }, formerNames: [] },
    // 名册记过的旧名：第 23 章把「陆敬堂」写成了「穆敬堂」（#102 的现场）。
    { name: '柯明远', role: 'antagonist', state: {
      location: { value: '码头办公室', chapterNumber: 25 },
    }, formerNames: ['穆敬堂'] },
    // 蓝图没点到的人不该出现在清单里。
    { name: '林棠', role: 'supporting', state: { location: { value: '售票亭', chapterNumber: 20 } }, formerNames: [] },
  ]

  it('lists the canonical names of the characters this chapter actually casts', () => {
    const text = preDraftFactChecklist({ ...base, cast })
    expect(text).toContain('周叙')
    expect(text).toContain('柯明远')
    // 蓝图没点到林棠 → 不把整本书的人名塞进提示。
    expect(text).not.toContain('林棠')
  })

  it('states that former spellings are corrected and must not return', () => {
    const text = preDraftFactChecklist({ ...base, cast })
    expect(text).toContain('穆敬堂')
    expect(text).toContain('不得再用')
  })

  it('carries the previous chapter’s state with the chapter it came from', () => {
    const text = preDraftFactChecklist({ ...base, cast })
    expect(text).toContain('location@ch25')
    expect(text).toContain('码头栈桥')
    expect(text).toContain('physicalState@ch25')
  })

  /**
   * issue #135：**判据针对的是「每字段的来源章」，不是角色的单一时间戳**。
   *
   * 上游旧数据里 `cs_updated_at_chapter` 被细纲拉到 26（#130），而各字段的
   * `cs_provenance[...].source.chapterNumber` 还停在 22/23/24。调用方
   * （`generate-draft.buildPreDraftFactChecklist`）传进来的就是**字段级**章号——
   * 这条测试把「角色时间戳超前不影响字段采信」这个契约钉住，防止未来有人
   * 图省事改成读 `currentState.updatedAtChapter`（那会让三个在场角色只剩名字）。
   */
  it('keeps fields whose own provenance chapter is earlier, even when the chapter roll-up is ahead', () => {
    // 输入形态与生成侧一致：state 里的 chapterNumber 取自 provenance，
    // 而角色级 updatedAtChapter 是 26（超前）。第 25 章必须拿到 22/23 那两个字段。
    const cast = [{ name: '周叙', role: 'protagonist', state: {
      location: { value: '码头', chapterNumber: 22 },
      mentalState: { value: '摸到衬页硬边不翻看', chapterNumber: 23 },
      keyItems: { value: '“验”字旧木戳', chapterNumber: 23 },
    }, formerNames: [] }]
    const text = preDraftFactChecklist({ chapterNumber: 25, blueprintCharacters: ['周叙'],
      keyEvents: '', cast, writingLanguage: 'zh-CN' })
    expect(text).toContain('location@ch22')
    expect(text).toContain('mentalState@ch23')
    expect(text).toContain('keyItems@ch23')
    // 三个字段都要在，不能只剩名字。
    expect(text).not.toMatch(/^- 周叙 \(protagonist\)$/mu)
  })

  it('survives the shape where the roll-up is ahead and only some fields are stale', () => {
    // 混合形态：两个字段早于本章（要采信）、一个来自本章（不能当起点）。
    const cast = [{ name: '邵广海', role: 'antagonist', state: {
      location: { value: '码头办公室', chapterNumber: 22 },
      mentalState: { value: '只笑不语', chapterNumber: 23 },
      keyItems: { value: '本章才拿到的单子', chapterNumber: 25 },
    }, formerNames: [] }]
    const text = preDraftFactChecklist({ chapterNumber: 25, blueprintCharacters: ['邵广海'],
      keyEvents: '', cast, writingLanguage: 'zh-CN' })
    expect(text).toContain('location@ch22')
    expect(text).toContain('mentalState@ch23')
    expect(text).not.toContain('本章才拿到的单子')
  })

  it('never uses a state that comes from this chapter or later (rewriting an old chapter)', () => {
    const stale = [{ name: '周叙', role: 'protagonist', state: {
      // 第 26 章的值不能当第 26 章的起点；第 27 章更不能。
      location: { value: '未来地点', chapterNumber: 26 },
      keyItems: { value: '未来的东西', chapterNumber: 27 },
    }, formerNames: [] }]
    const text = preDraftFactChecklist({ ...base, cast: stale })
    expect(text).not.toContain('未来地点')
    expect(text).not.toContain('未来的东西')
  })

  it('carries the blueprint’s time anchor verbatim', () => {
    expect(preDraftFactChecklist({ ...base, cast })).toContain('次日上午')
  })

  it('returns nothing when there is neither a cast nor a time anchor', () => {
    expect(preDraftFactChecklist({ ...base, blueprintCharacters: [], keyEvents: '', cast })).toBe('')
  })

  it('speaks English when the book is written in English', () => {
    const text = preDraftFactChecklist({ ...base, cast, writingLanguage: 'en-US' })
    expect(text).toContain('Canonical names')
    expect(text).toContain('do not reuse')
  })

  it('is structural: the checklist is derived from the roster, not from a phrase list', () => {
    const other = [{ name: '甘阿发', role: 'minor', state: {
      location: { value: '货堆', chapterNumber: 3 },
    }, formerNames: ['甘阿發'] }]
    const text = preDraftFactChecklist({ chapterNumber: 4, blueprintCharacters: ['甘阿发'],
      keyEvents: '【时点：同日夜】', cast: other, writingLanguage: 'zh-CN' })
    expect(text).toContain('甘阿发')
    expect(text).toContain('甘阿發')
    expect(text).toContain('同日夜')
  })
})