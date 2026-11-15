// What a person's own AI agent may do on Haja, and the limits it cannot talk its way out of.
// The agent is the person's (Claude, ChatGPT, a local model): Haja pays for no AI.
// Limits live here, in code, not in a prompt:
//   - an allowlist of who the agent may message (empty = nobody, "*" = anyone);
//   - a daily cap on messages;
//   - every message it sends carries an "agent" tag, so the other side sees who wrote it;
//   - `dry_run` shows what would be sent and sends nothing.
import { getPublicKey } from 'nostr-tools/pure'
import { npubEncode, parsePubkey, readInbox, sendText, wrapText } from '../lib/messages.js'

export function createTools({ client, secretKey, allow = [], perDay = 50, agentName = 'agent', now = () => Date.now() }) {
  const me = getPublicKey(secretKey)
  const anyone = allow.includes('*')
  const allowed = new Set(allow.filter((a) => a !== '*').map(parsePubkey))
  let day = null
  let sent = 0

  function budget() {
    const d = new Date(now()).toISOString().slice(0, 10)
    if (d !== day) { day = d; sent = 0 }
    return perDay - sent
  }

  return {
    whoami() {
      return { npub: npubEncode(me), agent: agentName, can_message: anyone ? 'anyone' : [...allowed].map(npubEncode), left_today: budget() }
    },

    async read({ hours = 24, from } = {}) {
      const h = Math.min(Math.max(Number(hours) || 24, 1), 168)
      const since = Math.floor(now() / 1000) - h * 3600
      const who = from ? parsePubkey(from) : null
      const msgs = await readInbox(client, secretKey, { since })
      return msgs
        .filter((m) => !who || m.from === who || m.to === who)
        .map((m) => ({ from: npubEncode(m.from), to: m.to ? npubEncode(m.to) : null, mine: m.from === me, text: m.text, at: new Date(m.at * 1000).toISOString(), agent: m.agent }))
    },

    async send({ to, text, dry_run = false }) {
      if (typeof dry_run !== 'boolean') return { status: 'REFUSED', reason: 'dry_run must be true or false' }
      let pk
      try { pk = parsePubkey(to) } catch { return { status: 'REFUSED', reason: 'to must be an npub' } }
      if (!anyone && !allowed.has(pk)) return { status: 'REFUSED', reason: 'this agent is not allowed to message that person; the owner can add them to HAJA_ALLOW' }
      if (budget() <= 0) return { status: 'REFUSED', reason: `daily limit of ${perDay} messages reached` }
      try { wrapText(secretKey, pk, text) } catch (e) { return { status: 'REFUSED', reason: e.message } }
      if (dry_run) return { status: 'DRY_RUN', would_send_to: npubEncode(pk), text, agent_tag: agentName }
      sent++
      try {
        const id = await sendText(client, secretKey, pk, text, { agent: agentName })
        return { status: 'SENT', id, note: 'accepted by the relay; delivery to the phone is not confirmed' }
      } catch (e) {
        return { status: 'NOT_SENT', reason: e.message }
      }
    },
  }
}
