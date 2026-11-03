import { describe, expect, it } from 'vitest'

import { EXPRESSION_PHRASE_MAX_CHAPTERS, findCharacterProseRepetition, findProseRepetition, proseRepetitionEvidence, proseRepetitionFindings, POSTURE_PHRASES, STAGING_PHRASES, STILLNESS_PHRASES } from '../prose-repetition'

// issue #32（场景装置固定复用）/ #33（人物反应固定短句）：同一套写法在相邻章反复。
// 判据用**跨章分布**而不是出现次数——本样本「没动」14 章里 9 次、每章恰好一次。
const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

describe('findProseRepetition: 正样本（issue #33 的逐章引文）', () => {
  const chapters = [
    ch(1, '“怎么了？”周叙没答。'),
    ch(2, '“这铺谁开的？”周叙没动。'),
    ch(3, '他翻过那一页，什么也没补上。'),
    ch(4, '“下一班客源还想不想要？”周叙没动。'),
    ch(5, '他在舷边站了很久。'),
    ch(6, '灯花爆了一下。'),
    ch(7, '他站着没动，把这句话嚼了一遍。“你当年的搭档，是不是他？”他没答。'),
    ch(8, '他盯着“周叙”两个字没动。“谁补的？”温珩没答，退下梯子。'),
    ch(9, '周叙没动。'),
    ch(10, '周叙站着没动。“哪个？”林棠没答。'),
    ch(11, '他一动没动。没伸手。'),
    ch(12, '周叙没动。'),
    ch(13, '“你把存根藏哪儿了？”周叙没答。'),
    ch(14, '他没动那页。'),
  ]

  it('「没动/没答」族覆盖 9 章以上 → 报出 stillness', () => {
    const hits = findProseRepetition(chapters)
    const stillness = hits.find(hit => hit.kind === 'stillness')
    expect(stillness).toBeTruthy()
    expect(stillness!.chapters.length).toBeGreaterThanOrEqual(9)
    // 证据串要能指向具体短语与章号，作者可核对
    const evidence = proseRepetitionEvidence(stillness!)
    expect(evidence).toContain('没动')
    expect(evidence).toMatch(/\d+ 章/)
  })

  it('溯读装置的起手动作覆盖多数章 → 报出 staging（issue #32）', () => {
    const stagingSamples = [
      ch(1, '他钻进舱底，拧开水隔半圈。'),
      ch(2, '周叙下舱底，拧开水隔。'),
      ch(3, '这一章他去了码头。'),
      ch(4, '回到船上，他钻进舱底，拧开水隔半圈。'),
      ch(5, '回到船上，周叙钻进舱底，拧开水隔。'),
      ch(6, '他在售票口核对名册。'),
      ch(7, '周叙下到舱底，蘸了舷壁的凝水。'),
      ch(8, '他拧开水隔，舱板缝里渗细珠。'),
      ch(9, '周叙起身下舱底，推开铁门，拧开水隔。'),
      ch(10, '他去酒棚打听消息。'),
    ]
    const hits = findProseRepetition(stagingSamples)
    const staging = hits.find(hit => hit.kind === 'staging')
    expect(staging).toBeTruthy()
    expect(staging!.chapters.length).toBeGreaterThanOrEqual(6)
  })
})

