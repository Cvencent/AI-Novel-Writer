/** 英文里数量后的名词：1 用单数，其余（含 0）加 s。只用于加 s 成复数的规则名词。 */
export const pluralEn = (count: number, noun: string) => (count === 1 ? noun : `${noun}s`)
