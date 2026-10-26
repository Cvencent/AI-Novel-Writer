const fs = require('node:fs')
const raw = fs.readFileSync('F:/yuanqi/源起/.ai-novel/partial_arch.json', 'utf8')
console.log('SIZE', raw.length)
const data = JSON.parse(raw)
for (const [k, v] of Object.entries(data)) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  console.log(k, '=', s ? s.slice(0, 120) : s)
}