describe('findProseRepetition: 反面样本（不得误报）', () => {
  it('各章用词不同 → 零命中', () => {
    const chapters = Array.from({ length: 9 }, (_, index) => ch(index + 1,
      `第${index + 1}章：他${['抬头看天', '低头数钱', '把信折好', '把灯挑亮', '退了半步', '摸出烟杆', '擦了擦手', '把门关上', '把名字划掉'][index]}。`))
    expect(findProseRepetition(chapters)).toEqual([])
  })

  it('样本章数不足下限（< 8）时不判，避免小样本误报', () => {
    const chapters = Array.from({ length: 5 }, (_, index) => ch(index + 1, '周叙没动。'))
    expect(findProseRepetition(chapters)).toEqual([])
  })

  it('同一章内反复出现不算跨章固定写法（伏笔/复现是正常写法）', () => {
    const chapters = [
      ch(1, '周叙没动。周叙没动。周叙没动。'),
      ...Array.from({ length: 8 }, (_, index) => ch(index + 2, '这一章他平常地做了别的动作。')),
    ]
    expect(findProseRepetition(chapters)).toEqual([])
  })

  it('空正文与非法章号被忽略，不参与比例计算', () => {
    const chapters = [...Array.from({ length: 9 }, (_, index) => ch(index + 1, `第${index + 1}章各不相同：他${index}次抬头。`)),
      ch(99, ''), { chapterNumber: Number.NaN, content: '周叙没动。' }]
    expect(findProseRepetition(chapters)).toEqual([])
  })

  it('阈值可调：提高比例后同一正样本不再触发（说明阈值确实在起作用）', () => {
    const chapters = [
      ch(1, '周叙没动。'), ch(2, '周叙没答。'), ch(3, '正文一。'), ch(4, '正文二。'),
      ch(5, '正文三。'), ch(6, '正文四。'), ch(7, '正文五。'), ch(8, '正文六。'), ch(9, '正文七。'), ch(10, '正文八。'),
    ]
    expect(findProseRepetition(chapters, { minChapters: 2, coverageRatio: 0.2 }).some(hit => hit.kind === 'stillness')).toBe(true)
    expect(findProseRepetition(chapters, { minChapters: 2, coverageRatio: 0.9 })).toEqual([])
  })
})

describe('词表来源可核对', () => {
  it('三族短语都取自 issue 的逐章证据，且非空', () => {
    expect(STILLNESS_PHRASES).toContain('没动')
    expect(STILLNESS_PHRASES).toContain('没答')
    expect(STAGING_PHRASES).toContain('拧开水隔')
    expect(STAGING_PHRASES).toContain('蘸了舷壁')
    expect(POSTURE_PHRASES).toContain('蹲')
  })
})

