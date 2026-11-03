import { describe, expect, it } from 'vitest'

import {
  ABILITY_BYPASS_MIN_CHAPTERS,
  abilityFailureCondition,
  findAbilityLimitBypass,
  findAbilityLimitBypassFindings,
} from '../ability-limit-bypass'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

// issue #100：核心能力「墨痕溯读」的硬限制「离船上岸即失效」被静默绕过——
// 第 29 章明说「岸上读不出来」，第 36 章起连续 5 次在岸上读成功，全书没有一句交代。
// 模型自己想了个绕法（自带水：茶碗剩水、湿毛巾、蒸汽），问题不在「绕」，在于没人对此提出疑问。
const WORLDBUILDING = [
  '### 3. 金手指非对称优势：“墨痕溯读”',
  '**触发条件**：只能作用于被涂改过、且水汽未散的墨迹。夜航船舱内常年潮润，正是天然触发场；离船上岸，墨干气散，能力立刻衰减到几乎为零。',
  '船每夜只湿那么几个时辰，从开航到靠岸就是他的倒计时。',
].join('\n')

describe('abilityFailureCondition (issue #100)', () => {
  it('takes the restriction from the worldbuilding — no genre word list', () => {
    expect(abilityFailureCondition(WORLDBUILDING)).toBe('离船上岸，墨干气散，能力立刻衰减到几乎为零')
  })

  it('prefers the shortest matching sentence, which states the limit most directly', () => {
    // 同一段里还有一句在讲背景机制（更长），应取最短那句。
    const verbose = `${WORLDBUILDING}\n于是墨迹总有覆盖、有涂改、有补笔——而船靠岸干燥之后，所有的湿痕一起干死，什么也读不出来了。`
    expect(abilityFailureCondition(verbose)).toBe('离船上岸，墨干气散，能力立刻衰减到几乎为零')
  })

  it('returns null when the worldbuilding declares no such limit', () => {
    expect(abilityFailureCondition('这是一个关于复仇与救赎的故事。')).toBeNull()
    expect(abilityFailureCondition('')).toBeNull()
  })

  it('needs both a failure predicate and a venue shift', () => {
    expect(abilityFailureCondition('能力有时会失效。')).toBeNull()
    expect(abilityFailureCondition('他上了岸，看见码头上很多人。')).toBeNull()
  })
})

