// Private messages: NIP-17 (kind 14 rumor) sealed with NIP-44 and gift-wrapped with NIP-59.
// The relay only ever sees a wrap signed by a throwaway key, addressed to one recipient.
// One wrap goes to the recipient and one to the sender, so the sender's other devices see it too.
import { getPublicKey } from 'nostr-tools/pure'
import { createRumor, createSeal, createWrap, unwrapEvent } from 'nostr-tools/nip59'
import { decode, npubEncode } from 'nostr-tools/nip19'

export const MAX_TEXT = 8000

/** Accepts npub1..., nsec1... or 64-char hex and returns hex (pubkey) or bytes (secret). */
export function parsePubkey(s) {
  s = String(s || '').trim()
  if (/^[0-9a-f]{64}$/.test(s)) return s
  const d = decode(s)
  if (d.type === 'npub') return d.data
  if (d.type === 'nprofile') return d.data.pubkey
  throw new Error('not a public key')
}

export function parseSecret(s) {
  s = String(s || '').trim()
  if (/^[0-9a-f]{64}$/.test(s)) return Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)))
  const d = decode(s)
  if (d.type !== 'nsec') throw new Error('not a secret key')
  return d.data
}

export { npubEncode }

/**
 * Builds the two gift wraps (recipient + sender copy) for one text message.
 * `agent` marks the message as written by the person's AI agent; clients show it.
 */
export function wrapText(secretKey, toPubkey, text, { agent = null, createdAt } = {}) {
  text = String(text ?? '')
  if (!text.trim()) throw new Error('empty message')
  if (text.length > MAX_TEXT) throw new Error(`message longer than ${MAX_TEXT} characters`)
  const me = getPublicKey(secretKey)
  const tags = [['p', toPubkey]]
  if (agent) tags.push(['agent', String(agent).slice(0, 64)])
  const rumor = createRumor({ kind: 14, content: text, tags, ...(createdAt ? { created_at: createdAt } : {}) }, secretKey)
  const targets = toPubkey === me ? [me] : [toPubkey, me]
  return { rumorId: rumor.id, wraps: targets.map((pk) => createWrap(createSeal(rumor, secretKey, pk), pk)) }
}

/** Opens a gift wrap. Returns null for anything that is not a well-formed kind-14 message. */
export function openWrap(secretKey, wrap) {
  try {
    const r = unwrapEvent(wrap, secretKey)
    if (r.kind !== 14) return null
    const to = r.tags.find((t) => t[0] === 'p')?.[1] ?? null
    return {
      id: r.id,
      from: r.pubkey,
      to,
      text: r.content,
      at: r.created_at,
      agent: r.tags.find((t) => t[0] === 'agent')?.[1] ?? null,
    }
  } catch {
    return null
  }
}

/** Sends a message through a connected client. Resolves when the relay accepted every copy. */
export async function sendText(client, secretKey, toPubkey, text, opts) {
  const { rumorId, wraps } = wrapText(secretKey, toPubkey, text, opts)
  const results = await Promise.all(wraps.map((w) => client.publish(w)))
  const failed = results.find((r) => !r.ok)
  if (failed) throw new Error(`relay refused: ${failed.message}`)
  return rumorId
}

/** Reads my inbox: every message to or from me still on the relay, oldest first, deduplicated. */
export async function readInbox(client, secretKey, { since } = {}) {
  const me = getPublicKey(secretKey)
  // Gift wraps backdate created_at up to 2 days (NIP-59), so widen `since` on the wire and filter after.
  const filter = { kinds: [1059], '#p': [me] }
  if (since) filter.since = since - 2 * 24 * 3600
  const wraps = await client.query([filter])
  const seen = new Map()
  for (const w of wraps) {
    const m = openWrap(secretKey, w)
    if (m && (!since || m.at >= since)) seen.set(m.id, m)
  }
  return [...seen.values()].sort((a, b) => a.at - b.at)
}