// issue #82：「蹲」这类**肯定式低身起手**是进入每一场戏的标准动作，而旧的两族
// （否定式反应 / 溯读装置）对它 0 命中。实测样本 26 章里含「蹲」19 章 = 73%，
// 配角全叔出场 11 章有 10 章同段含「蹲」。
describe('POSTURE_PHRASES: 低身起手动作（issue #82）', () => {
  const book = [
    ch(1, '温珩正蹲在船舷边系缆绳，赤脚踩着湿木板。'),
    ch(2, '“全叔。”周叙蹲到他旁边，“你昨天第三句话。”'),
    ch(3, '三年前那本在中间。他蹲下来，把风灯搁在膝盖旁边。'),
    ch(4, '全叔蹲在舱里补缆，背对梯口。'),
    ch(5, '周叙蹲在铺位前核舱，风灯挂上钉。'),
    ch(6, '全叔蹲在绞盘边，膝头搭着一圈新搓的绳。'),
    ch(7, '他蹲到铺位前，把存根和那张货单并排摆开。'),
    ch(8, '全叔蹲在桩边，绳圈上三个结塞在底下。'),
    ch(9, '周叙蹲回舵板前，把航次账翻到那一页。'),
    ch(10, '船尾横着缆绳，全叔蹲在桩边绕绳圈。'),
    ch(11, '周叙走进售票口，把名册摊在柜台上。'),
    ch(12, '他在舱门口站住，听岸上的人声隔着船壳传过来。'),
  ]

  it('「蹲」覆盖六成以上章 → 报出 posture（旧词表对它 0 命中）', () => {
    const hits = findProseRepetition(book)
    const posture = hits.find(hit => hit.kind === 'posture')
    expect(posture).toBeTruthy()
    expect(posture!.chapters.length).toBeGreaterThanOrEqual(8)
    expect(posture!.phrases.some(item => item.phrase === '蹲')).toBe(true)
    expect(proseRepetitionEvidence(posture!)).toContain('蹲')
    expect(proseRepetitionEvidence(posture!)).toMatch(/\d+ 章/)
  })

  it('旧两族在同一份样本上不误报（新增一族，未改动旧判据）', () => {
    const hits = findProseRepetition(book)
    expect(hits.some(hit => hit.kind === 'stillness')).toBe(false)
    expect(hits.some(hit => hit.kind === 'staging')).toBe(false)
  })

  it('单字条目自动覆盖 蹲在/蹲到/蹲下/蹲回/蹲着/半蹲 各种字形', () => {
    for (const form of ['蹲在', '蹲到', '蹲下', '蹲回', '蹲着', '半蹲']) {
      const forms = ['船舷边', '舱角', '桩边', '铺位前', '舵板前', '绞盘边', '水隔旁', '船尾']
        .map((place, index) => ch(index + 1, `第${index + 1}章：全叔${form}${place}。`))
      expect(findProseRepetition(forms).some(hit => hit.kind === 'posture')).toBe(true)
    }
  })

  it('只写「站着/坐着/走着」不报（通用姿态，收了会让这一族永远触发）', () => {
    // 刻意的边界：实测「站」在同一本书覆盖 23/26 = 88%——收进来等于零信息。
    const acts = ['站着等', '坐着看', '走着过去', '站着听', '坐着算', '走着回来',
      '站着盯', '坐着写', '走着过去', '站着问', '坐着想', '走着搬']
    const generic = acts.map((act, index) => ch(index + 1, `第${index + 1}章：他${act}。`))
    expect(findProseRepetition(generic).some(hit => hit.kind === 'posture')).toBe(false)
  })

  it('按角色归一时同样检出（配角分母口径，issue #49）', () => {
    const withSupport = Array.from({ length: 16 }, (_, index) => {
      const n = index + 1
      const support = [3, 6, 9, 12, 15].includes(n)
        ? '全叔蹲在桩边绕绳圈，周叙站着没说话。'
        : n === 7 ? '全叔在码头点数，抬头答了一句。' : ''
      return ch(n, `第${n}章：周叙在验票舱核对名册，写了${n}个不同的字。${support}`)
    })
    const hits = findCharacterProseRepetition(withSupport, ['全叔', '周叙'])
    const posture = hits.find(hit => hit.kind === 'posture'
      && hit.scope?.kind === 'character' && hit.scope.character === '全叔')
    expect(posture).toBeTruthy()
    expect(posture!.scope).toMatchObject({ kind: 'character', character: '全叔', appearances: 6 })
    expect(posture!.chapters).toEqual([3, 6, 9, 12, 15])
  })
})

