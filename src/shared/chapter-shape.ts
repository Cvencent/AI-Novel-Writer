/**
 * 章节形态检测：识别「又是同一套流程」这类结构重复。
 *
 * 背景：作者项目里第 150–508 章连续 350 多章沿用
 * 「清晨对账 → 补两条遗忘 → 某人蹲点 → 回报线索 → 匿名提示」同一模板，
 * 人物退化为功能符号。此模块给出可判定的重复信号。
 */
export interface ChapterShape {
  /** 开场动作词，例如「对账」「醒来」「抵达」。 */
  opening: string
  /** 章节中反复出现的固定角色名（按出现次数排序）。 */
  recurringCast: string[]
  /** 结构指纹：把正文切成若干段，用每段首词构成。 */
  skeleton: string
}

const OPENING_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/清晨(?:对账|核对|点验)/u, 'morning-ledger'],
  [/^(?:入夜|夜里|当晚)/u, 'night'],
  [/^(?:次日|翌日|第[一二三四五六七八九十]+天)/u, 'next-day'],
  [/^(?:清晨|早上|上午)/u, 'morning'],
]

/** 从一章正文抽取形态。 */
export function extractChapterShape(block: string, knownCharacterNames: readonly string[]): ChapterShape {
  const body = blockToBody(block)
  const opening = OPENING_PATTERNS.find(([pattern]) => pattern.test(body.trim()))?.[1] ?? 'other'
  const recurringCast = knownCharacterNames
    .filter(name => name.trim().length >= 2)
    .map(name => ({ name, count: body.split(name).length - 1 }))
    .filter(item => item.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 4)
    .map(item => item.name)
  const skeleton = body
    .split(/\n+/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map(paragraph => paragraph.slice(0, 6))
    .join('|')
  return { opening, recurringCast, skeleton }
}

function blockToBody(block: string): string {
  const lines = block.replace(/\r\n?/gu, '\n').split('\n')
  const headingIndex = lines.findIndex(line => /^#{0,4}\s*第\s*\d+\s*章/u.test(line.trim()))
  return (headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines).join('\n').trim()
}

/**
 * 判定是否与最近几章形态重复。
 * 判定依据：开场形态相同，且固定班底高度重合。
 */
export function isShapeRepetitive(shape: ChapterShape, recentShapes: readonly ChapterShape[], window = 5): boolean {
  const tail = recentShapes.slice(-window)
  if (tail.length < window) return false
  if (shape.opening === 'other') return false
  const sameOpening = tail.filter(item => item.opening === shape.opening).length
  if (sameOpening < window) return false
  const castOverlap = tail.every(item => {
    const shared = item.recurringCast.filter(name => shape.recurringCast.includes(name))
    return shared.length >= 2 && shared.length >= Math.min(shape.recurringCast.length, item.recurringCast.length)
  })
  return castOverlap
}
