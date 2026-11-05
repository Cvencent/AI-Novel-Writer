import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ULTIMATUM_STREAK_MIN,
  blueprintClosingClaim,
  chapterEndingProfile,
  closingLabelConflicts,
  closingParagraph,
  closesInsideDialogue,
  hasDialogue,
  isUltimatumLine,
  ultimatumStreak,
} from '../chapter-ending'

describe('closingParagraph / hasDialogue / closesInsideDialogue', () => {
  it('takes the last non-empty block', () => {
    expect(closingParagraph('第一段。\n\n第二段。\n\n  \n')).toBe('第二段。')
  })

  it('detects dialogue in CJK and straight quotes', () => {
    expect(hasDialogue('他说：“走吧。”')).toBe(true)
    expect(hasDialogue('他抬头看向门口。')).toBe(false)
  })

  it('only treats a sentence as a dialogue close when it ends inside the quote', () => {
    expect(closesInsideDialogue('“那你今晚别下船。”')).toBe(true)
    expect(closesInsideDialogue('柯明远说：“今夜停航。”')).toBe(true)
    expect(closesInsideDialogue('周叙没回头，只把箱子往怀里按紧了些。')).toBe(false)
  })
})

describe('chapterEndingProfile', () => {
  it('reports a chapter that closes inside dialogue', () => {
    const profile = chapterEndingProfile(25, '他把签收联叠好。\n\n温珩把最后一圈绳从桩上抹下来：“那你今晚别下船。”')
    expect(profile).toMatchObject({ chapterNumber: 25, closesOnDialogue: true })
  })

  it('does not call a chapter a dialogue close when the line sits before the final action', () => {
    // 本样本第 20 章的形态：对白在倒数第二句，最后收在动作上。
    const profile = chapterEndingProfile(20, '“箱子交回去。”柯明远说。\n\n周叙没回头，只把箱子往怀里按紧了些。')
    expect(profile.closesOnDialogue).toBe(false)
  })

  it('is not a dialogue close for empty content', () => {
    expect(chapterEndingProfile(1, '').closesOnDialogue).toBe(false)
  })
})

describe('isUltimatumLine (issue #66)', () => {
  it('recognises the conditional/threat closes from the report', () => {
    expect(isUltimatumLine('“不签，箱子当场扣下。今夜别想开船。”')).toBe(true)
    expect(isUltimatumLine('“那你今晚别下船。”')).toBe(true)
    expect(isUltimatumLine('“但这结我记着。”')).toBe(true)
    expect(isUltimatumLine('“但你泡了，它就化了。”')).toBe(true)
    // ch15：把决定压给对方（「你替我上」）。
    expect(isUltimatumLine('“明晚我不上船了。”他说，“你替我上。”')).toBe(true)
  })

  it('does not flag ordinary dialogue closes', () => {
    expect(isUltimatumLine('“没事。”')).toBe(false)
    expect(isUltimatumLine('“路上小心。”')).toBe(false)
    expect(isUltimatumLine('“我们明天再说。”')).toBe(false)
  })

  it('does not flag everyday words that merely look like threats', () => {
    // 纯词表会把这三个全判成威胁；负向前瞻把它们挡掉（本仓 #30/#43 的教训）。
    expect(isUltimatumLine('“别人都不知道。”')).toBe(false)
    expect(isUltimatumLine('“他特别高兴。”')).toBe(false)
    expect(isUltimatumLine('“你替我高兴吗？”')).toBe(false)
  })

  it('does not flag narration that merely contains a threat word', () => {
    // 没有台词的「别想」不算通牒式台词收尾。
    expect(isUltimatumLine('他别想再上这条船了。')).toBe(false)
  })

  it('judges only the spoken content, not the attribution around it', () => {
    expect(isUltimatumLine('柯明远把笔收回去：“你父亲当年的位置，也是这么空出来的。”')).toBe(false)
  })
})

