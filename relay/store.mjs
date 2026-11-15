// Event store on node:sqlite. Every row carries `expires_at`; nothing is kept past it.
// Retention is counted from when the relay RECEIVED the event, not from `created_at`:
// NIP-59 gift wraps backdate `created_at` by up to two days on purpose, so trusting it
// would let a message live past the promised week.
import { DatabaseSync } from 'node:sqlite'
import { matchFilter } from 'nostr-tools/filter'

const REPLACEABLE = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000)

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
      created_at INTEGER NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      raw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ptags (event_id TEXT NOT NULL, pubkey TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ev_kind ON events(kind, created_at);
    CREATE INDEX IF NOT EXISTS ev_author ON events(pubkey, kind);
    CREATE INDEX IF NOT EXISTS ev_exp ON events(expires_at);
    CREATE INDEX IF NOT EXISTS pt_pub ON ptags(pubkey);
    CREATE INDEX IF NOT EXISTS pt_ev ON ptags(event_id);
  `)
  const ins = db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?)')
  const insP = db.prepare('INSERT INTO ptags VALUES (?,?)')
  const delById = db.prepare('DELETE FROM events WHERE id = ?')
  const delP = db.prepare('DELETE FROM ptags WHERE event_id = ?')

  function remove(id) {
    delById.run(id)
    delP.run(id)
  }

  return {
    db,
    /** @returns {'saved'|'duplicate'|'older'} */
    save(ev, receivedAt, expiresAt) {
      if (REPLACEABLE(ev.kind)) {
        const cur = db.prepare('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ?').get(ev.pubkey, ev.kind)
        if (cur && cur.created_at >= ev.created_at) return cur.id === ev.id ? 'duplicate' : 'older'
        if (cur) remove(cur.id)
      }
      const r = ins.run(ev.id, ev.pubkey, ev.kind, ev.created_at, receivedAt, expiresAt, JSON.stringify(ev))
      if (r.changes === 0) return 'duplicate'
      for (const t of ev.tags) if (t[0] === 'p' && typeof t[1] === 'string') insP.run(ev.id, t[1])
      return 'saved'
    },
    /** Deletes events by `ids` that belong to `pubkey` (NIP-09). */
    deleteOwn(pubkey, ids) {
      let n = 0
      for (const id of ids) {
        const row = db.prepare('SELECT pubkey FROM events WHERE id = ?').get(id)
        if (row && row.pubkey === pubkey) { remove(id); n++ }
      }
      return n
    },
    query(filter, now) {
      const where = ['e.expires_at > ?']
      const args = [now]
      let from = 'events e'
      const list = (col, vals) => { where.push(`${col} IN (${vals.map(() => '?').join(',')})`); args.push(...vals) }
      if (filter.ids?.length) list('e.id', filter.ids)
      if (filter.authors?.length) list('e.pubkey', filter.authors)
      if (filter.kinds?.length) list('e.kind', filter.kinds)
      if (filter['#p']?.length) {
        from = 'events e JOIN ptags p ON p.event_id = e.id'
        list('p.pubkey', filter['#p'])
      }
      if (filter.since) { where.push('e.created_at >= ?'); args.push(filter.since) }
      if (filter.until) { where.push('e.created_at <= ?'); args.push(filter.until) }
      const limit = Math.min(Number.isInteger(filter.limit) ? filter.limit : 500, 500)
      const rows = db.prepare(`SELECT DISTINCT e.raw FROM ${from} WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT ${limit}`).all(...args)
      return rows.map((r) => JSON.parse(r.raw)).filter((ev) => matchFilter(filter, ev))
    },
    /** Removes everything past its expiry. Returns how many rows went away. */
    sweep(now) {
      const ids = db.prepare('SELECT id FROM events WHERE expires_at <= ?').all(now).map((r) => r.id)
      for (const id of ids) remove(id)
      return ids.length
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM events').get().n
    },
    close() { db.close() },
  }
}