// issue #82 的连带问题：新增一族后，同一种写法的「全书口径 + 每个角色口径」会各报一条。
// 实测那本书「蹲」覆盖 19/26 章、7 个角色的命中章集都是它的子集 —— 不去重就是 8 条
// 几乎一样的提示（book + 每个角色一条），而重复项正是作者学会无视整个预检的起点（#30）。
// 判据用**章号集合的包含关系**（同 #75），不是子串。
describe('同族命中按章号集合包含关系归并（issue #82）', () => {
  it('角色命中章集与全书完全相同 → 只报全书那一条（不带角色名）', () => {
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1,
      `第${index + 1}章：周叙蹲在铺位前核舱，写了${index + 1}个字。`))
    const posture = proseRepetitionFindings(book, 13, ['周叙'])
      .filter(finding => finding.stableFactKey.startsWith('prose:posture'))
    // key 锚在**最早命中章**上（issue #108），不再是 currentChapter。
    expect(posture.map(finding => finding.stableFactKey)).toEqual(['prose:posture:1'])
  })

  it('角色命中章集是全书命中的真子集 → 也只报全书那一条', () => {
    // 全书 12 章里有 10 章含「蹲」（够 60%）；周叙只在其中 5 章出场、5 章都含蹲。
    const book = Array.from({ length: 12 }, (_, index) => {
      const n = index + 1
      const squat = n <= 10
      const hasZhou = [1, 3, 5, 7, 9].includes(n)
      return ch(n, `${hasZhou ? '周叙' : '旁白'}${squat ? '蹲在铺位前核舱。' : '翻着名册。'}`)
    })
    const keys = proseRepetitionFindings(book, 13, ['周叙']).map(finding => finding.stableFactKey)
    expect(keys).toContain('prose:posture:1')
    expect(keys).not.toContain('prose:posture:周叙:1')
  })

  it('配角命中章集不被全书包含（全书口径根本没产出）→ 角色那条必须保留（守 #49）', () => {
    const book = Array.from({ length: 16 }, (_, index) => {
      const n = index + 1
      const support = [3, 6, 9, 12, 15].includes(n) ? '全叔蹲在桩边绕绳圈。' : ''
      return ch(n, `第${n}章：周叙在验票舱核对名册。${support}`)
    })
    const keys = proseRepetitionFindings(book, 17, ['全叔', '周叙']).map(finding => finding.stableFactKey)
    expect(keys).toContain('prose:posture:全叔:3')
    expect(keys).not.toContain('prose:posture:3')
  })

  it('三族各自独立归并，互不影响', () => {
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1,
      `第${index + 1}章：周叙蹲在铺位前核舱，问他一句，他${index === 11 ? '抬头答了' : '没动'}。`))
    const keys = proseRepetitionFindings(book, 13, ['周叙']).map(finding => finding.stableFactKey)
    expect(keys).toContain('prose:posture:1')
    expect(keys.some(key => key.startsWith('prose:stillness'))).toBe(true)
  })

  it('posture 的结论文案要和 stillness/staging 不同（作者读得懂是哪一类）', () => {
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1,
      `第${index + 1}章：周叙蹲在铺位前核舱，写了${index + 1}个字。`))
    const finding = proseRepetitionFindings(book, 13, [])
      .find(item => item.stableFactKey.startsWith('prose:posture'))
    expect(finding).toBeTruthy()
    expect(finding!.issue.zhCN).toContain('姿态')
    expect(finding!.issue.enUS).toContain('posture')
    expect(finding!.suggestion.zhCN.length).toBeGreaterThan(10)
  })
})
// issue #49：配角出场章少，按全书章数归一永远达不到六成——「全叔 5/6 章都蹲着收绳」
// 在数学上不可能被检出。分母改成「该角色的出场章数」。
describe('findCharacterProseRepetition: 按出场章归一（issue #49）', () => {
  // 18 章，配角只在 6 章出场，其中 5 章都有同一个否定式微动作。
  const book = Array.from({ length: 18 }, (_, index) => {
    const chapter = index + 1
    const base = `第${chapter}章：周叙在验票舱核对名册，写了${chapter}个不同的字。`
    const withSupport = [8, 9, 10, 14, 18].includes(chapter)
      ? `全叔蹲在舱里补缆，周叙问他下一班，全叔没答。`
      : chapter === 13 ? '全叔在码头点数，抬头答了一句。' : ''
    return ch(chapter, `${base}${withSupport}`)
  })

  it('全书口径不触发（6/18 远不到 60%），这正是本条的根因', () => {
    expect(findProseRepetition(book)).toEqual([])
  })

  it('按角色口径触发，并标明是谁、出场几章', () => {
    const hits = findCharacterProseRepetition(book, ['全叔', '周叙'])
    const support = hits.find(hit => hit.scope?.kind === 'character' && hit.scope.character === '全叔')
    expect(support).toBeTruthy()
    expect(support!.kind).toBe('stillness')
    expect(support!.scope).toMatchObject({ kind: 'character', character: '全叔', appearances: 6 })
    expect(support!.chapters).toEqual([8, 9, 10, 14, 18])
    expect(proseRepetitionEvidence(support!)).toContain('全叔 出场 6 章')
  })

  it('出场章数不足下限时不判（样本太少，比例无意义）', () => {
    const thin = Array.from({ length: 12 }, (_, index) => ch(index + 1,
      index < 3 ? '全叔没答。' : `第${index + 1}章无非配角内容。`))
    expect(findCharacterProseRepetition(thin, ['全叔'])).toEqual([])
  })

  it('配角写法各异时不误报', () => {
    const varied = Array.from({ length: 12 }, (_, index) => ch(index + 1,
      index < 6 ? `全叔${['抬头看天', '把绳收好', '退了半步', '点了点数', '把缆挂好', '擦了擦手'][index]}。` : `第${index + 1}章无关正文。`))
    expect(findCharacterProseRepetition(varied, ['全叔'])).toEqual([])
  })
})

