import type { AppearanceProfile } from './project-storage'

export const APPEARANCE_STORAGE_KEY = 'ai-novel-writer-appearance'
export const LEGACY_THEME_STORAGE_KEY = 'ai-novel-writer-theme'
export const LEGACY_UI_STORAGE_KEY = 'ai-novel-writer-ui-version'
export const APPEARANCE_SCHEMA_VERSION = 2
export const RELEASE_DEFAULT_SHELL: Shell = 'writer'
/** stage 是 RD-3 起的流程脊新外壳，schemaVersion 2 才允许。 */
export type Shell = 'classic' | 'writer' | 'stage'
export type ShellPreference = Shell | 'unset'
export type ColorTheme = 'light' | 'galaxy' | 'paper' | 'dark'
export type AppearanceFont = 'inter' | 'noto-sans-sc' | 'lxgw-wenkai' | 'noto-serif-sc' | 'system'

export interface CanonicalAppearanceProfile extends AppearanceProfile {
  schemaVersion: typeof APPEARANCE_SCHEMA_VERSION
  shellPreference: ShellPreference
  colorTheme: ColorTheme
  writingFont: AppearanceFont
  uiFont: AppearanceFont
  /** Provenance only. Never triggers a font reset. */
  legacyFontDefaultsVersion?: number
}

export const INITIAL_APPEARANCE: Readonly<CanonicalAppearanceProfile> = Object.freeze({
  schemaVersion: APPEARANCE_SCHEMA_VERSION, revision: 1, shellPreference: 'unset', colorTheme: 'paper', zoom: 1,
  writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', origin: 'legacy-import', legacyImportCompleted: true,
})

const THEMES = ['light', 'galaxy', 'paper', 'dark']
const FONTS = ['inter', 'noto-sans-sc', 'lxgw-wenkai', 'noto-serif-sc', 'system']
const SHELL_PREFERENCES: Record<1 | typeof APPEARANCE_SCHEMA_VERSION, readonly string[]> = {
  1: ['unset', 'classic', 'writer'],
  2: ['unset', 'classic', 'writer', 'stage'],
}
const FIELDS = ['schemaVersion', 'revision', 'shellPreference', 'colorTheme', 'zoom', 'writingFont', 'uiFont', 'origin', 'legacyImportCompleted', 'legacyFontDefaultsVersion']

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class AppearanceProfileError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppearanceProfileError' }
}

export function resolveShell(preference: ShellPreference, releaseDefault: Shell = RELEASE_DEFAULT_SHELL): Shell {
  return preference === 'unset' ? releaseDefault : preference
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { throw new AppearanceProfileError('APPEARANCE_JSON_INVALID') }
}

function assertProfile(value: unknown, schemaVersion: keyof typeof SHELL_PREFERENCES): asserts value is Record<string, unknown> {
  if (!record(value) || value.schemaVersion !== schemaVersion || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.shellPreference !== 'string' || !SHELL_PREFERENCES[schemaVersion].includes(value.shellPreference)
    || typeof value.colorTheme !== 'string' || !THEMES.includes(value.colorTheme) || typeof value.zoom !== 'number' || !Number.isFinite(value.zoom)
    || value.zoom < 0.7 || value.zoom > 1.5 || typeof value.writingFont !== 'string' || !FONTS.includes(value.writingFont)
    || typeof value.uiFont !== 'string' || !FONTS.includes(value.uiFont)
    || typeof value.origin !== 'string' || !['legacy-import', 'author'].includes(value.origin) || value.legacyImportCompleted !== true
    || (value.legacyFontDefaultsVersion !== undefined && (!Number.isSafeInteger(value.legacyFontDefaultsVersion) || Number(value.legacyFontDefaultsVersion) < 0))) {
    throw new AppearanceProfileError('APPEARANCE_PROFILE_INVALID')
  }
  if (Object.keys(value).some(key => !FIELDS.includes(key))) throw new AppearanceProfileError('APPEARANCE_UNKNOWN_FIELDS')
}