describe('blueprintClosingClaim / closingLabelConflicts (issue #65)', () => {
  const dialogueChapter = chapterEndingProfile(25, '他抬头。\n\n“那你今晚别下船。”')
  const proseChapter = chapterEndingProfile(16, '周叙没回头，只把箱子往怀里按紧了些。')

  it('maps comparable labels and leaves unverifiable ones out', () => {
    expect(blueprintClosingClaim('对话收束')).toBe('dialogue')
    expect(blueprintClosingClaim('物件落幅')).toBe('prose')
    expect(blueprintClosingClaim('人物动作收束')).toBe('prose')
    expect(blueprintClosingClaim('悬念直陈')).toBeNull()
    expect(blueprintClosingClaim('内心独白')).toBeNull()
    expect(blueprintClosingClaim('')).toBeNull()
  })

  it('flags the reported 7-of-10 mismatches', () => {
    // ch25：蓝图写「物件落幅」，正文收在温珩的警告台词上。
    expect(closingLabelConflicts('物件落幅', dialogueChapter)).toBe(true)
    // ch20：蓝图写「对话收束」，正文收在动作上。
    expect(closingLabelConflicts('对话收束', proseChapter)).toBe(true)
  })

  it('does not flag when label and prose agree', () => {
    expect(closingLabelConflicts('物件落幅', proseChapter)).toBe(false)
    expect(closingLabelConflicts('对话收束', dialogueChapter)).toBe(false)
  })

  it('never flags a label it cannot verify', () => {
    expect(closingLabelConflicts('悬念直陈', dialogueChapter)).toBe(false)
    expect(closingLabelConflicts('悬念直陈', proseChapter)).toBe(false)
  })
})

describe('ultimatumStreak (issue #66)', () => {
  const at = (chapterNumber: number, content: string) => chapterEndingProfile(chapterNumber, content)

  it('flags three consecutive chapters that all close on a conditional threat', () => {
    const streak = ultimatumStreak([
      at(23, '“但你泡了，它就化了。”'),
      at(24, '“不签，箱子当场扣下。今夜别想开船。”'),
      at(25, '“那你今晚别下船。”'),
    ])
    expect(streak.map(item => item.chapterNumber)).toEqual([23, 24, 25])
  })

  it('does not flag two in a row', () => {
    expect(ultimatumStreak([at(24, '“今夜别想开船。”'), at(25, '“那你今晚别下船。”')])).toEqual([])
  })

  it('breaks the streak on a chapter that closes differently', () => {
    expect(ultimatumStreak([
      at(23, '“但你泡了，它就化了。”'),
      at(24, '周叙没回头，只把箱子往怀里按紧了些。'),
      at(25, '“那你今晚别下船。”'),
    ])).toEqual([])
  })

  it('treats a chapter number gap as a break, not a chain', () => {
    expect(ultimatumStreak([
      at(10, '“别想走。”'),
      at(12, '“别想走。”'),
      at(13, '“别想走。”'),
    ])).toEqual([])
  })

  it('does not treat benign dialogue closes as ultimatums', () => {
    expect(ultimatumStreak([
      at(1, '“没事。”'),
      at(2, '“我们明天再说。”'),
      at(3, '“路上小心。”'),
    ])).toEqual([])
  })

  it('requires the configured minimum', () => {
    const two = [at(1, '“别想走。”'), at(2, '“别想走。”')]
    expect(ultimatumStreak(two)).toEqual([])
    expect(ultimatumStreak(two, 2)).toHaveLength(2)
    expect(ULTIMATUM_STREAK_MIN).toBe(3)
  })
})

/**
 * issue #66 的诉求（让模型看见最近几章的钩子分布并轮换）保留；
 * issue #163 把**实现方式**换了：原来由规则用三张短语表给钩子**贴形态标签**
 * （ultimatum / deadline / revelation / decision）——那是内容判断。
 *
 * 现在直接把 `suspenseHook` **原文**交给模型，形态由它自己看：
 * 少一次规则判断，也多一分信息（标签会丢掉措辞）。
 *
 * 所以这条测试断言的是「规则侧不再有这一类分类器」，而不是换个词表接着测。
 */
describe('钩子形态交给模型看原文 (issue #66 / #163)', () => {
  it('no longer exports a rule-based hook classifier', async () => {
    const module = await import('../chapter-ending')
    expect('hookFormOf' in module).toBe(false)
    expect('HOOK_FORM_TEXT' in module).toBe(false)
  })

  it('the directory prompt carries the hook text itself, not a computed label', () => {
    // 源码断言：prompt 里出现的是 suspenseHook 原文，而不是 HOOK_FORM_TEXT[...] 这种标签查表。
    const source = readFileSync(join(__dirname, '..', '..', 'services', 'workflows', 'commands', 'directory.command.ts'), 'utf8')
    expect(source).toContain('hookForm: chapter.suspenseHook || undefined')
    expect(source).not.toContain('HOOK_FORM_TEXT[')
  })
})
