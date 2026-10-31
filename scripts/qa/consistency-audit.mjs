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
  '白大褂', '风衣', '外套', '夹克', '大衣', '校服', '制服', '作战服', '训练服', '罩衫', '开衫', '衬衫', '卫衣', '披风', '袍子', '长袍', '工装',
  // 下装与配件
  '长裤', '短裤', '裙子', '围巾', '披肩', '帽子', '斗篷', '护腕', '手环', '面具', '头盔',
  // 颜色
  '白色', '黑色', '灰色', '深灰', '浅灰', '银灰', '蓝色', '深蓝', '浅蓝', '红色', '暗红', '青色', '绿色', '墨绿', '黄色', '紫色', '棕色', '米色', '藏青', '卡其', '泛白', '泛黄',
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

/** 一行里同一属性的候选词：先找属性词，再在它周围 6 个字符里找颜色。 */
const COLOR_ADJ = ['白色', '黑色', '灰色', '深灰', '浅灰', '银灰', '蓝色', '深蓝', '浅蓝', '红色', '暗红', '青色', '绿色', '墨绿', '黄色', '紫色', '棕色', '米色', '藏青', '卡其', '泛白', '泛黄']
const COLOR_CHARS = '白黑灰蓝红青绿黄紫棕米银墨赤绯黛褐'

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

function outfitColorFor(paragraph, word, at) {
  const before = paragraph.slice(Math.max(0, at - 16), at)
  const after = paragraph.slice(at + word.length, Math.min(paragraph.length, at + word.length + 10))
  const colors = []

  // 前置定语：「泛白的九班制式风衣」「深灰色作战服」「那件洗得发硬的配给员罩衫」
  let lastColor = ''
  let lastColorAt = -1
  for (const color of COLOR_ADJ) {
    const idx = before.lastIndexOf(color)
    if (idx > lastColorAt) { lastColorAt = idx; lastColor = color }
  }
  if (lastColorAt >= 0) {
    const gap = before.slice(lastColorAt + lastColor.length)
    const otherColorInGap = COLOR_ADJ.some(color => gap.includes(color))
    const otherNounInGap = APPEARANCE_VOCAB.some(noun => gap.includes(noun))
    if (gap.length <= 10 && !PUNCTUATION.test(gap) && !otherColorInGap && !otherNounInGap) colors.push(lastColor)
  }

  // 后置补语：「风衣洗得泛黄」「外套已经发黑」
  const lead = after.match(POSTFIX_LEAD)
  if (lead) {
    const rest = after.slice(lead[0].length)
    for (const color of COLOR_ADJ) {
      if (rest.startsWith(color)) { colors.push(color); break }
    }
  }
  return [...new Set(colors)].sort()
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

      const outfitColors = new Set()
      for (const word of APPEARANCE_VOCAB) {
        let from = 0
        for (;;) {
          const at = paragraph.indexOf(word, from)
          if (at < 0) break
          from = at + word.length
          for (const color of outfitColorFor(paragraph, word, at)) outfitColors.add(color)
        }
      }
      if (outfitColors.size) {
        mentions.push({
          chapter: chapter.chapterNumber,
          character: carrier,
          attribute: 'outfit',
          attributeLabel: '衣着',
          namedInParagraph: namedHere.includes(carrier),
          colors: [...outfitColors].sort(),
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
        console.log('✓ 规则层未发现互斥描述')
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

main()