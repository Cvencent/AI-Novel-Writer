import { describe, expect, it } from 'vitest'

import {
  DESTINATION_LABELS,
  DESTINATION_PHRASES,
  findHandoverConvergence,
  handoverHits,
  STOW_ACTIONS,
} from '../prop-handover'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

// issue #95：那本 42 章的书里，「一件纸在两个人之间过手」被写成固定三拍
// （出示→核验→**折好→塞进内襟/公文包**）。最严口径命中 24 句、覆盖 18 章（43%）。
// 判据刻意**结构性**：折叠动作 + 收纳动词 + 目的地类三要素同句；按类别归并；
// 按跨章覆盖率判（与 #32 的「用跨章分布，不用出现次数」同一口径）。
describe('handoverHits (issue #95)', () => {
  it('finds the folding-plus-stowing pattern from the report', () => {
    const hits = handoverHits(ch(4, '林棠在柜台后头把存根折了两折，探手塞进搁在柜台边的风灯罩里。'))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.destination).toBe('place')
    expect(hits[0]!.excerpt).toContain('塞进')
  })

  it('groups destinations by class, not by the individual word', () => {
    const body = handoverHits(ch(1, '他把纸折好，揣进怀里。'))[0]!
    const container = handoverHits(ch(2, '他折好塞进公文包内层。'))[0]!
    expect(body.destination).toBe('body')
    expect(container.destination).toBe('container')
    // 类目是结构化的：换一个同义词仍落在同一类。
    expect(DESTINATION_PHRASES.body).toContain('内襟')
    expect(DESTINATION_PHRASES.body).toContain('袖里')
    expect(DESTINATION_PHRASES.container).toContain('公文包')
  })

  it('requires a destination — 「折回船工间」is walking back, not stowing', () => {
    // 真实语料实测的假阳性：只要求「折 + 收纳动词同句」时命中过
    // 「周叙把叶子夹进票根里，折回船工间」——「折回」是走回去，
    // 「夹进票根里」的目的地是别的纸而不是存放处。三要素缺一不可。
    expect(handoverHits(ch(3, '周叙把叶子夹进票根里，折回船工间，打算再清一清账本。'))).toEqual([])
  })

  it('does not count a plain hand-off as a stowing action', () => {
    // 「交给/递给」是**转手**不是**收纳**，混进来会把正常交接算成公式（那正是 #38 的领域）。
    expect(STOW_ACTIONS).not.toContain('交给')
    expect(STOW_ACTIONS).not.toContain('递给')
    expect(handoverHits(ch(1, '他把纸折好，交给柯明远。'))).toEqual([])
  })

  it('recognizes every folding variant through the 折 stem rather than enumerating them', () => {
    // 那本书实测有 9 种变体（折好/对折/折回/折两折/折成四折/折起/折齐…）——
    // 枚举变体会被作者换个补语绕过。
    for (const form of ['折好', '对折', '折两折', '折成四折', '折起', '折齐', '折了一下']) {
      expect(handoverHits(ch(1, `他把纸${form}，塞进内襟。`)).length).toBe(1)
    }
  })
})

describe('findHandoverConvergence (issue #95)', () => {
  /** 造一本「每章都折好塞进同一类目的地」的书。 */
  const formulaic = Array.from({ length: 12 }, (_, index) => ch(index + 1,
    `他把${index % 2 === 0 ? '存根' : '票根'}折两折，塞进内襟。他站着没动。`))

  it('reports a handover formula once it covers a third of the chapters', () => {
    const hits = findHandoverConvergence(formulaic)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.chapters.length).toBe(12)
    expect(hits[0]!.chapterTotal).toBe(12)
    expect(hits[0]!.dominantDestination).toBe('body')
  })

  it('names the destination class in a way the author can act on', () => {
    expect(DESTINATION_LABELS.body.zhCN).toContain('内襟')
    expect(DESTINATION_LABELS.container.enUS).toContain('briefcase')
  })

  it('reports the distribution across destination classes', () => {
    const mixed = [
      ...Array.from({ length: 6 }, (_, index) => ch(index + 1, '他折好，塞进内襟。')),
      ...Array.from({ length: 4 }, (_, index) => ch(index + 7, '他对折，塞进公文包。')),
      ...Array.from({ length: 2 }, (_, index) => ch(index + 11, '他折起，塞进风灯罩。')),
    ]
    const [hit] = findHandoverConvergence(mixed)
    expect(hit!.byDestination.map(item => item.destination).sort()).toEqual(['body', 'container', 'place'])
    expect(hit!.sentenceCount).toBe(12)
  })

  it('stays silent when the handover varies chapter to chapter', () => {
    const varied = Array.from({ length: 12 }, (_, index) => ch(index + 1, [
      '他把纸压在水盂底下。',
      '他把纸锁进抽屉。',
      '他当众把纸烧了。',
      '他把纸撕成两半。',
      '他把纸交给柯明远。',
      '他把纸钉在舱板上。',
      '纸被水洇透了。',
      '他把纸塞进别人手里。',
      '他折好，塞进内襟。',
      '他把纸揉成一团。',
      '他把纸留在原处。',
      '他把纸按在桌面上。',
    ][index]!))
    expect(findHandoverConvergence(varied)).toEqual([])
  })

  it('requires the minimum chapter count before judging', () => {
    expect(findHandoverConvergence(formulaic.slice(0, 5))).toEqual([])
  })

  it('does not fire when only a few chapters use the formula', () => {
    const sparse = [
      ...formulaic.slice(0, 3),
      ...Array.from({ length: 20 }, (_, index) => ch(index + 4, '船开了。别的事在发生。')),
    ]
    expect(findHandoverConvergence(sparse)).toEqual([])
  })

  it('keeps the key stable as the book advances (issues #86/#89)', () => {
    const [before] = findHandoverConvergence(formulaic)
    const [after] = findHandoverConvergence([...formulaic, ch(13, '他折好，塞进内襟。')])
    // 判据本身不产出 key（由 findings 层拼装）；这里断言它给的**身份**不随章号漂：
    // 同一套动作、同一主导目的地 → 同一个 key 素材。
    expect(before!.dominantDestination).toBe(after!.dominantDestination)
  })
})
