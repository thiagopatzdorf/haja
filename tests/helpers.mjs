import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createRelay } from '../relay/relay.mjs'
import { connect } from '../lib/client.js'

export async function startRelay(opts = {}) {
  const clock = { t: Math.floor(Date.now() / 1000) }
  const relay = createRelay({ now: () => clock.t, ...opts })
  const url = await relay.listen()
  return { relay, url, clock }
}

export function person() {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

export async function online(url, p) {
  return connect(url, p.sk)
}

/** Raw socket, no automatic AUTH: to test what an unauthenticated client gets. */
export function raw(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const inbox = []
    const waiters = []
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      const i = waiters.findIndex((w) => w.pred(msg))
      if (i >= 0) waiters.splice(i, 1)[0].res(msg)
      else inbox.push(msg)
    }
    ws.onopen = () => resolve({
      send: (x) => ws.send(JSON.stringify(x)),
      next: (pred) => new Promise((res) => {
        const i = inbox.findIndex(pred)
        if (i >= 0) return res(inbox.splice(i, 1)[0])
        waiters.push({ pred, res })
      }),
      close: () => ws.close(),
    })
  })
}
