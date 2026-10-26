const Database = require('F:/aiNovelWriter/repo/node_modules/better-sqlite3')
const db = new Database('F:/yuanqi/源起/.ai-novel/project.db', { readonly: true })
console.log('project_core cols:', JSON.stringify(db.prepare("SELECT name FROM pragma_table_info('project_core')").all().map(r => r.name)))
const core = db.prepare('SELECT * FROM project_core LIMIT 1').get()
if (core) for (const [k, v] of Object.entries(core)) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s && s.length < 200) console.log(k, '=', s)
  else console.log(k, '=', s ? `[${s.length} chars]` : s)
}
db.close()
