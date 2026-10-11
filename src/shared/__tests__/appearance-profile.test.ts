import { describe, expect, it } from 'vitest'
import { INITIAL_APPEARANCE, migrateLegacyAppearance, parseAppearanceProfile, readAppearanceProfile, resolveShell } from '../appearance-profile'

describe('appearance preference conversion', () => {
  it('resolves unset to the release Writer default without persisting a choice', () => {
    const profile = migrateLegacyAppearance(null, null, 'light')
    expect(profile.shellPreference).toBe('unset')
    expect(resolveShell(profile.shellPreference)).toBe('writer')
    expect(resolveShell(profile.shellPreference, 'classic')).toBe('classic')
    expect(resolveShell(profile.shellPreference, 'writer')).toBe('writer')
    expect(profile.shellPreference).toBe('unset')
    expect(resolveShell('classic')).toBe('classic')
    expect(resolveShell('writer')).toBe('writer')
    expect(resolveShell('classic', 'writer')).toBe('classic')
  })
  it.each(['v1', '{"version":"v1"}', '{"state":{"uiVersion":"v1"},"version":0}'])('migrates old Classic shape %s into Writer', raw => {
    expect(migrateLegacyAppearance(null, raw, 'light').shellPreference).toBe('writer')
  })
  it.each(['v2', '"v2"', '{"state":{"uiVersion":"v2"}}'])('maps old Writer shape %s', raw => {
    expect(migrateLegacyAppearance(null, raw, 'light').shellPreference).toBe('writer')
  })
  it('preserves explicit fonts even when equal to old defaults and donor version is zero', () => {
    const profile = migrateLegacyAppearance(JSON.stringify({ state: {
      theme: 'paper', zoom: 1.25, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', fontDefaultsVersion: 0,
    }, version: 1 }), 'v2', 'light')
    expect(profile).toMatchObject({ colorTheme: 'paper', zoom: 1.25, writingFont: 'lxgw-wenkai',
      uiFont: 'noto-sans-sc', legacyFontDefaultsVersion: 0, shellPreference: 'writer' })
    expect(profile).not.toHaveProperty('backgroundSkin')
  })
  it('preserves legacy night/system display meaning without modifying the source', () => {
    expect(migrateLegacyAppearance('{"state":{"theme":"night"}}', null, 'light').colorTheme).toBe('dark')
    expect(migrateLegacyAppearance('{"state":{"theme":"system"}}', null, 'dark').colorTheme).toBe('dark')
  })
  it.each(['future', '{bad-json', '{"version":"v3"}'])('rejects unknown shell %s for safe Classic fallback', raw => {
    expect(() => migrateLegacyAppearance(null, raw, 'light')).toThrow('LEGACY_SHELL_UNKNOWN')
  })
  it.each(['{bad-json', '{"state":null}', '{"version":9,"state":{}}', '{"state":{"writingFont":"future-font"}}', '{"state":{"zoom":9}}', '{"state":{"extra":true}}'])('refuses unsupported legacy theme %s without conversion', raw => {
    expect(() => migrateLegacyAppearance(raw, null, 'light')).toThrow()
  })
  it.each([{ colorTheme: ['dark'] }, { schemaVersion: 3 }, { backgroundSkin: 'classic' }, { revision: 0 }, { zoom: null }])('rejects malformed/future canonical profile %j', patch => {
    expect(() => parseAppearanceProfile(JSON.stringify({ ...INITIAL_APPEARANCE, ...patch }))).toThrow()
  })
})

describe('schemaVersion 1 到 2 的迁移', () => {
  const v1 = (fields: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: 1, revision: 7, shellPreference: 'classic', colorTheme: 'galaxy', zoom: 1.25, writingFont: 'noto-serif-sc',
    uiFont: 'inter', origin: 'author', legacyImportCompleted: true, legacyFontDefaultsVersion: 0, ...fields,
  })

  it.each(['unset', 'classic', 'writer'])('v1 的 %s 升级后只改 schemaVersion，字段、取值、顺序与 revision 原样保留', shell => {
    const raw = v1({ shellPreference: shell })
    const { profile, upgraded } = readAppearanceProfile(raw)
    expect(upgraded).toBe(true)
    expect(JSON.stringify(profile)).toBe(raw.replace('"schemaVersion":1', '"schemaVersion":2'))
    expect(profile).toMatchObject({ shellPreference: shell, revision: 7, origin: 'author', legacyFontDefaultsVersion: 0 })
  })

  it('没有可选字段的 v1 也原样升级，不补出缺省字段', () => {
    const raw = JSON.stringify({ ...INITIAL_APPEARANCE, schemaVersion: 1 })
    expect(JSON.stringify(readAppearanceProfile(raw).profile)).toBe(JSON.stringify(INITIAL_APPEARANCE))
  })

  it('v2 原样读取，不算升级，并接受新外壳 stage', () => {
    const raw = JSON.stringify({ ...INITIAL_APPEARANCE, shellPreference: 'stage' })
    const { profile, upgraded } = readAppearanceProfile(raw)
    expect(upgraded).toBe(false)
    expect(JSON.stringify(profile)).toBe(raw)
    expect(resolveShell(profile.shellPreference)).toBe('stage')
  })

  it('v1 没有 stage 取值，带 stage 的 v1 与带未知字段的 v1 都拒绝', () => {
    expect(() => readAppearanceProfile(v1({ shellPreference: 'stage' }))).toThrow('APPEARANCE_PROFILE_INVALID')
    expect(() => readAppearanceProfile(v1({ backgroundSkin: 'anime' }))).toThrow('APPEARANCE_UNKNOWN_FIELDS')
  })

  it('写入路径只认当前版本，v1 与未来版本都不会被写回', () => {
    expect(() => parseAppearanceProfile(v1())).toThrow('APPEARANCE_PROFILE_INVALID')
    expect(() => readAppearanceProfile(v1({ schemaVersion: 3 }))).toThrow('APPEARANCE_PROFILE_INVALID')
    expect(() => readAppearanceProfile('{bad-json')).toThrow('APPEARANCE_JSON_INVALID')
  })
})
