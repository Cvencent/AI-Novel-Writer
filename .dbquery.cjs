const Database = require('F:/aiNovelWriter/repo/node_modules/better-sqlite3')
const db = new Database('F:/yuanqi/源起/.ai-novel/project.db', { readonly: true })
const snap = JSON.parse(db.prepare('SELECT contents.body FROM reviews LEFT JOIN contents ON contents.id = reviews.content_id WHERE reviews.id = 5').get().body)
console.log('items:')
for (const item of snap.items || []) {
  console.log(JSON.stringify({ origin: item.origin, decision: item.decision, category: item.category, description: (item.description || '').slice(0, 40) }))
}
db.close()
