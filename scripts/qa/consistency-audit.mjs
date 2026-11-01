/**
 * 只读一致性检查器：拷一份项目库到临时目录再读，绝不碰原库。
 *
 * 目的：抓「第2章沈砚穿白风衣、第4章变灰风衣」这类**文字性矛盾**——
 * 用户一眼能看出来的漂移。做法不是让模型自由发挥，而是把每章的原文摊开，
 * 用可复现的规则先抓「同一实体 + 同一属性 + 多值」的硬冲突，
 * 再把候选证据交给模型判断，模型只负责在候选里指认，不负责大海捞针。
 *
 * 用法：
 *   node scripts/qa/consistency-audit.mjs --project "F:\yuanqi\源起" [--json out.json]
 *   node scripts/qa/consistency-audit.mjs --project "<path>" --llm   # 加模型判定（走 8790）
 *
 * 输出分两类：
 *   findings[]  规则确认的硬冲突（同一角色同一属性在不同章节出现互斥描述）
 *   suspects[]  需要模型/人复核的候选（属性词首次出现、服饰颜色变化等）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const PROJECT_DB = path.join('.ai-novel', 'project.db')

/** 服饰/外貌类属性词：命中这些词才算描述「外观状态」，避免把动作当属性。 */
const APPEARANCE_VOCAB = [
  // 上衣
  '白大褂', '风衣', '外套', '夹克', '大衣', '校服', '制服', '作战服', '训练服', '外勤服', '罩衫', '开衫', '衬衫', '卫衣', '披风', '袍子', '长袍', '工装',
  // 下装与配件
  '长裤', '短裤', '裙子', '围巾', '披肩', '帽子', '斗篷', '护腕', '手环', '面具', '头盔',
  // 颜色：常见复合色入词表（其余组合靠语素扫描兜底），让「靛蓝短褂」这类
  // 颜色即服饰的写法也能定位衣着词。
  '白色', '黑色', '灰色', '深灰', '浅灰', '银灰', '蓝色', '深蓝', '浅蓝', '红色', '暗红', '青色', '绿色', '墨绿', '黄色', '紫色', '棕色', '米色', '藏青', '卡其',
  '靛蓝', '月白', '黛青', '赭黄', '绯红', '玄色', '洗白', '泛白', '泛黄',
]

/** 只描述身体/装备状态的词，和外观分开归类，但同样追踪跨章一致性。 */
const STATE_VOCAB = ['受伤', '断臂', '拄拐', '坐轮椅', '昏迷', '失明', '失聪', '长发', '短发', '秃顶', '满脸血', '包扎', '吊着胳膊', '瘸']

const ATTRIBUTE_GROUPS = [
  { key: 'outfit', label: '衣着', vocab: APPEARANCE_VOCAB },
  { key: 'body', label: '身体状态', vocab: STATE_VOCAB },
]

function parseCli() {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      json: { type: 'string' },
      llm: { type: 'boolean', default: false },
      'max-chapters': { type: 'string' },
      quiet: { type: 'boolean', default: false },
    },
  })
  if (!values.project) {
    console.error('用法: node scripts/qa/consistency-audit.mjs --project "<作品目录>" [--json out.json] [--llm]')
    process.exit(2)
  }
  return {
    project: path.resolve(values.project),
    json: values.json ? path.resolve(values.json) : null,
    llm: values.llm,
    maxChapters: values['max-chapters'] ? Number(values['max-chapters']) : Infinity,
    quiet: values.quiet,
  }
}

/**
 * 把 source 拷到临时目录再打开。原库可能有 WAL 未合并，所以 -wal/-shm 一起拷，
 * 拷贝用 readOnly 打开，物理上不可能写回用户数据。
 */
