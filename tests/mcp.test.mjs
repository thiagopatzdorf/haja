import { test } from 'node:test'
import assert from 'node:assert/strict'
import { npubEncode, readInbox } from '../lib/messages.js'
import { createTools } from '../mcp/tools.mjs'
import { online, person, startRelay } from './helpers.mjs'

async function setup(opts = {}) {
  const r = await startRelay({ now: () => Math.floor(Date.now() / 1000) })
  const [owner, friend, stranger] = [person(), person(), person()]
  const c = await online(r.url, owner)
  const tools = createTools({ client: c, secretKey: owner.sk, allow: [npubEncode(friend.pk)], agentName: 'claude', ...opts })
  return { ...r, owner, friend, stranger, c, tools }
}

test('agent cannot message someone the owner did not allow', async () => {
  const s = await setup()
  const r = await s.tools.send({ to: npubEncode(s.stranger.pk), text: 'oi' })
  assert.equal(r.status, 'REFUSED')
  assert.equal(s.relay.store.count(), 0)
  s.c.close(); await s.relay.close()
})

test('agent with no allowlist can message nobody', async () => {
  const s = await setup({ allow: [] })
  assert.equal((await s.tools.send({ to: npubEncode(s.friend.pk), text: 'oi' })).status, 'REFUSED')
  s.c.close(); await s.relay.close()
})

test('dry run sends nothing and does not spend the daily budget', async () => {
  const s = await setup({ perDay: 1 })
  const r = await s.tools.send({ to: npubEncode(s.friend.pk), text: 'oi', dry_run: true })
  assert.equal(r.status, 'DRY_RUN')
  assert.equal(s.relay.store.count(), 0)
  assert.equal(s.tools.whoami().left_today, 1)
  s.c.close(); await s.relay.close()
})

test('non-boolean dry_run is refused instead of sending for real', async () => {
  const s = await setup()
  const r = await s.tools.send({ to: npubEncode(s.friend.pk), text: 'oi', dry_run: 'yes' })
  assert.equal(r.status, 'REFUSED')
  assert.equal(s.relay.store.count(), 0)
  s.c.close(); await s.relay.close()
})

test('daily cap stops the agent and resets the next day', async () => {
  let t = Date.parse('2026-11-15T12:00:00Z')
  const s = await setup({ perDay: 2, now: () => t })
  const to = npubEncode(s.friend.pk)
  assert.equal((await s.tools.send({ to, text: '1' })).status, 'SENT')
  assert.equal((await s.tools.send({ to, text: '2' })).status, 'SENT')
  assert.equal((await s.tools.send({ to, text: '3' })).status, 'REFUSED')
  t += 24 * 3600 * 1000
  assert.equal((await s.tools.send({ to, text: '4' })).status, 'SENT')
  s.c.close(); await s.relay.close()
})

test('friend receives the agent message marked as written by the agent', async () => {
  const s = await setup()
  await s.tools.send({ to: npubEncode(s.friend.pk), text: 'reunião às 15h' })
  const cf = await online(s.url, s.friend)
  const inbox = await readInbox(cf, s.friend.sk)
  assert.equal(inbox[0].text, 'reunião às 15h')
  assert.equal(inbox[0].agent, 'claude')
  cf.close(); s.c.close(); await s.relay.close()
})

test('agent reads the owner inbox, capped at 7 days', async () => {
  const s = await setup()
  await s.tools.send({ to: npubEncode(s.friend.pk), text: 'oi' })
  const msgs = await s.tools.read({ hours: 10_000 })
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].mine, true)
  s.c.close(); await s.relay.close()
})
