/**
 * 清单件数对账（issue #133）。
 *
 * 现场：第 57 章贴出清库名单——「无编号薄本**六册**。靛蓝短褂**一件**。旧航次账抄件**一册**。」
 * （合计 8 件）；第 58 章筐里「**三样**东西码成一排：无编号薄本…；靛蓝短褂…；旧航次账抄件…」，
 * 化浆也只化一册，**其余五册全章 0 字交代**。
 *
 * 全仓此前**没有任何一处**做过这个比对：`numbering-consistency` 判「位」、`declared-character-count`
 * 判「个字」、物证类判「同一件物的消亡/复活/过手」，都不看「一批物的件数」。
 *
 * 两条判据，都只依赖正文自身写出的数字与枚举，不引词表：
 *
 * A. **同章**：声明 N 件，紧接着用冒号引出枚举 → 数枚举项，不等即报。
 *    （第 58 章「三样东西码成一排：A；B；C」正是它够得着的形态。）
 * B. **跨章**：前一章有一份**清单**（同一段里 ≥2 条「<名词>+<数量>+<量词>」）→ 合计件数；
 *    后一章在窗口内出现按同一批物枚举的「<N>样 …：A；B；C」→ 项数；两者不等即报。
 *    （第 57 章 8 件 → 第 58 章 3 件，差额 5 件全章未交代。）
 *
 * ⚠️ 三条收窄，都是为了避免制造假阳性：
 * 1. **只认后置计数**「<名词><数量><量词>」（清单写法：「薄本六册」）。前置的「一张纸」「三样东西」
 *    不是清单条目——「一张纸」是那张告示本身，算进去会把第 57 章的 8 件虚增到 9 件。
 * 2. **清单要求同一段里至少两条**：只有一条计数的句子是普通叙述（「他拿了两张」），不是清单。
 * 3. **枚举项必须与本批清单的物能对上**（逐项取前缀在清单原文里能找到）。对不上就说明
 *    这枚举的不是同一批东西（可能是另一摊货），一律不报。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 清单可用的量词（封闭类）。
 *
 * 刻意**不收**「个/位/名」：它们同时是最泛的计数词，「一个人」「三个」满篇都是，
 * 收进来会让「同段 ≥2 条计数」这条门槛形同虚设。这里只收**清点具体物件**时用的量词。
 */
const ITEM_MEASURE = '册件本张条份样只幅枚支把'

const MEASURE_CHARS = `[${ITEM_MEASURE}]`
const CHINESE_NUM = '[一二两三四五六七八九十百千万半]+'

/** 后置计数：「无编号薄本六册」「靛蓝短褂一件」——名词在前，数量在后。 */
const POSTFIX_COUNT = new RegExp(`([\\u4e00-\\u9fff]{2,8}?)(\\d+|${CHINESE_NUM})\\s*(${MEASURE_CHARS})(?![\\u4e00-\\u9fff])`, 'gu')
/** 前置计数 + 冒号引出枚举：「三样东西码成一排：A；B；C」。 */
const ENUMERATION = new RegExp(
  `(\\d+|${CHINESE_NUM})\\s*(${MEASURE_CHARS})[^。！？\\n：:]{0,12}[：:]\\s*([^。！？\\n]+)`,
  'gu',
)

const NUMERALS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5,
}

function numeralOf(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value)
  if (value.length === 1) return NUMERALS[value] ?? null
  const match = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(value)
  if (!match) return null
  return (match[1] ? NUMERALS[match[1]]! : 1) * 10 + (match[2] ? NUMERALS[match[2]]! : 0)
}

interface Enumeration {
  declared: number
  items: string[]
  sentence: string
  index: number
}

/** 一段里「N + 量词 + 冒号 + A；B；C」的枚举（同一句内、按分号切项）。 */
function enumerationsIn(content: string): Enumeration[] {
  const found: Enumeration[] = []
  for (const match of String(content ?? '').matchAll(ENUMERATION)) {
    const declared = numeralOf(match[1]!)
    if (declared === null || declared < 2) continue
    const body = match[3] ?? ''
    // 按分号切；没有分号的枚举不是「清单式枚举」（可能只是「三样东西：A」）。
    const items = body.split(/[；;]/u).map(item => item.trim()).filter(Boolean)
    if (items.length < 2) continue
    found.push({ declared, items, sentence: match[0].trim(), index: match.index ?? 0 })
  }
  return found
}

/** 同一段里 ≥2 条后置计数的合计件数（清单）。 */
function inventoryTotals(content: string): Array<{ total: number; text: string; index: number }> {
  const totals: Array<{ total: number; text: string; index: number }> = []
  let offset = 0
  for (const paragraph of String(content ?? '').split(/\n+/u)) {
    const start = offset
    offset += paragraph.length + 1
    const entries: number[] = []
    for (const match of paragraph.matchAll(POSTFIX_COUNT)) {
      const count = numeralOf(match[2]!)
      if (count === null || count < 1) continue
      entries.push(count)
    }
    if (entries.length < 2) continue
    totals.push({ total: entries.reduce((sum, value) => sum + value, 0), text: paragraph.trim(), index: start })
  }
  return totals
}