function snapshotDatabase(projectDir) {
  const source = path.join(projectDir, PROJECT_DB)
  if (!fs.existsSync(source)) throw new Error(`找不到项目库: ${source}`)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovel-qa-'))
  const target = path.join(tempRoot, 'project.db')
  fs.copyFileSync(source, target)
  for (const suffix of ['-wal', '-shm']) {
    const from = source + suffix
    if (fs.existsSync(from)) fs.copyFileSync(from, target + suffix)
  }
  const db = new DatabaseSync(target, { readOnly: true })
  return { db, tempRoot, source }
}

function tableExists(db, name) {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name))
}

/** 每章权威正文：已定稿优先，否则取最高版本。正文在 contents.body。 */
function loadChapters(db) {
  const rows = db.prepare(`
    select d.chapter_number as chapterNumber, d.version as version, d.status as status,
           d.word_count as wordCount, c.body as body
    from drafts d
    join contents c on c.id = d.content_id
    order by d.chapter_number asc, d.version asc
  `).all()
  const byChapter = new Map()
  for (const row of rows) {
    const current = byChapter.get(row.chapterNumber)
    const better = !current
      || (row.status === 'finalized' && current.status !== 'finalized')
      || (row.status === current.status && row.version > current.version)
    if (better) byChapter.set(row.chapterNumber, { ...row })
  }
  return [...byChapter.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
}

function loadCharacters(db) {
  const hasIdentity = tableExists(db, 'character_identity_meta')
  const sql = hasIdentity
    ? 'select * from characters where retired=0'
    : 'select * from characters'
  return db.prepare(sql).all()
}

/**
 * 颜色识别按「语素」而不是有限全词表：靛蓝/月白/墨绿/赭黄这类复合色写不完，
 * 全词表漏一个就静默假阴性（issue #9 实测「洗白的靛蓝短褂」0 命中却报「无冲突」）。
 *
 *  - hue：固定颜色。色语素与修饰字组合成 2 字词面（靛蓝、月白、深灰、墨绿……），参与跨章互斥判定。
 *  - faded：状态色。「泛白/发白/洗得发白/褪色/磨白/泛黄」这类**变化**描述，
 *    不参与互斥——「洗得发白的靛蓝短褂」仍是靛蓝系，把 faded 与 hue 互判必然误报。
 */
const COLOR_MORPHS = '白黑灰蓝红青绿黄紫棕米银墨赤绯黛褐橙粉金赭靛'
const COLOR_MODIFIERS = '月深浅暗亮玉象牙雪天湖玄嫩老淡浓'
const HUE_COLOR_CHARS = COLOR_MORPHS + COLOR_MODIFIERS
const HUE_COLOR = new RegExp(`[${HUE_COLOR_CHARS}]{2}(?![${HUE_COLOR_CHARS}色])|[${COLOR_MORPHS}]色(?![色])`, 'gu')
const FADED_COLORS = ['泛白', '发白', '洗白', '褪色', '褪得', '泛黄', '发黄', '发黑', '磨白', '洗得发白', '洗得泛白', '洗得发黄', '洗得泛黄']
const FADED_CHANGE_PREFIX = /(?:洗得|染得|褪得|磨得)?(?:洗|褪|泛|磨|变|染|发)(?:得|成了?)?/u
const COLOR_ADJ = ['白色', '黑色', '灰色', '深灰', '浅灰', '银灰', '蓝色', '深蓝', '浅蓝', '红色', '暗红', '青色', '绿色', '墨绿', '黄色', '紫色', '棕色', '米色', '藏青', '卡其']
const COLOR_CHARS = HUE_COLOR_CHARS

/** 收集一段文本里出现的固定色（hue）词面，如「靛蓝」「月白」「深灰」。 */
function scanHueColors(text) {
  return [...new Set([...text.matchAll(HUE_COLOR)].map(match => match[0]))]
}

/** 收集状态色（faded）词面；变化动词头可以隔着「得」出现，如「洗得发白」。 */
function scanFadedColors(text) {
  const colors = new Set()
  for (const word of FADED_COLORS) {
    if (text.includes(word)) colors.add(word)
  }
  return [...colors]
}

/**
 * 按段落切分并记录「这一段的属性描写归谁」。
 *
 * 真实写法里名字与衣着常常分在两句：
 *   「沈砚早已站在靠柱子的阴影里。他身上那件外勤风衣洗得泛黄，……」
 * 所以不能要求同句共现。规则是：
 *   1. 段内出现角色名 → 该段属性描写归最后出现的那个角色（一段里通常只有一个）；
 *   2. 段内没有角色名，但出现「他/她/那人/对方/身上」这类回指 → 归上一段最后被点名的角色；
 *   3. 段内既没名字也没回指 → 丢弃（无法归属，宁漏不误报）。
 * 这条规则会把「转折段落里别人换了衣服」也归到上一段的人身上，属于已知的近似，
 * 因此硬冲突仍要求人工/模型确认，规则层只负责把证据摆出来。
 */
const PRONOUN_CARRIERS = ['他身上', '她身上', '那道身影', '对方', '那人', '这人', '身影', '穿着', '换了件', '换上']

function splitParagraphs(body) {
  return body
    .split(/\n\s*\n|\n/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
}

/**
 * 颜色必须与衣着词**紧邻**才算衣着取色。
 * 只看段落共现会把「红色的实时通知」「黑色的导能模块」「指关节微微泛白」都算成人物衣着，
 * 所以这里校验中间只允许修饰成分：不含标点、不含第二个颜色词、不含其他衣着名词。
 * 用否定式而不是白名单，否则「洗得泛白的九班制式风衣」这种带专属名词的定语会被漏掉。
 */
const PUNCTUATION = /[。！？，、；：\n\r“”「」（）()]/u
// 前缀匹配，不能带 $ —— 带了就只匹配空串，「风衣洗得泛黄」的补语会被整条漏掉。
const POSTFIX_LEAD = /^(?:洗得|染成|改成|换成|穿成|变成|已经|早就|依旧|仍然|也|都|很|略微|微微|有些|显得|透着|泛着)/u

/**
 * 衣着词邻域内的颜色取值。
 * 返回 { hues, faded }：hues 参与跨章互斥，faded 只作证据。
 * 邻域里同时命中 hue 与 faded（「洗白的靛蓝短褂」「靛蓝短褂洗得发白」）不算冲突——
 * 状态色描述的是同一件衣服的变化，不是另一件不同色的衣服。
 */
function outfitColorFor(paragraph, word, at) {
  const before = paragraph.slice(Math.max(0, at - 16), at)
  const after = paragraph.slice(at + word.length, Math.min(paragraph.length, at + word.length + 10))
  const hues = new Set()
  const faded = new Set()

  // 词面本身就是颜色（「靛蓝短褂」「白色外勤服」）：颜色即衣着词，直接入账。
  for (const color of scanHueColors(word)) hues.add(color)
  for (const color of scanFadedColors(word)) faded.add(color)

  // 前置定语：「泛白的九班制式风衣」「深灰色作战服」「洗白的靛蓝短褂」
  for (const color of scanHueColors(before)) {
    const idx = before.lastIndexOf(color)
    const gap = before.slice(idx + color.length)
    const otherNounInGap = APPEARANCE_VOCAB.some(noun => gap.includes(noun))
    if (gap.length <= 10 && !PUNCTUATION.test(gap) && !otherNounInGap) hues.add(color)
  }
  for (const color of scanFadedColors(before)) {
    const idx = before.lastIndexOf(color)
    const gap = before.slice(idx + color.length)
    const otherNounInGap = APPEARANCE_VOCAB.some(noun => gap.includes(noun))
    if (gap.length <= 12 && !PUNCTUATION.test(gap) && !otherNounInGap) faded.add(color)
  }

  // 后置补语：「风衣洗得泛黄」「外套已经发黑」「靛蓝短褂洗得发白」
  // faded 词只要出现在衣着词后 12 字窗内且中间无标点即收——「短褂洗得发白」的
  // 状态色不在 startsWith 位置，硬要求开头会漏掉最常见的「衣着词+洗得+状态色」句式。
  const afterWindow = after.slice(0, 12)
  for (const color of scanHueColors(afterWindow.slice(0, 8))) {
    if (after.startsWith(color)) hues.add(color)
  }
  for (const color of scanFadedColors(afterWindow)) {
    const idx = afterWindow.indexOf(color)
    if (idx >= 0) {
      const gap = afterWindow.slice(0, idx)
      if (!PUNCTUATION.test(gap)) faded.add(color)
    }
  }

  // fading 直接替代色值（「褪成灰白」——裸动词+色，无其他固定色兜底）→ 归 faded。
  // 「洗白的靛蓝短褂」例外：hue 前面紧贴的是 FADED_COLORS 词（洗白/泛白），那是修饰关系，
  // 靛蓝仍是色值，保留 hue（洗白本身已单独记入 faded）。
  const window = before + word
  for (const hue of [...hues]) {
    const at2 = window.lastIndexOf(hue)
    if (at2 <= 0) continue
    const leadText = window.slice(Math.max(0, at2 - 5), at2)
    if (!FADED_CHANGE_PREFIX.test(leadText)) continue
    // 「洗白的/泛黄的」带结构助词「的」时是修饰定语，色值仍是该 hue 本身。
    if (FADED_COLORS.some(word2 => leadText.replace(/的$/u, '').endsWith(word2))) continue
    hues.delete(hue)
    faded.add(hue)
  }
  return { hues: [...hues].sort(), faded: [...faded].sort() }
}

/**
 * 真正的衣物名词（不是颜色）。issue #30 的反例是：
 *   「新底册的封面是深蓝硬布，边角压得平整。周叙翻开内页」
 * 段落里有名字、有颜色（深蓝），于是被记成「周叙的衣着色」——深蓝修饰的是布面，不是人。
 *
 * 修法：颜色本身不能证明「这是衣着描写」，必须附近有衣物名词。
 * 「靛蓝短褂 / 洗白的靛蓝短褂袖口 / 换了件月白长衫」都能满足；「深蓝硬布 / 白纸 / 铜盆」不满足。
 */
const GARMENT_NOUNS = [
  '白大褂', '风衣', '外套', '夹克', '大衣', '校服', '制服', '作战服', '训练服', '外勤服', '罩衫', '开衫',
  '衬衫', '卫衣', '披风', '袍子', '长袍', '长衫', '短褂', '马褂', '工装', '上衣', '衣襟', '衣摆', '衣角',
  '长裤', '短裤', '裙子', '围巾', '披肩', '帽子', '斗篷', '护腕', '手环', '面具', '头盔',
  '袖口', '袖筒', '领口', '肩章', '裤腿', '鞋面', '靴筒', '腰封', '腰带',
]

/** 衣物名词与颜色之间允许的距离（超过就认为两者不是同一处修饰关系）。 */
const GARMENT_PROXIMITY = 12

/** 颜色词附近是否有衣物名词（同一句内、无标点隔断）。 */
function hasGarmentNear(paragraph, at, length) {
  const sentenceStart = Math.max(
    paragraph.lastIndexOf('。', at) + 1,
    paragraph.lastIndexOf('！', at) + 1,
    paragraph.lastIndexOf('？', at) + 1,
  )
  const sentenceEnds = ['。', '！', '？']
    .map(mark => paragraph.indexOf(mark, at + length))
    .filter(index => index >= 0)
  const sentenceEnd = sentenceEnds.length ? Math.min(...sentenceEnds) : paragraph.length
  const windowStart = Math.max(sentenceStart, at - GARMENT_PROXIMITY)
  const windowEnd = Math.min(sentenceEnd, at + length + GARMENT_PROXIMITY)
  const window = paragraph.slice(windowStart, windowEnd)
  return GARMENT_NOUNS.some(noun => window.includes(noun))
}

/**
 * 段落内离这一处描写最近的角色名。issue #30 的另一个反例是「段落里最后一个名字」：
 * 温珩的短褂被记到在场的旁观者周叙名下。改为按命中位置就近归属，没有更近的再退回段末名。
 */
function nearestName(namedHere, paragraph, at) {
  let best = null
  let bestDistance = Infinity
  for (const name of namedHere) {
    let from = 0
    for (;;) {
      const index = paragraph.indexOf(name, from)
      if (index < 0) break
      from = index + name.length
      // 名字出现在描写之前优先（「温珩的靛蓝短褂」），出现在之后也算但距离加倍。
      const distance = index <= at ? at - index : (index - at) * 2
      if (distance < bestDistance) {
        best = name
        bestDistance = distance
      }
    }
  }
  return best
}

function extractMentions(chapters, characterNames) {
  const mentions = []
  const sortedNames = [...characterNames].sort((a, b) => b.length - a.length)

  for (const chapter of chapters) {
    const body = String(chapter.body ?? '')
    let carryOver = null

    for (const paragraph of splitParagraphs(body)) {
      const namedHere = sortedNames.filter(name => paragraph.includes(name))
      const carrier = namedHere.length
        ? namedHere[namedHere.length - 1]
        : (PRONOUN_CARRIERS.some(word => paragraph.includes(word)) ? carryOver : null)
      if (namedHere.length) carryOver = namedHere[namedHere.length - 1]
      if (!carrier) continue

      let outfitWordHit = false
      // 每处命中按「就近的名字」归属；段内没有更近的名字时退回段末名（原行为）。
      const perCarrier = new Map()
      const bucketFor = (name) => {
        if (!perCarrier.has(name)) perCarrier.set(name, { hues: new Set(), faded: new Set() })
        return perCarrier.get(name)
      }
      for (const word of APPEARANCE_VOCAB) {
        // 「泛白/泛黄/洗白」这类状态色也在词表里（颜色即服饰的写法），但它们不能
        // 自己证明「这是衣着描写」——否则「指关节微微泛白」就自我满足了。
        const wordIsColorish = scanHueColors(word).length > 0 || scanFadedColors(word).length > 0
        let from = 0
        for (;;) {
          const at = paragraph.indexOf(word, from)
          if (at < 0) break
          from = at + word.length
          // 颜色词必须紧邻衣物名词才算这件衣服的色（issue #30：深蓝硬布 → 不是衣着）。
          if (wordIsColorish && !hasGarmentNear(paragraph, at, word.length)) continue
          if (!wordIsColorish) outfitWordHit = true
          const found = outfitColorFor(paragraph, word, at)
          if (!found.hues.length && !found.faded.length) continue
          const owner = namedHere.length ? (nearestName(namedHere, paragraph, at) ?? carrier) : carrier
          const bucket = bucketFor(owner)
          for (const color of found.hues) bucket.hues.add(color)
          for (const color of found.faded) bucket.faded.add(color)
        }
      }
      // hue 是衣着取色的充分证据；faded（泛白/发白）只有在同一句里出现衣着词时才算衣着描写
      // ——「指关节微微泛白」也含 faded，但那不是衣着（issue 场景的防误报边界）。
      for (const [owner, bucket] of perCarrier) {
        if (!bucket.hues.size && !(bucket.faded.size && outfitWordHit)) continue
        mentions.push({
          chapter: chapter.chapterNumber,
          character: owner,
          attribute: 'outfit',
          attributeLabel: '衣着',
          namedInParagraph: namedHere.includes(owner),
          colors: [...bucket.hues].sort(),
          ...(bucket.faded.size ? { fadedColors: [...bucket.faded].sort() } : {}),
          sentence: paragraph.slice(0, 240),
        })
      }

      // 身体状态：不限颜色，记录命中的状态词。
      const bodyHits = STATE_VOCAB.filter(word => paragraph.includes(word))
      if (bodyHits.length) {
        mentions.push({
          chapter: chapter.chapterNumber,
          character: carrier,
          attribute: 'body',
          attributeLabel: '身体状态',
          namedInParagraph: namedHere.includes(carrier),
          colors: [],
          bodyStates: [...new Set(bodyHits)].sort(),
          sentence: paragraph.slice(0, 240),
        })
      }
    }
  }
  return mentions
}

/**
 * 硬冲突：同一角色、同一属性，不同章节的颜色取值集合互斥（交集为空且有多个非空集合）。
 * 只在颜色这一维判互斥——仅靠「风衣 vs 外套」这类同义词差异容易误报。
 */
function findConflicts(mentions) {
  const findings = []
  const groups = new Map()
  for (const mention of mentions) {
    const colors = mention.colors ?? []
    if (!colors.length) continue
    const key = `${mention.character}\u0000${mention.attribute}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ ...mention, colors: [...colors].sort() })
  }

  for (const [, items] of groups) {
    const byValue = new Map()
    for (const item of items) {
      const signature = item.colors.join('+')
      if (!byValue.has(signature)) byValue.set(signature, [])
      byValue.get(signature).push(item)
    }
    if (byValue.size < 2) continue
    // 交集为空才算互斥；「白色」与「白色+蓝色」属于同一描述。
    const signatures = [...byValue.keys()]
    const disjoint = signatures.every((a, i) => signatures.every((b, j) => i >= j
      || !a.split('+').some(v => b.split('+').includes(v))))
    if (!disjoint) continue
    const character = items[0].character
    const attribute = items[0].attribute
    const evidence = [...byValue.values()].flat().map(item => ({
      chapter: item.chapter,
      value: item.colors.join('+'),
      sentence: item.sentence,
    }))
    // 只有一次描写、且没有另一章可对照的，不算硬冲突（可能是首次确立设定）。
    const chapters = new Set(evidence.map(item => item.chapter))
    if (chapters.size < 2) continue
    findings.push({
      kind: 'conflict',
      character,
      attribute,
      attributeLabel: items[0].attributeLabel,
      summary: `${character}的${items[0].attributeLabel}在不同章节出现互斥描述：${signatures.join(' / ')}`,
      evidence,
    })
  }
  return findings
}

/** 候选：同一角色同一属性只出现过一次的颜色描述——后续章节可能漂移，值得复核。 */
function findSingleMentionSuspects(mentions) {
  const counts = new Map()
  for (const mention of mentions) {
    const colors = mention.colors ?? []
    if (!colors.length) continue
    const key = `${mention.character}\u0000${mention.attribute}\u0000${colors.join('+')}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count === 1)
    .map(([key]) => {
      const [character, attribute, value] = key.split('\u0000')
      return { character, attribute, value }
    })
}

/** 角色卡上的 appearance 与正文描述交叉核对：卡片说深灰，正文没提过，也可能是卡没更新。 */
function crossCheckCharacterCards(characters, mentions) {
  const issues = []
  for (const character of characters) {
    const appearance = String(character.appearance ?? '')
    if (!appearance.trim()) continue
    const cardColors = COLOR_ADJ.filter(word => appearance.includes(word))
    if (!cardColors.length) continue
    const inProse = mentions.filter(m => m.character === character.name && m.attribute === 'outfit')
    if (!inProse.length) {
      issues.push({
        kind: 'card-only',
        character: character.name,
        summary: `角色卡写了外貌（${cardColors.join('+')}），但正文里没有任何该角色的衣着描写`,
        cardAppearance: appearance.slice(0, 200),
      })
      continue
    }
    const proseColors = new Set(inProse.flatMap(m => m.colors ?? []))
    const missing = cardColors.filter(color => !proseColors.has(color))
    if (missing.length) {
      issues.push({
        kind: 'card-drift',
        character: character.name,
        summary: `角色卡写「${missing.join('+')}」，正文里的描写是「${[...proseColors].join('+') || '无颜色'}」`,
        cardAppearance: appearance.slice(0, 200),
        proseSamples: inProse.slice(0, 3).map(m => ({ chapter: m.chapter, sentence: m.sentence })),
      })
    }
  }
  return issues
}

/** 空缺：角色卡关键字段为空，后续章节没有可依据的锚点。 */
function findCardGaps(characters) {
  return characters
    .filter(character => !String(character.appearance ?? '').trim())
    .map(character => ({
      kind: 'card-gap',
      character: character.name,
      role: character.role,
      summary: `角色「${character.name}」的角色卡没有外貌字段，写正文时没有可依据的固定锚点`,
    }))
}

function main() {
  const options = parseCli()
  const { db, tempRoot, source } = snapshotDatabase(options.project)
  const log = (...args) => { if (!options.quiet) console.log('[qa]', ...args) }

  try {
    const chapters = loadChapters(db).slice(0, options.maxChapters === Infinity ? undefined : options.maxChapters)
    const characters = loadCharacters(db)
    const characterNames = characters.map(c => String(c.name)).filter(Boolean)

    log(`快照 ${source}`)
    log(`章节 ${chapters.length} 章，角色 ${characters.length} 人`)

    const mentions = extractMentions(chapters, characterNames)
    const conflicts = findConflicts(mentions)
    const cardIssues = [...crossCheckCharacterCards(characters, mentions), ...findCardGaps(characters)]
    const suspects = findSingleMentionSuspects(mentions)

    const report = {
      generatedAt: new Date().toISOString(),
      project: options.project,
      chapters: chapters.map(c => ({ chapterNumber: c.chapterNumber, status: c.status, version: c.version, words: c.wordCount })),
      findings: conflicts,
      cardIssues,
      suspects,
      stats: {
        mentions: mentions.length,
        conflicts: conflicts.length,
        cardIssues: cardIssues.length,
        // 按「角色×属性」聚合的命中数：0 命中与「真无冲突」在报告上一眼可分（issue #9）。
        mentionsByAttribute: (() => {
          const byAttribute = {}
          for (const mention of mentions) {
            const key = `${mention.character}×${mention.attributeLabel}`
            byAttribute[key] = (byAttribute[key] ?? 0) + 1
          }
          return Object.fromEntries(Object.entries(byAttribute).sort(([a], [b]) => a.localeCompare(b)))
        })(),
      },
    }

    if (options.json) {
      fs.mkdirSync(path.dirname(options.json), { recursive: true })
      fs.writeFileSync(options.json, JSON.stringify(report, null, 2))
      log(`报告写入 ${options.json}`)
    }

    if (!options.quiet) {
      console.log('')
      if (conflicts.length) {
        console.log(`✗ ${conflicts.length} 条硬冲突`)
        for (const item of conflicts) {
          console.log(`  • ${item.summary}`)
          for (const ev of item.evidence.slice(0, 4)) console.log(`      第${ev.chapter}章 [${ev.value}] ${ev.sentence.slice(0, 90)}`)
        }
      } else {
        const outfitMentions = mentions.filter(mention => mention.attribute === 'outfit').length
        if (outfitMentions === 0) {
          console.log('⚠ 规则层没有命中任何衣着描写——0 命中不等于「无冲突」，检查器对这部作品的用词可能失明，请人工抽查')
        } else {
          console.log(`✓ 规则层未发现互斥描述（衣着命中 ${outfitMentions} 段）`)
        }
      }
      if (cardIssues.length) {
        console.log(`\n⚠ ${cardIssues.length} 条角色卡问题`)
        for (const item of cardIssues.slice(0, 10)) console.log(`  • ${item.summary}`)
      }
      console.log(`\n候选（需复核）: ${suspects.length} 条属性取值只出现过一次`)
    }

    process.exitCode = conflicts.length ? 1 : 0
  } finally {
    db.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

export { extractMentions, findConflicts, findSingleMentionSuspects, outfitColorFor, scanHueColors, scanFadedColors }

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.resolve(process.argv[1]).split(path.sep).join('/'))
if (invokedDirectly) main()
