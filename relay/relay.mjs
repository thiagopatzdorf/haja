// Haja relay: a Nostr relay (NIP-01) with the house rules written as code.
//
//   - nobody writes without NIP-42 AUTH, and each authenticated key has a rate limit (anti-spam);
//   - private messages (kind 1059 gift wraps) are only served to the key they are addressed to;
//   - nothing stays longer than 7 days, ever: the cap is a constant, not a setting;
//   - only the kinds a messenger needs are accepted.
//
// It also serves the web client (web/) on the same port, so one process is a whole Haja.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { verifyEvent } from 'nostr-tools/pure'
import { openStore } from './store.mjs'

export const MAX_RETENTION_S = 7 * 24 * 3600
export const ALLOWED_KINDS = new Set([0, 3, 5, 1059, 10002, 10050])
const MAX_MESSAGE_BYTES = 128 * 1024
const MAX_FUTURE_S = 15 * 60
const AUTH_WINDOW_S = 10 * 60
const MAX_SUBS = 20

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' }

export function createRelay({
  port = 0,
  host = '127.0.0.1',
  dbPath = ':memory:',
  retentionS = MAX_RETENTION_S,
  eventsPerMinute = 60,
  webDir = path.join(HERE, '..', 'web'),
  now = () => Math.floor(Date.now() / 1000),
  name = 'Haja',
} = {}) {
  // Asking for more than a week is a configuration mistake, not a choice: clamp it.
  const retention = Math.max(1, Math.min(Number(retentionS) || MAX_RETENTION_S, MAX_RETENTION_S))
  const store = openStore(dbPath)
  const buckets = new Map() // pubkey -> { minute, n }
  const conns = new Set()

  const info = {
    name,
    description: 'Haja relay. No phone number, no email. Messages are end-to-end encrypted and deleted after 7 days at most.',
    software: 'https://github.com/thiagopatzdorf/haja',
    version: '0.1.0',
    supported_nips: [1, 9, 11, 17, 40, 42, 44, 59],
    limitation: { auth_required: true, max_message_length: MAX_MESSAGE_BYTES, max_subscriptions: MAX_SUBS, restricted_writes: true },
    retention: [{ time: retention }],
  }

  const server = http.createServer((req, res) => {
    const security = {
      'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    }
    if ((req.headers.accept || '').includes('application/nostr+json')) {
      res.writeHead(200, { 'content-type': 'application/nostr+json', 'access-control-allow-origin': '*' })
      return res.end(JSON.stringify(info))
    }
    // /health is what the cluster probes call; /healthz stays for anyone already using it.
    const pathname = new URL(req.url, 'http://x').pathname
    if (pathname === '/health' || pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('ok')
    }
    const url = new URL(req.url, 'http://x')
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = path.resolve(webDir, rel)
    // path.resolve + prefix check: "/../relay/store.mjs" must not leave web/.
    if (!file.startsWith(path.resolve(webDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain', ...security })
      return res.end('not found')
    }
    // no-cache: without it the CDN keeps app.js for hours and a fix reaches people only after that.
    // Browsers still reuse the file, they just check with the server first (cheap 304s are fine).
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...security })
    fs.createReadStream(file).pipe(res)
  })

  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES })

  function allowed(pubkey) {
    const minute = Math.floor(now() / 60)
    const b = buckets.get(pubkey)
    if (!b || b.minute !== minute) { buckets.set(pubkey, { minute, n: 1 }); return true }
    b.n++
    return b.n <= eventsPerMinute
  }

  // A gift wrap is readable metadata-wise only by its addressee; everything else is public profile data.
  function visibleTo(ev, authed) {
    if (ev.kind !== 1059) return true
    return !!authed && ev.tags.some((t) => t[0] === 'p' && t[1] === authed)
  }

  wss.on('connection', (ws) => {
    const c = { ws, challenge: crypto.randomBytes(16).toString('hex'), authed: null, subs: new Map() }
    conns.add(c)
    const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
    send(['AUTH', c.challenge])

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return send(['NOTICE', 'invalid: not JSON']) }
      if (!Array.isArray(msg)) return send(['NOTICE', 'invalid: not an array'])
      const [type] = msg
      if (type === 'AUTH') return onAuth(msg[1])
      if (type === 'EVENT') return onEvent(msg[1])
      if (type === 'REQ') return onReq(msg[1], msg.slice(2))
      if (type === 'CLOSE') { c.subs.delete(msg[1]); return }
      send(['NOTICE', `invalid: unknown message ${type}`])
    })
    ws.on('close', () => conns.delete(c))

    function onAuth(ev) {
      const id = ev?.id ?? ''
      if (!ev || ev.kind !== 22242 || !verifyEvent(ev)) return send(['OK', id, false, 'invalid: bad auth event'])
      const ch = ev.tags.find((t) => t[0] === 'challenge')?.[1]
      if (ch !== c.challenge) return send(['OK', id, false, 'invalid: wrong challenge'])
      if (Math.abs(now() - ev.created_at) > AUTH_WINDOW_S) return send(['OK', id, false, 'invalid: auth event too old'])
      c.authed = ev.pubkey
      send(['OK', id, true, ''])
    }

    function onEvent(ev) {
      const id = typeof ev?.id === 'string' ? ev.id : ''
      if (!c.authed) return send(['OK', id, false, 'auth-required: authenticate before publishing'])
      if (!ev || !verifyEvent(ev)) return send(['OK', id, false, 'invalid: bad signature or id'])
      if (!ALLOWED_KINDS.has(ev.kind)) return send(['OK', id, false, `blocked: kind ${ev.kind} is not accepted here`])
      const t = now()
      if (ev.created_at > t + MAX_FUTURE_S) return send(['OK', id, false, 'invalid: created_at is in the future'])
      if (!allowed(c.authed)) return send(['OK', id, false, 'rate-limited: slow down'])

      let expires = t + retention
      const exp = Number(ev.tags.find((x) => x[0] === 'expiration')?.[1])
      if (Number.isFinite(exp)) {
        if (exp <= t) return send(['OK', id, false, 'invalid: event already expired'])
        expires = Math.min(expires, exp)
      }

      if (ev.kind === 5) {
        const ids = ev.tags.filter((x) => x[0] === 'e').map((x) => x[1])
        const n = store.deleteOwn(ev.pubkey, ids)
        return send(['OK', id, true, `deleted ${n}`])
      }

      const r = store.save(ev, t, expires)
      if (r === 'duplicate') return send(['OK', id, true, 'duplicate: already have it'])
      if (r === 'older') return send(['OK', id, true, 'duplicate: a newer version exists'])
      send(['OK', id, true, ''])
      for (const other of conns) {
        if (!visibleTo(ev, other.authed)) continue
        for (const [sid, filters] of other.subs) {
          if (filters.some((f) => matches(f, ev))) other.ws.readyState === 1 && other.ws.send(JSON.stringify(['EVENT', sid, ev]))
        }
      }
    }

    function onReq(sid, filters) {
      if (typeof sid !== 'string' || !sid) return send(['NOTICE', 'invalid: subscription id'])
      if (!c.subs.has(sid) && c.subs.size >= MAX_SUBS) return send(['CLOSED', sid, 'blocked: too many subscriptions'])
      filters = filters.filter((f) => f && typeof f === 'object')
      const wantsDMs = filters.some((f) => !f.kinds || f.kinds.includes(1059))
      if (wantsDMs && !c.authed) return send(['CLOSED', sid, 'auth-required: private messages need AUTH'])
      c.subs.set(sid, filters)
      const seen = new Set()
      for (const f of filters) {
        for (const ev of store.query(f, now())) {
          if (seen.has(ev.id) || !visibleTo(ev, c.authed)) continue
          seen.add(ev.id)
          send(['EVENT', sid, ev])
        }
      }
      send(['EOSE', sid])
    }
  })

  function matches(f, ev) {
    if (f.ids && !f.ids.includes(ev.id)) return false
    if (f.authors && !f.authors.includes(ev.pubkey)) return false
    if (f.kinds && !f.kinds.includes(ev.kind)) return false
    if (f.since && ev.created_at < f.since) return false
    if (f.until && ev.created_at > f.until) return false
    for (const k of Object.keys(f)) {
      if (k[0] !== '#') continue
      const vals = ev.tags.filter((t) => t[0] === k.slice(1)).map((t) => t[1])
      if (!f[k].some((v) => vals.includes(v))) return false
    }
    return true
  }

  const timer = setInterval(() => store.sweep(now()), 60_000)
  timer.unref()

  return {
    store,
    info,
    retention,
    sweep: () => store.sweep(now()),
    listen: () => new Promise((resolve) => server.listen(port, host, () => {
      const a = server.address()
      resolve(`ws://${host}:${a.port}`)
    })),
    close: () => new Promise((resolve) => {
      clearInterval(timer)
      for (const c of conns) c.ws.terminate()
      wss.close()
      server.close(() => { store.close(); resolve() })
    }),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const relay = createRelay({
    port: Number(process.env.PORT || 7777),
    host: process.env.HOST || '0.0.0.0',
    dbPath: process.env.HAJA_DB || 'haja.db',
    retentionS: Number(process.env.HAJA_RETENTION_S || MAX_RETENTION_S),
    eventsPerMinute: Number(process.env.HAJA_EVENTS_PER_MINUTE || 60),
  })
  relay.listen().then((url) => console.log(`haja relay on ${url} (retention ${relay.retention}s)`))
}
