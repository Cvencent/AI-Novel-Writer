import { describe, expect, it } from 'vitest'

import { normalizeAgeField, parseAgeValue } from '../character-age'

describe('parseAgeValue', () => {
  it('parses arabic numerals', () => {
    expect(parseAgeValue('28')).toEqual({ value: 28, approximate: false })
    expect(parseAgeValue('28岁')).toEqual({ value: 28, approximate: false })
  })

  it('parses chinese numerals including tens with units', () => {
    expect(parseAgeValue('五十七岁')).toEqual({ value: 57, approximate: false })
    expect(parseAgeValue('二十二岁')).toEqual({ value: 22, approximate: false })
    expect(parseAgeValue('二十')).toEqual({ value: 20, approximate: false })
    expect(parseAgeValue('三十')).toEqual({ value: 30, approximate: false })
  })

  it('marks estimates as approximate', () => {
    expect(parseAgeValue('约二十六岁')?.approximate).toBe(true)
    expect(parseAgeValue('六十余岁')?.approximate).toBe(true)
    expect(parseAgeValue('三十多')).toEqual({ value: 30, approximate: true })
    expect(parseAgeValue('不到三十')).toEqual({ value: 30, approximate: true })
  })

  it('returns null for text without an age number', () => {
    expect(parseAgeValue('不详')).toBeNull()
    expect(parseAgeValue('')).toBeNull()
  })
})

describe('normalizeAgeField', () => {
  it('normalizes the mixed forms seen in real rosters', () => {
    expect(normalizeAgeField('28')).toBe('28')
    expect(normalizeAgeField('52')).toBe('52')
    expect(normalizeAgeField('五十七岁')).toBe('57')
    expect(normalizeAgeField('二十七岁')).toBe('27')
    expect(normalizeAgeField('二十二岁')).toBe('22')
    expect(normalizeAgeField('约二十六岁')).toBe('约26')
  })

  it('keeps parenthetical facts and non-numeric qualifiers', () => {
    expect(normalizeAgeField('外表约二十四岁（死者，殁于三十年前）')).toBe('外表约24（死者，殁于三十年前）')
  })

  it('keeps unparseable values verbatim', () => {
    expect(normalizeAgeField('不详')).toBe('不详')
    expect(normalizeAgeField('')).toBe('')
  })
})