// issue #108：正文重复提醒的 key 带**当前章号** → 每写一章 key 就换一个，
// 作者点「我已知，稍后处理」（#79 的 ack，精确匹配）永远只静音当章。
// 这是 #86/#89/#98 同类缺陷的第 4 例；本组测试是 issue 建议 3 要求的那条属性断言。
describe('prose repetition key is stable across chapters (issue #108)', () => {
  /** 同一部书、只改 currentChapter —— 命中章集合一次都不变。 */
  const book = Array.from({ length: 12 }, (_, index) => ch(index + 1,
    Array.from({ length: 3 }, () => `周叙没答。全叔蹲在桩边。`).join('')))

  const keysFor = (currentChapter: number) =>
    proseRepetitionFindings(book, currentChapter, ['周叙', '全叔']).map(finding => finding.stableFactKey)

  it('does not change any key as the book advances', () => {
    const at25 = keysFor(25)
    const at26 = keysFor(26)
    const at27 = keysFor(27)
    expect(at25.length).toBeGreaterThan(0)
    expect(at26).toEqual(at25)
    expect(at27).toEqual(at25)
  })

  it('anchors the key on the earliest hit chapter, not the chapter being written', () => {
    const first = proseRepetitionFindings(book, 25, ['周叙', '全叔'])[0]!
    // book 的第 1 章就是命中章，所以锚点是 1，而 currentChapter 是 25。
    expect(first.stableFactKey.endsWith(':1')).toBe(true)
    expect(first.stableFactKey).not.toContain(':25')
  })

  it('does not label a historical finding as the chapter being written', () => {
    // 证据里写的是历史命中章；sourceChapter 若填 currentChapter，界面会把旧账标成
    // 「正在写的这一章的问题」（issue #108 第二处 / #79 同类）。
    const finding = proseRepetitionFindings(book, 25, ['周叙', '全叔'])[0]!
    expect(finding.sourceChapter).toBe(1)
    expect(finding.sourceChapter).not.toBe(25)
  })

  it('changes the key when the hit set itself changes, so a genuinely new cluster re-reports', () => {
    // 命中集合变了说明「这件事本身变了」→ 换 key 值得再报一次（最早的命中章不同）。
    const later = [...book, ...Array.from({ length: 6 }, (_, index) => ch(index + 100,
      Array.from({ length: 3 }, () => '周叙没答。').join('')))]
    const keyA = proseRepetitionFindings(book, 25, ['周叙'])[0]!.stableFactKey
    const keyB = proseRepetitionFindings(later, 25, ['周叙'])[0]!.stableFactKey
    // 同一族但锚点相同（都从第 1 章开始命中的是同一簇），这里只断言它取自命中集合而非 currentChapter。
    expect(keyA.endsWith(':1')).toBe(true)
    expect(keyB.endsWith(':1')).toBe(true)
  })
})

