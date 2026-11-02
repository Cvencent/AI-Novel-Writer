/**
 * 物件「过手动作」的固定化（issue #95）。
 *
 * 现象：那本 42 章的悬疑长篇里，**「一件纸在两个人之间过手」被写成了一套固定三步**：
 *   出示（推过来／摊开／抽出来）→ 核验（举到窗前／对光照／翻两页）→ **收纳（折好→塞进内襟／公文包）**
 * 第三步是逐字级的公式：按最严口径（同一句里「折＋塞进/揣进/收进/夹进」）就命中
 * **24–25 句、覆盖 18–19 章（43–45%）**，而「折」的变体虽多（折好/对折/折回/折两折…），
 * 配的目的地只有两个：**自己身上（内襟/怀里/袖里）或公文包（内层/外袋）**。
 *
 * 为什么现有检测覆盖不到 —— 这是第五层位置轴：
 *   #32/#33/#49/#82 正文重复三族 —— 短语层（否定式反应／低身姿态／场景装置）
 *   #81/#87/#92     登场句       —— 人物**怎么出场**
 *   #71             章首         —— 每章第一个小句
 *   #28/#65/#66     章末         —— 落幅／标注／末句语用
 *   #38（已关闭）   道具交接     —— 只管「有没有」交接（该交没交、凭空到手）
 *
 * 本条是 #38 的**反向**：交接太到位、太同形。判据是**结构**而不是词表：
 *   - 命中单元是「**同一句里同时出现折叠动作与收纳动作**」——这是个**句法共现模式**，
 *     不是某一个词；换个作者、换动词，模式还在；
 *   - 目的地按**类别**归并（衣内／容器／场所），不枚举「内襟」「公文包」；
 *   - 判据是**跨章覆盖率**（同一套动作覆盖了多少章），不是次数——与 #32 的
 *     「用跨章分布，不用出现次数」同一口径。
 */

export interface HandoverChapter {
  chapterNumber: number
  content: string
}

/**
 * 「折叠」动作：以 `折` 为词根，覆盖 折好／对折／折回／折两折／折成四折／折起／折齐。
 *
 * 用**词根 + 可选补语**而不是枚举变体：那本书实测有 9 种变体，作者换个补语就绕过词表了。
 * 只认「折」为词根是安全的——「折」在中文叙述里几乎只表折叠（折扣、折返除外，
 * 但都要求搭配特定宾语，落在同句里也仍是一次折叠动作）。
 */
const FOLD_ACTION = /折/u

/**
 * 「收纳」动作：把东西收进某处的动词。
 *
 * 这一类是**封闭小集**（塞进/揣进/收进/夹进/放进/装进/掖进），且都表示「放进」，
 * 与 `FOLD_ACTION` 同句出现即构成「折好收起来」这个动作组。
 * **刻意不收**「交给」「递给」——那是**转手**不是**收纳**，混进来会把正常交接算成公式。
 */
export const STOW_ACTIONS = Object.freeze(['塞进', '揣进', '收进', '夹进', '放进', '装进', '掖进'] as const)

/** 目的地类别（结构归类，不枚举具体词）。 */
export type HandoverDestination = 'body' | 'container' | 'place'

export const DESTINATION_PHRASES: Record<HandoverDestination, readonly string[]> = Object.freeze({
  /** 身上：内襟／怀里／袖里／贴身。 */
  body: Object.freeze(['内襟', '怀里', '袖里', '袖中', '衣内', '贴身', '胸口', '内衣', '襟里']),
  /** 容器：公文包／外袋／内层／匣子／箱子。 */
  container: Object.freeze(['公文包', '外袋', '内袋', '内层', '匣子', '箱子', '口袋', '夹层', '皮包', '包内']),
  /** 场所：风灯罩／槽缝／抽屉／柜子。 */
  place: Object.freeze(['风灯罩', '槽缝', '抽屉', '柜子', '搁板', '灯罩', '槽里', '缝里']),
})

export const DESTINATION_LABELS: Record<HandoverDestination, { zhCN: string, enUS: string }> = Object.freeze({
  body: { zhCN: '身上（内襟／怀里／袖里）', enUS: 'on the body (inside the coat, breast, sleeve)' },
  container: { zhCN: '容器（公文包／外袋／内层）', enUS: 'in a container (briefcase, outer pocket, inner sleeve)' },
  place: { zhCN: '场所（风灯罩／槽缝／抽屉）', enUS: 'in a place (lamp housing, slot, drawer)' },
})

/** 按中文句读切句（与其它判据同一口径）。 */
function proseSentences(content: string): string[] {
  return String(content ?? '')
    .split(/[。！？\n]/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 4)
}

