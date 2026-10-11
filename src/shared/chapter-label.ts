type Text = (zh: string, en: string) => string

export function chapterLabel(chapterNumber: number, text: Text): string {
  return text(`第 ${chapterNumber} 章`, `Chapter ${chapterNumber}`)
}

/** 新外壳打开一章时的标签名：章号加章名，没有章名时只写章号。 */
export function chapterTabName(chapterNumber: number, title: string, text: Text): string {
  const label = chapterLabel(chapterNumber, text)
  return title ? `${label} · ${title}` : label
}
