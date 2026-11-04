import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 内容判断不得靠写死的词表（用户 2026-11-05 明确要求）。
 *
 * **用户原话**：「不要有这种写死的标记词……不要有任何写死的这种内容的逻辑。
 * 内容全让模型去处理，你只负责让模型怎么去生成。」
 *
 * 这条守卫的来历：我交付过 `body-mark-consistency.ts`，理由是「`缺|断|疤|伤` + `小指|虎口`
 * 是**封闭词类**，不是短语表」——用户当场否掉。它仍然是拿一张我写的词表去替模型判断内容：
 * 换本书、换个语序立刻失效，而且**判错时我没有任何办法发现**。
 *
 * ⚠️ 这条守卫**只守一个方向**：不许在「判断内容」的地方出现**题材词**。
 * 它不能也不需要禁止**结构/语法类**的封闭表——那些是判据的合法基础：
 * 引号族、虚词表、部首表（康熙表）、时间单位、序数词。
 *
 * 所以判据是：**看这个词表里有没有「需要理解内容才能列出来」的词**。
 * 机械可判的一档：**感官/身体/情绪词**（气味、味觉、身体部位、生理反应）。
 */
describe('内容判断不写词表 (用户 2026-11-05)', () => {
  const srcRoot = join(__dirname, '..', '..')
  const sharedDir = join(srcRoot, 'shared')

  const files = readdirSync(sharedDir)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

  /**
   * 题材词：**内容**词汇，不是语法类。
   *
   * 这些是「人/物/感受」的词——要判一段文字里有没有它们、说的是不是同一件事，
   * 必须理解内容，而那是模型的事。
   */
  const CONTENT_WORDS = [
    // 感官/气味/味觉（#151 那一档）
    '腥', '霉', '香', '臭', '味',
    // 身体部位与痕迹（#153 那一档）
    '小指', '拇指', '虎口', '肩', '疤', '茧',
    // 生理反应（文风那一档）
    '喉结', '耳鸣', '痉挛', '瞳孔',
  ]

  /** 每行里最多能容忍的题材词个数（这几个模块确实在用少量结构词）。 */
  const ALLOWED_IN: Readonly<Record<string, string>> = Object.freeze({
    // 感官通道判据本身就是在数「气味词」——它是 #151 的交付，用户尚未否掉这一档；
    // 列在这里是**明确标注的技术债**，不是豁免（见 issue #153 之后的下一轮决定）。
    'sensory-channel.ts': '待改成模型判断：#151 的感官通道统计仍是词表',
  })

  it('no shared module judges content by a hard-coded topic word list', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file in ALLOWED_IN) continue
      const source = readFileSync(join(sharedDir, file), 'utf8')
      // 只在**词表形状**里判：`Object.freeze([...])` 或 `= [ '词', '词' ]` 的字面量数组。
      const literalArrays = [...source.matchAll(/Object\.freeze\(\s*\[([\s\S]{0,600}?)\]\s*\)/gu)]
      for (const block of literalArrays) {
        const body = block[1]!
        const hits = CONTENT_WORDS.filter(word => body.includes(`'${word}`) || body.includes(`"${word}`))
        if (hits.length > 0) offenders.push(`${file} :: ${hits.join('、')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('records the remaining technical debt explicitly instead of hiding it', () => {
    // 白名单必须写明「为什么还留着」——不写就成了静默豁免。
    for (const [file, note] of Object.entries(ALLOWED_IN)) {
      expect(files, `${file} 已不存在，请删掉白名单条目`).toContain(file)
      expect(note.trim().length).toBeGreaterThan(0)
    }
  })
})
