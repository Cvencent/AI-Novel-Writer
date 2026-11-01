import { describe, expect, it } from 'vitest'
import { extractChapterDigest, outlineCharacterStateWrites, outlineRecentEvent, outlineRecentEventForCharacter, splitChapterBlock } from '../outline-chapter-digest'

const block = `## 第12章：旧仓库
主角在旧仓库找到账册，于是确认了失踪者的行动路线。
他因此失去了最后一次见面的机会。
对手发现账册后决定连夜转移。`

describe('splitChapterBlock', () => {
  it('解析章号、标题与正文', () => {
    expect(splitChapterBlock(block)).toMatchObject({ chapterNumber: 12, title: '旧仓库' })
    expect(splitChapterBlock(block).body).toContain('账册')
  })

  it('无标题时章号为 null', () => {
    expect(splitChapterBlock('只是正文').chapterNumber).toBeNull()
  })
})

describe('extractChapterDigest', () => {
  it('摘要取前 4 句', () => {
    const digest = extractChapterDigest(block, [])
    expect(digest.chapterNotes).toContain('旧仓库找到账册')
    expect(digest.chapterNotes).toContain('失去了最后一次见面的机会')
  })

  it('只保留出现过的已知人名', () => {
    const digest = extractChapterDigest(block, ['主角', '对手', '未出场的人'])
    expect(digest.characterNames).toEqual(['主角', '对手'])
  })

  it('抽取含因果结果词的连续性事实', () => {
    const digest = extractChapterDigest(block, [])
    expect(digest.continuityFacts.length).toBeGreaterThan(0)
    expect(digest.continuityFacts.join(' ')).toContain('于是')
  })

  it('正文为空时返回空字段而不抛错', () => {
    expect(extractChapterDigest('## 第1章：空', [])).toEqual({
      chapterNotes: '', narrativeBody: '', eventBody: '', characterNames: [], continuityFacts: [],
    })
  })
})

describe('outlineRecentEvent', () => {
  it('只取首个句末，避免把整章摘要写进最近事件', () => {
    expect(outlineRecentEvent('**场景与出场人物**：大厅。**本章目标**：查验台账。'))
      .toBe('**场景与出场人物**：大厅。')
  })

  it('超长且无中间句末标点时硬截（不加省略号半句，issue #18）', () => {
    const long = `${'甲'.repeat(80)}。`
    const result = outlineRecentEvent(long, 50)
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result.endsWith('…')).toBe(false)
  })

  it('超长但在限长内有句末标点时截到句末（issue #18）', () => {
    const text = '第一句话比较长一些要占掉不少的字符位置。第二句。'
    const result = outlineRecentEvent(text, 30)
    expect(result).toBe('第一句话比较长一些要占掉不少的字符位置。')
  })

  it('剥离签头行后再取摘要（issue #18）', () => {
    const block = [
      '## 第8章：淡出的半径',
      '',
      '**场景与出场人物**：雾津港行会茶棚、潮生号验票舱；验票船工·主角、搭档·老前辈。',
      '',
      '主角在验票舱核对名册，发现多出一名乘客。于是他把这一页折了角。',
    ].join('\n')
    const digest = extractChapterDigest(block, ['主角'])
    expect(digest.chapterNotes.startsWith('**场景与出场人物**')).toBe(false)
    expect(digest.chapterNotes).toContain('核对名册')
  })

  it('空摘要返回空字符串', () => {
    expect(outlineRecentEvent('   ')).toBe('')
  })

  it('逐角色取相关句子：两角色不同句；无专属句的角色留空（issue #18）', () => {
    const notes = '主角在验票舱核对名册，发现多出一名乘客。搭档在码头酒棚打听到了旧账的下落。双方在栈桥碰头交换消息。'
    const taken = new Set<string>()
    const forProtagonist = outlineRecentEventForCharacter(notes, '主角', taken)
    const forPartner = outlineRecentEventForCharacter(notes, '搭档', taken)
    expect(forProtagonist).toContain('验票舱')
    expect(forPartner).toContain('码头')
    expect(forProtagonist).not.toBe(forPartner)
    // 没被提到的角色：留空，不冒充
    expect(outlineRecentEventForCharacter(notes, '路人甲', taken)).toBe('')
  })

  it('同章算出的值与他人重复时后写者留空', () => {
    const notes = '主角和搭档一起查案，两人始终同行。两人最后一起发现了真相。'
    const taken = new Set<string>()
    const first = outlineRecentEventForCharacter(notes, '主角', taken)
    expect(first).not.toBe('')
    taken.add(first)
    const second = outlineRecentEventForCharacter(notes, '搭档', taken)
    expect(second).toBe('')
  })

  it('出场角色写到第 5 句之后的动作也能被取到（issue #24：窗口是全章不是前 4 句）', () => {
    // 真实细纲的形状：签头行 + 六个小节，角色动作在「转折与代价」段（第 5 句之后）。
    const block = [
      '## 第8章：淡出的半径',
      '',
      '**场景与出场人物**：雾津港行会茶棚、潮生号验票舱；验票船工·温珩、搭档·陈阿水。',
      '',
      '雾津港的雾比往常浓。',
      '验票舱核出的名册多了一名乘客。',
      '按约定双方要在栈桥碰头交换消息。',
      '船工们商量着改走水路。',
      '笔反倒慢下来，温珩把折角的那一页誊进私册。',
      '结尾钩子：陈阿水认出通缉令上那张脸。',
    ].join('\n')
    const digest = extractChapterDigest(block, ['温珩', '陈阿水'])
    // 前 4 句里根本没有第 5 句之后的动作——这正是 1.5.66 旧窗口的缺陷。
    expect(digest.chapterNotes.includes('笔反倒慢下来')).toBe(false)
    expect(digest.narrativeBody.includes('笔反倒慢下来')).toBe(true)
    const writes = outlineCharacterStateWrites(digest)
    const byName = new Map(writes.map(write => [write.characterName, write.recentEvents]))
    expect(byName.get('温珩')).toContain('折角的那一页')
    expect(byName.get('陈阿水')).toContain('通缉令')
  })

  it('取不到专属句的角色不进写库清单，而不是返回空值（issue #24：空值覆盖会擦掉旧事件）', () => {
    const digest = {
      narrativeBody: '温珩在验票舱核对名册。',
      characterNames: ['温珩', '没出场的角色'],
    }
    const writes = outlineCharacterStateWrites(digest)
    expect(writes).toEqual([{ characterName: '温珩', recentEvents: '温珩在验票舱核对名册。' }])
  })
})

