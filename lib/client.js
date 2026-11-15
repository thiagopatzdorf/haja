// Minimal Nostr client that answers the relay's NIP-42 AUTH challenge by itself.
// Runs in the browser and in Node >= 22 (both have a global WebSocket).
import { finalizeEvent } from 'nostr-tools/pure'

export function connect(url, secretKey, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url)
    const pending = new Map() // event id -> resolve
    const subs = new Map() // sub id -> { onEvent, onEose }
    let authed = false
    let authId = null
    const waitingAuth = []
    const timer = setTimeout(() => reject(new Error('haja: relay did not ask for AUTH in time')), timeoutMs)

    const api = {
      get authed() { return authed },
      publish(ev) {
        return new Promise((res) => {
          pending.set(ev.id, res)
          const go = () => ws.send(JSON.stringify(['EVENT', ev]))
          authed ? go() : waitingAuth.push(go)
        })
      },
      subscribe(filters, { onEvent = () => {}, onEose = () => {} } = {}) {
        const id = Math.random().toString(36).slice(2, 10)
        subs.set(id, { onEvent, onEose })
        const go = () => ws.send(JSON.stringify(['REQ', id, ...filters]))
        authed ? go() : waitingAuth.push(go)
        return { id, close: () => { subs.delete(id); ws.readyState === 1 && ws.send(JSON.stringify(['CLOSE', id])) } }
      },
      /** Fetches what is stored now (until EOSE) and closes the subscription. */
      query(filters) {
        return new Promise((res, rej) => {
          const out = []
          const sub = api.subscribe(filters, {
            onEvent: (ev) => out.push(ev),
            onEose: (err) => { sub.close(); err ? rej(new Error(err)) : res(out) },
          })
        })
      },
      close() { ws.close() },
    }

    ws.onmessage = (m) => {
      let msg
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()) } catch { return }
      const [type] = msg
      if (type === 'AUTH') {
        const auth = finalizeEvent({
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['relay', url], ['challenge', msg[1]]],
          content: '',
        }, secretKey)
        authId = auth.id
        ws.send(JSON.stringify(['AUTH', auth]))
      } else if (type === 'OK' && msg[1] === authId) {
        clearTimeout(timer)
        if (!msg[2]) return reject(new Error(`haja: auth refused (${msg[3]})`))
        authed = true
        waitingAuth.splice(0).forEach((go) => go())
        resolve(api)
      } else if (type === 'OK') {
        pending.get(msg[1])?.({ ok: msg[2], message: msg[3] })
        pending.delete(msg[1])
      } else if (type === 'EVENT') {
        subs.get(msg[1])?.onEvent(msg[2])
      } else if (type === 'EOSE') {
        subs.get(msg[1])?.onEose()
      } else if (type === 'CLOSED') {
        subs.get(msg[1])?.onEose(msg[2])
      }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`haja: cannot reach ${url}`)) }
  })
}