/** 枚举项是否属于这份清单：逐项取 2..6 字的前缀，能在清单原文里找到即算。 */
function belongsToInventory(items: readonly string[], inventoryText: string): boolean {
  return items.every(item => {
    const cleaned = item.replace(/^[\s「『“"]+|[\s」』”"]+$/gu, '').trim()
    if (cleaned.length < 2) return false
    for (let length = Math.min(6, cleaned.length); length >= 2; length -= 1) {
      if (inventoryText.includes(cleaned.slice(0, length))) return true
    }
    return false
  })
}

export interface InventoryChapters {
  chapterNumber: number
  content: string
}

/**
 * A. 同章：声明 N 件，紧随其后的枚举只有 M 项。
 *
 * 只在「枚举项数 ≥2」时判——单个物的一句话叙述（「三样东西里只领了一件」）不是清单对账。
 */
export function findEnumerationCountMismatches(chapter: InventoryChapters): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  for (const enumeration of enumerationsIn(chapter.content)) {
    const actual = enumeration.items.length
    if (actual === enumeration.declared) continue
    findings.push({
      // 章号是为问题章号（既成事实），不随写作推进而变。
      stableFactKey: `inventory:enumeration:${chapter.chapterNumber}:${enumeration.declared}:${actual}`,
      severity: 'warning' as const,
      sourceChapter: chapter.chapterNumber,
      evidence: `第${chapter.chapterNumber}章：「${enumeration.sentence.slice(0, 60)}」——声明 ${enumeration.declared} 项，实际列出 ${actual} 项`,
      issue: {
        zhCN: `这里声明「${enumeration.declared} 项」，紧随其后的枚举却只有 ${actual} 项。清单式的数字是读者清点物证的依据，对不上会让读者回头数一遍。`,
        enUS: `This lists ${enumeration.declared} items but enumerates only ${actual}. Readers count along with an inventory, so a mismatch sends them back to recount.`,
      },
      suggestion: {
        zhCN: `二者改成一致：把声明改成 ${actual} 项，或把缺的那几项补进枚举。`,
        enUS: `Make them agree: state ${actual} items, or add the missing ones to the list.`,
      },
    })
  }
  return findings
}

/**
 * B. 跨章：前一章的清单合计 N 件，后一章按同一批物枚举只给出 M 件。
 *
 * 窗口默认 3 章（清单到兑现通常紧挨着；隔得远时读者早已不把它当同一批）。
 */
export function findInventoryShortfallFindings(
  chapters: readonly InventoryChapters[],
  options: { window?: number } = {},
): ConsistencyFinding[] {
  const window = options.window ?? 3
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  const findings: ConsistencyFinding[] = []
  for (const [index, chapter] of ordered.entries()) {
    for (const inventory of inventoryTotals(chapter.content)) {
      for (const later of ordered.slice(index + 1)) {
        if (later.chapterNumber - chapter.chapterNumber > window) break
        for (const enumeration of enumerationsIn(later.content)) {
          if (!belongsToInventory(enumeration.items, inventory.text)) continue
          const actual = enumeration.items.length
          if (actual === inventory.total) continue
          findings.push({
            // key 取「清单章 + 兑现章」，两者都是既成事实。
            stableFactKey: `inventory:shortfall:${chapter.chapterNumber}:${later.chapterNumber}`,
            severity: 'warning' as const,
            sourceChapter: later.chapterNumber,
            evidence: `第${chapter.chapterNumber}章清单合计 ${inventory.total} 件（「${inventory.text.slice(0, 50)}」），第${later.chapterNumber}章只列出 ${actual} 项（「${enumeration.sentence.slice(0, 50)}」）`,
            issue: {
              zhCN: `清单件数对不上：第 ${chapter.chapterNumber} 章那份清单合计 ${inventory.total} 件，第 ${later.chapterNumber} 章按同一批物只摆出 ${actual} 项，差 ${Math.abs(inventory.total - actual)} 件，且这几章里没有一句交代差额去了哪儿。清单式数字是读者清点筹码的依据，少掉的那几件会让读者以为自己漏读。`,
              enUS: `The inventory does not add up: chapter ${chapter.chapterNumber} lists ${inventory.total} items in total, but chapter ${later.chapterNumber} lays out only ${actual} of the same batch — ${Math.abs(inventory.total - actual)} unaccounted for, with no sentence in between explaining where they went.`,
            },
            suggestion: {
              zhCN: `二选一：把差额的去向写出来（「其余 ${Math.abs(inventory.total - actual)} 件已先化」「只准领这几样，余下封存」），或把清单的件数改成与后文一致。别让读者自己补这个空。`,
              enUS: `Either state where the difference went ("the other ${Math.abs(inventory.total - actual)} were already pulped", "only these may be collected, the rest sealed"), or change the inventory count to match. Do not leave readers to fill the gap.`,
            },
          })
        }
      }
    }
  }
  return findings
}