// issue #45：cs_recent_events 被写成「本章目标」这个**计划**，而且只在名单里被提一句的人
// （本章 0 出场）也拿到了 ch=本章 的「刚参与过」标记。
describe('recentEvents 只取事件型小节（issue #45）', () => {
  const block = [
    '## 第11章：笔尖悬停',
    '',
    '**场景与出场人物**：验票舱与货舱口；出场的有验票船工·周叙、账房伙计·任九、只在船尾誊抄的搭档·温珩。已淡出的陆敬堂只被人一句带过，不在场。',
    '',
    '**本章目标**：周叙要把这一班验完销差，提笔录完当夜乘客、落笔、交册。',
    '',
    '**阻力与升级**：原墨已焚销，新册内页誊得工整，没有一处涂改；陆敬堂借“私留票根”清洗了两名旧人。',
    '',
    '**转折与代价**：他提笔录完当夜乘客，笔尖悬在自己名字正上方那一格。任九又催一遍，他把笔收回，写了句“今夜无增”。',
    '',
    '**结尾钩子**：周叙手按着那块翘起的船板，没有掀开。',
    '',
    '**伏笔**：半画双名票根仍压在船板夹缝；温珩的誊抄痕迹淡得几乎看不见。',
  ].join('\n')

  const digest = extractChapterDigest(block, ['周叙', '任九', '温珩', '陆敬堂'])
  const byName = new Map(outlineCharacterStateWrites(digest).map(w => [w.characterName, w.recentEvents]))

  it('计划文本不再进入 recentEvents', () => {
    expect(digest.eventBody).not.toContain('本章目标')
    expect(digest.eventBody).not.toContain('阻力与升级')
    expect(digest.eventBody).not.toContain('伏笔')
    for (const event of byName.values()) {
      expect(event).not.toContain('本章目标')
      expect(event.startsWith('**')).toBe(false)
    }
  })

  it('只出现在名单/伏笔里的人不会被写着「刚参与过」', () => {
    // 温珩只在名单与伏笔里被提，陆敬堂只在名单与阻力段被提——两节都不是事件型，两人都不该写
    expect(byName.has('温珩')).toBe(false)
    expect(byName.has('陆敬堂')).toBe(false)
  })

  it('真正参与事件的人仍能取到本章发生的事', () => {
    expect(byName.get('任九')).toContain('催')
    for (const event of byName.values()) expect(event.length).toBeLessThanOrEqual(50)
  })
})