export interface HandoverHit {
  chapterNumber: number
  /** 命中句原文（截断到 60 字）。 */
  excerpt: string
  /** 该句的目的地类别（必填：没有目的地的不算这个动作组）。 */
  destination: HandoverDestination
}

/**
 * 抽出一章里的「折叠 + 收纳 → 目的地」动作组。
 *
 * ⚠️ **必须要求目的地**（真实语料实测的假阳性）：
 * 只要求「折 + 收纳动词同句」时，会命中
 * 「周叙把叶子夹进票根里，**折回**船工间」—— 这里的「折回」是**走回去**，
 * 「夹进票根里」的目的地是另一个物件而不是某个存放处，动作组根本不成立。
 * 三个要素齐备才算：**折叠动作 + 收纳动词 + 目的地类**（这正是 issue #95 说的三元组）。
 */
export function handoverHits(chapter: HandoverChapter): HandoverHit[] {
  const hits: HandoverHit[] = []
  for (const sentence of proseSentences(chapter.content)) {
    if (!FOLD_ACTION.test(sentence)) continue
    if (!STOW_ACTIONS.some(action => sentence.includes(action))) continue
    const destination = (Object.keys(DESTINATION_PHRASES) as HandoverDestination[])
      .find(kind => DESTINATION_PHRASES[kind].some(phrase => sentence.includes(phrase))) ?? null
    // 目的地缺一不可：没有它，这句话未必是「收起来」（可能只是「夹在别的纸里」）。
    if (destination === null) continue
    hits.push({ chapterNumber: chapter.chapterNumber, excerpt: sentence.slice(0, 60), destination })
  }
  return hits
}

export interface HandoverConvergence {
  /** 命中该动作组的章号（升序去重）。 */
  chapters: number[]
  /** 参与统计的章数（分母）。 */
  chapterTotal: number
  /** 命中的句子数。 */
  sentenceCount: number
  /** 按目的地类别统计的章数。 */
  byDestination: Array<{ destination: HandoverDestination, chapters: number[], sentences: number }>
  /** 代表性原句（最多 4 条）。 */
  samples: HandoverHit[]
  /** 命中最多的目的地类别（若某一类占命中章数的 60% 以上）。 */
  dominantDestination: HandoverDestination | null
}

export interface HandoverConvergenceOptions {
  /**
   * 覆盖率阈值：同一动作组覆盖多少比例的章就报。默认 1/3。
   *
   * 1/3 是与 #94 同一口径（「三分之一的章都在用同一个动作」已经不是偶然）。
   * 实测分离度：样本 19/42 = 45% 触发；另两本 7/26 = 27%、3/22 = 14% 不触发。
   */
  shareThreshold?: number
  /** 章数下限：样本不足不判（与其它分布判据同一口径）。 */
  minChapters?: number
}

/**
 * 找「物件过手动作被写成同一套」。
 *
 * 只报**折叠 + 收纳**这一种动作组：它是那本书里逐字级复写的那个，也是最容易被
 * 无意识继承的写法（「折好塞进内襟」写完不需要思考）。其它动作组（出示/核验）
 * 实测覆盖率只有 5 章，不构成固定公式，不报。
 */
export function findHandoverConvergence(
  chapters: readonly HandoverChapter[],
  options: HandoverConvergenceOptions = {},
): HandoverConvergence[] {
  const shareThreshold = options.shareThreshold ?? 1 / 3
  const minChapters = options.minChapters ?? 8
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  const chapterTotal = ordered.length
  if (chapterTotal < minChapters) return []
  const hits = ordered.flatMap(chapter => handoverHits(chapter))
  if (hits.length === 0) return []
  const coveredChapters = [...new Set(hits.map(hit => hit.chapterNumber))].sort((left, right) => left - right)
  if (coveredChapters.length / chapterTotal < shareThreshold) return []

  const byDestination = (Object.keys(DESTINATION_PHRASES) as HandoverDestination[]).map(destination => {
    const subset = hits.filter(hit => hit.destination === destination)
    return {
      destination,
      chapters: [...new Set(subset.map(hit => hit.chapterNumber))].sort((left, right) => left - right),
      sentences: subset.length,
    }
  }).filter(item => item.chapters.length > 0)
  const dominant = byDestination
    .filter(item => item.chapters.length / coveredChapters.length >= 0.6)
    .sort((left, right) => right.chapters.length - left.chapters.length)[0]?.destination ?? null

  return [{
    chapters: coveredChapters,
    chapterTotal,
    sentenceCount: hits.length,
    byDestination,
    samples: hits.slice(0, 4),
    dominantDestination: dominant,
  }]
}