describe('findAbilityLimitBypass (issue #100)', () => {
  /** 受限场地（陆地）+ 自造条件 + 成功 */
  const ashoreBypass = (n: number) => ch(n, [
    '天光从窗纸透进来。担保书副本还摊在桌面，半张。账房在码头后街。',
    '周叙往前半步，端起茶碗，把碗底剩水泼在桌沿。',
    '周叙把那根条子按在湿处。纸一软，背面墨翻上来。',
  ].join('\n\n'))
  /** 触发场地（船上）+ 成功：正常使用 */
  const aboardUse = (n: number) => ch(n, [
    '舱底潮气顺着板缝往上爬。',
    '周叙把票根蘸了舷板上的凝水，按在字口上。',
    '底下一层旧墨先浮出边，整个名字顶上来。',
  ].join('\n\n'))

  it('reports the reported shape: ashore + self-supplied water + success', () => {
    const hits = findAbilityLimitBypass({
      worldbuilding: WORLDBUILDING,
      chapters: [aboardUse(20), ashoreBypass(36), ashoreBypass(43)],
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.chapters).toEqual([36, 43])
    expect(hits[0]!.restriction).toContain('离船上岸')
    expect(hits[0]!.excerpt).toContain('墨翻上来')
  })

  it('does not report use aboard the ship, where the ability is supposed to work', () => {
    expect(findAbilityLimitBypass({
      worldbuilding: WORLDBUILDING,
      chapters: [aboardUse(5), aboardUse(11), aboardUse(19)],
    })).toEqual([])
  })

  it('stays silent once any chapter turns it into a discovery — the rule change becomes plot', () => {
    // issue 建议 3：正文里显式写出这个发现（哪怕一句），就不该再报。
    expect(findAbilityLimitBypass({
      worldbuilding: WORLDBUILDING,
      chapters: [ashoreBypass(36), ashoreBypass(43),
        ch(44, '他试过，纸一湿，字就活了。原来不必等船。账房里也能读。')],
    })).toEqual([])
  })

  it('does not accept a bare 「原来」 as an acknowledgement', () => {
    // ⚠️ 标定踩到：裸「原来」绝大多数是普通叙述（「原来那道刮白沟还在」），
    // 收了会把全书判成「已交代」从而**永久静音**。要求发现指向条件本身。
    expect(findAbilityLimitBypass({
      worldbuilding: WORLDBUILDING,
      chapters: [ashoreBypass(36), ashoreBypass(43),
        ch(44, '账房的门开着。原来那道刮白沟还在，被新条盖住半截。')],
    })).toHaveLength(1)
  })

  it('does not report a single occurrence — one chapter may genuinely explain it', () => {
    expect(findAbilityLimitBypass({
      worldbuilding: WORLDBUILDING,
      chapters: [ashoreBypass(36)],
    })).toEqual([])
    expect(ABILITY_BYPASS_MIN_CHAPTERS).toBeGreaterThanOrEqual(2)
  })

  it('says nothing when the worldbuilding declares no limit to bypass', () => {
    expect(findAbilityLimitBypass({
      worldbuilding: '这是一个关于复仇与救赎的故事。',
      chapters: [ashoreBypass(36), ashoreBypass(43)],
    })).toEqual([])
  })

  it('does not judge a scene whose venue is ambiguous (both venue classes present)', () => {
    // 宁漏不误报：窗口里既有船上词又有陆地词时判 unknown。
    const ambiguous = (n: number) => ch(n, [
      '账房的窗对着码头，远处那条夜航船泊在舷边。',
      '周叙把碗底剩水泼在桌沿，条子按在湿处。',
      '纸一软，背面墨翻上来。',
    ].join('\n\n'))
    expect(findAbilityLimitBypass({
      worldbuilding: WORLDBUILDING,
      chapters: [ambiguous(36), ambiguous(43)],
    })).toEqual([])
  })
})

describe('findAbilityLimitBypassFindings (issue #100 finding shape)', () => {
  const chapters = [
    ch(20, '舱底潮气顺着板缝往上爬。\n\n周叙把票根蘸了舷板上的凝水，按在字口上。\n\n整个名字顶上来。'),
    ch(36, '天光从窗纸透进来。账房在码头后街。\n\n周叙端起茶碗，把碗底剩水泼在桌沿。\n\n周叙把那根条子按在湿处。纸一软，背面墨翻上来。'),
    ch(43, '售票亭侧门。\n\n周叙摸出空白票纸，凑到毛巾最湿那角按了按。\n\n潮气渗进去，墨翻上来。'),
  ]

  it('names the restriction, the bypassed chapters and the excerpt, and stays a warning', () => {
    const findings = findAbilityLimitBypassFindings({ worldbuilding: WORLDBUILDING, chapters })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('ability:limit-bypassed')
    expect(findings[0]!.severity).toBe('warning')
    // sourceChapter 指向**首次绕过的章**（旧账，不是正在写的那一章——#79/#108）。
    expect(findings[0]!.sourceChapter).toBe(36)
    expect(findings[0]!.evidence).toContain('离船上岸')
    expect(findings[0]!.evidence).toContain('36、43')
  })

  it('hands over three executable exits (discovery / cost / drop the limit)', () => {
    const finding = findAbilityLimitBypassFindings({ worldbuilding: WORLDBUILDING, chapters })[0]!
    expect(finding.suggestion.zhCN).toContain('写成发现')
    expect(finding.suggestion.zhCN).toContain('写出代价')
    expect(finding.suggestion.zhCN).toContain('改掉限制')
    expect(finding.suggestion.zhCN).toContain('必须落到正文里')
    expect(finding.suggestion.enUS).toContain('make it a discovery')
  })

  it('keeps the key stable as the book advances (issues #86/#89/#98/#108)', () => {
    const before = findAbilityLimitBypassFindings({ worldbuilding: WORLDBUILDING, chapters })[0]!
    const after = findAbilityLimitBypassFindings({
      worldbuilding: WORLDBUILDING, chapters: [...chapters, ch(60, '票根按在湿处，墨翻上来。账房外。')],
    })[0]!
    expect(after.stableFactKey).toBe(before.stableFactKey)
    expect(before.stableFactKey).not.toContain(':36')
  })
})
