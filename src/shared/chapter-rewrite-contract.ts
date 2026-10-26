import { writingLanguageText, type WritingLanguage } from './writing-language'

/**
 * 「生成新版本」的冻结基准：正在被重写的本章权威定稿。
 * 正文由启动器在启动工作流前读取并冻结，生成过程中绝不回读数据库。
 */
export interface ChapterRewriteBase {
  draftId: number
  version: number
  content: string
}

/**
 * 重写任务的基准块：注入写稿 Prompt 顶部。
 * 契约：以上一版定稿全文为基础落实作者的修改想法重写本章；未提到的部分保持连续，
 * 修改想法与定稿冲突时以修改想法为准；输出仍然是一章完整正文。
 */
export function buildChapterRewriteBlock(input: {
  language: WritingLanguage
  chapterNumber: number
  base: ChapterRewriteBase
  /** 作者对这一版的修改想法；为空时按保持连续性重写。 */
  guidance?: string
}): string {
  const guidance = input.guidance?.trim() || ''
  return [
    writingLanguageText(
      input.language,
      `【重写任务】第 ${input.chapterNumber} 章已有一版定稿。请以下面的定稿全文为基础，按作者的修改想法重写本章：仍成立的情节、人物状态、伏笔与事实保持连续；修改想法与定稿冲突时以修改想法为准；没有提到的部分不要随意改动故事走向。`,
      `[Rewrite task] Chapter ${input.chapterNumber} already has a finalized version. Rewrite the chapter based on the finalized prose below and the author's revision notes: keep continuity for plot, character states, foreshadowing, and facts that still hold; when a revision note conflicts with the finalized prose, the note wins; do not change the story direction beyond what is asked.`,
    ),
    writingLanguageText(input.language, '【重写基准：本章定稿全文】', '[Rewrite base: the finalized prose of this chapter]'),
    input.base.content,
    writingLanguageText(input.language, '【作者的修改想法】', '[Author revision notes]'),
    guidance || writingLanguageText(
      input.language,
      '（作者没有额外要求：在保持故事连续性的前提下重写本章，可以整体提升文笔与画面感。）',
      '(No extra notes from the author: rewrite the chapter while keeping story continuity; you may improve prose and imagery overall.)',
    ),
  ].join('\n\n')
}