/** 只接受当前版本；写入前的校验都走这里，旧版本不会被写回。 */
export function parseAppearanceProfile(raw: string): CanonicalAppearanceProfile {
  const value = parseJson(raw)
  assertProfile(value, APPEARANCE_SCHEMA_VERSION)
  return value as unknown as CanonicalAppearanceProfile
}

/**
 * 读取已保存的配置。v1 按 v1 的规则严格校验后升级：只把 schemaVersion 改为 2，
 * 其余字段、取值与键的顺序原样保留，revision 不变；更高或未知的版本拒绝。
 */
export function readAppearanceProfile(raw: string): { profile: CanonicalAppearanceProfile; upgraded: boolean } {
  const value = parseJson(raw)
  if (record(value) && value.schemaVersion === 1) {
    assertProfile(value, 1)
    return { profile: { ...value, schemaVersion: APPEARANCE_SCHEMA_VERSION } as unknown as CanonicalAppearanceProfile, upgraded: true }
  }
  assertProfile(value, APPEARANCE_SCHEMA_VERSION)
  return { profile: value as unknown as CanonicalAppearanceProfile, upgraded: false }
}

/** Pure conversion. Legacy bytes stay in their original keys, including unknown/corrupt values. */
export function migrateLegacyAppearance(themeRaw: string | null, shellRaw: string | null, systemTheme: 'light' | 'dark'): CanonicalAppearanceProfile {
  const profile: CanonicalAppearanceProfile = { ...INITIAL_APPEARANCE }
  if (themeRaw !== null) {
    let parsed: unknown
    try { parsed = JSON.parse(themeRaw) } catch { throw new AppearanceProfileError('LEGACY_THEME_JSON_INVALID') }
    if (!record(parsed) || !record(parsed.state)) throw new AppearanceProfileError('LEGACY_THEME_INVALID')
    if (parsed.version !== undefined && parsed.version !== 0 && parsed.version !== 1) throw new AppearanceProfileError('LEGACY_THEME_VERSION_UNKNOWN')
    const state = parsed.state
    if (Object.keys(state).some(key => !['theme', 'zoom', 'writingFont', 'uiFont', 'fontDefaultsVersion'].includes(key))) {
      throw new AppearanceProfileError('LEGACY_THEME_FIELDS_UNKNOWN')
    }
    if (state.theme !== undefined) profile.colorTheme = (state.theme === 'night' ? 'dark' : state.theme === 'system' ? systemTheme : state.theme) as ColorTheme
    if (state.zoom !== undefined) profile.zoom = state.zoom as number
    if (state.writingFont !== undefined) profile.writingFont = state.writingFont as AppearanceFont
    if (state.uiFont !== undefined) profile.uiFont = state.uiFont as AppearanceFont
    if (state.fontDefaultsVersion !== undefined) profile.legacyFontDefaultsVersion = state.fontDefaultsVersion as number
  }
  if (shellRaw !== null) {
    let candidate: unknown = shellRaw
    if (shellRaw !== 'v1' && shellRaw !== 'v2') {
      try {
        const parsed: unknown = JSON.parse(shellRaw)
        candidate = record(parsed) ? (record(parsed.state) ? parsed.state.uiVersion : parsed.version) : parsed
      } catch { throw new AppearanceProfileError('LEGACY_SHELL_UNKNOWN') }
    }
    if (candidate !== 'v1' && candidate !== 'v2') throw new AppearanceProfileError('LEGACY_SHELL_UNKNOWN')
    profile.shellPreference = 'writer'
  }
  return parseAppearanceProfile(JSON.stringify(profile))
}

export type AppearancePatch = Partial<Pick<CanonicalAppearanceProfile, 'shellPreference' | 'colorTheme' | 'zoom' | 'writingFont' | 'uiFont'>>
