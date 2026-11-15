import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWrap, readInbox, sendText, wrapText } from '../lib/messages.js'
import { online, person, startRelay } from './helpers.mjs'

test('alice to bob end to end: bob reads it, the relay never stores the text', async () => {
  const { relay, url } = await startRelay({ now: () => Math.floor(Date.now() / 1000) })
  const [a, b] = [person(), person()]
  const ca = await online(url, a)
  const cb = await online(url, b)
  await sendText(ca, a.sk, b.pk, 'segredo do pombo 🕊️')
  const inbox = await readInbox(cb, b.sk)
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].text, 'segredo do pombo 🕊️')
  assert.equal(inbox[0].from, a.pk)
  const rows = relay.store.db.prepare('SELECT raw FROM events').all().map((r) => JSON.parse(r.raw))
  ca.close(); cb.close(); await relay.close()
  assert.ok(!JSON.stringify(rows).includes('segredo'))
  // The sender's own copy is addressed to the sender, but the copy addressed to Bob must not
  // reveal who sent it: the relay sees "someone wrote to Bob", never "Alice wrote to Bob".
  const toBob = rows.filter((ev) => ev.tags.some((t) => t[0] === 'p' && t[1] === b.pk))
  assert.equal(toBob.length, 1)
  assert.ok(!JSON.stringify(toBob[0]).includes(a.pk), 'sender pubkey leaked in the wrap addressed to the recipient')
})

test('sender keeps a copy for their other devices', async () => {
  const { relay, url } = await startRelay({ now: () => Math.floor(Date.now() / 1000) })
  const [a, b] = [person(), person()]
  const ca = await online(url, a)
  await sendText(ca, a.sk, b.pk, 'oi')
  const mine = await readInbox(ca, a.sk)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].to, b.pk)
  ca.close(); await relay.close()
})

test('message written by an agent says so to the recipient', () => {
  const [a, b] = [person(), person()]
  const { wraps } = wrapText(a.sk, b.pk, 'lembrete', { agent: 'claude' })
  assert.equal(openWrap(b.sk, wraps[0]).agent, 'claude')
  assert.equal(openWrap(b.sk, wrapText(a.sk, b.pk, 'eu mesmo').wraps[0]).agent, null)
})

test('a third key cannot open the wrap', () => {
  const [a, b, eve] = [person(), person(), person()]
  const { wraps } = wrapText(a.sk, b.pk, 'x')
  assert.equal(openWrap(eve.sk, wraps[0]), null)
})

test('empty or oversized messages are refused before anything is sent', () => {
  const [a, b] = [person(), person()]
  assert.throws(() => wrapText(a.sk, b.pk, '   '))
  assert.throws(() => wrapText(a.sk, b.pk, 'x'.repeat(8001)))
})
