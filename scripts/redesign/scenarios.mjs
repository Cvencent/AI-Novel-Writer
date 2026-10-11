import * as settings from './pages/settings.mjs'

export const SCENARIOS = {
  settings: { model: false, run: async ({ page }) => { await settings.open(page) } },
}

export const SCREENSHOT_SCENARIOS = Object.keys(SCENARIOS)
