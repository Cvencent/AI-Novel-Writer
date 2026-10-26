const fs = require('node:fs')
try {
  const data = JSON.parse(fs.readFileSync('F:/yuanqi/源起/.ai-novel/partial_arch.json', 'utf8'))
  for (const [k, v] of Object.entries(data)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    console.log(k, '=', s ? s.slice(0, 80) : s)
  }
} catch (e) { console.log('no partial_arch.json:', e.message) }