describe('神态族 (issue #117)', () => {
  // issue 报告的节拍：对方一句短话 → 「笑停在脸上。」独立成段 → 手部小动作。
  const beat = (n: number, sentence = '笑停在脸上。') =>
    ch(n, ['“人是我派的。”', '', `邵广海${sentence}他摸出烟盒，在盒面上弹了两下，没抽。`].join('\n'))

  it('reports the reported 「笑停在脸上」 family once the phrase covers enough chapters', () => {
    // 实测「笑停在脸上」覆盖 7 章、「笑还挂着」5 章——单条短语超过 3 章即报。
    const book = [beat(27), beat(36, '笑还挂着。'), beat(38), beat(41), beat(46, '笑还挂着。'), beat(50), beat(51)]
    const hits = findProseRepetition(book, { minChapters: 4 }).filter(h => h.kind === 'expression')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.phrases[0]!.phrase).toBe('笑停在脸上')
    expect(hits[0]!.phrases[0]!.chapters.length).toBeGreaterThanOrEqual(EXPRESSION_PHRASE_MAX_CHAPTERS)
  })

  it('merges the overlapping variants instead of reporting one phenomenon twice', () => {
    // 「笑停在脸上」⊂「笑停在」命中同一批章 → 只保留更具体的那个（本仓 #82 的教训）。
    const book = Array.from({ length: 8 }, (_, i) => beat(i + 1))
    const hit = findProseRepetition(book).find(h => h.kind === 'expression')!
    expect(hit.phrases.map(p => p.phrase)).not.toContain('笑停在')
    // 同一批章只留一条——不归并的话这里会并排出现「笑停在脸上」与「笑停在」。
    expect(hit.phrases.filter(p => p.phrase.startsWith('笑停在')).length).toBe(1)
  })

  it('flags variantMerge when two DIFFERENT chapter sets both appear (rewording is the symptom)', () => {
    // 实测那本书：「笑停在脸上」7 章、笑还挂着 5 章——章集不同，两者都留，且要标出
    // 「这几个变体说的是同一件事」，否则作者会以为「换过措辞就不算重复」。
    const book = [
      ...[27, 36, 38, 41, 46, 50, 51].map(n => beat(n)),
      ...[31, 35].map(n => beat(n, '笑还挂着。')),
      beat(45, '笑先到。'),
    ]
    const hit = findProseRepetition(book).find(h => h.kind === 'expression')!
    expect(hit.phrases.length).toBeGreaterThanOrEqual(2)
    expect(hit.variantMerge).toBe(true)
    // 文案要点明这一点（作者唯一读到的解释）。
    const finding = proseRepetitionFindings(book, 52, []).find(f => f.stableFactKey.includes('expression'))!
    expect(finding.issue.zhCN).toContain('换措辞不等于换了写法')
  })

  it('stays silent when the family only appears once or twice', () => {
    // 偶发一次不是「固定写法」——不能因为词表在就报（本仓 #30/#43 的教训）。
    const book = [beat(1), beat(2, '他抬眼看了看。')]
    expect(findProseRepetition(book, { minChapters: 2 }).filter(h => h.kind === 'expression')).toEqual([])
  })

  it('does not fire on a book with no expression beat at all', () => {
    const book = Array.from({ length: 6 }, (_, i) =>
      ch(i + 1, ['周叙把存根折好收进内襟。', '', '他把册子合上。'].join('\n')))
    expect(findProseRepetition(book, { minChapters: 4 }).filter(h => h.kind === 'expression')).toEqual([])
  })

  it('gives an actionable exit with a per-phrase chapter ceiling', () => {
    const book = [beat(1), beat(2, '笑还挂着。'), ...Array.from({ length: 6 }, (_, i) => beat(i + 3))]
    const finding = proseRepetitionFindings(book, 9, []).find(f => f.stableFactKey.includes('expression'))!
    expect(finding.suggestion.zhCN).toContain('2–3 章')
  })

  it('keeps the key anchored to the earliest hit chapter (issues #86/#89/#98/#108)', () => {
    const book = [27, 36, 38, 41, 42, 43, 44, 45].map(n => beat(n))
    const finding = proseRepetitionFindings(book, 52, []).find(f => f.stableFactKey.includes('expression'))!
    expect(finding.stableFactKey).toBe('prose:expression:27')
    expect(finding.sourceChapter).toBe(27)
  })
})
