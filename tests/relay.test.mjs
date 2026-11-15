import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent } from 'nostr-tools/pure'
import { wrapText } from '../lib/messages.js'
import { MAX_RETENTION_S, createRelay } from '../relay/relay.mjs'
import { online, person, raw, startRelay } from './helpers.mjs'

const profile = (p, t, name = 'x') => finalizeEvent({ kind: 0, created_at: t, tags: [], content: JSON.stringify({ name }) }, p.sk)

test('stranger without AUTH cannot publish anything', async () => {
  const { relay, url, clock } = await startRelay()
  const a = person()
  const s = await raw(url)
  await s.next((m) => m[0] === 'AUTH')
  const ev = profile(a, clock.t)
  s.send(['EVENT', ev])
  const ok = await s.next((m) => m[0] === 'OK')
  assert.equal(ok[2], false)
  assert.match(ok[3], /^auth-required/)
  assert.equal(relay.store.count(), 0)
  s.close(); await relay.close()
})

test('private messages are refused to an unauthenticated subscription', async () => {
  const { relay, url } = await startRelay()
  const s = await raw(url)
  s.send(['REQ', 'x', { kinds: [1059] }])
  const closed = await s.next((m) => m[0] === 'CLOSED')
  assert.match(closed[2], /^auth-required/)
  s.close(); await relay.close()
})

test('auth with the wrong challenge does not authenticate', async () => {
  const { relay, url, clock } = await startRelay()
  const a = person()
  const s = await raw(url)
  await s.next((m) => m[0] === 'AUTH')
  s.send(['AUTH', finalizeEvent({ kind: 22242, created_at: clock.t, tags: [['challenge', 'nope']], content: '' }, a.sk)])
  const ok = await s.next((m) => m[0] === 'OK')
  assert.equal(ok[2], false)
  s.close(); await relay.close()
})

test('event with forged signature is refused even after AUTH', async () => {
  const { relay, url, clock } = await startRelay()
  const a = person()
  const c = await online(url, a)
  const ev = { ...profile(a, clock.t), content: '{"name":"changed after signing"}' }
  const r = await c.publish(ev)
  assert.equal(r.ok, false)
  assert.match(r.message, /^invalid/)
  c.close(); await relay.close()
})

test('kinds a messenger does not need (public notes) are blocked', async () => {
  const { relay, url, clock } = await startRelay()
  const a = person()
  const c = await online(url, a)
  const r = await c.publish(finalizeEvent({ kind: 1, created_at: clock.t, tags: [], content: 'spam' }, a.sk))
  assert.equal(r.ok, false)
  assert.match(r.message, /^blocked/)
  c.close(); await relay.close()
})

test('gift wrap is never served to someone it is not addressed to', async () => {
  const { relay, url } = await startRelay()
  const [a, b, eve] = [person(), person(), person()]
  const ca = await online(url, a)
  const ce = await online(url, eve)
  const { wraps } = wrapText(a.sk, b.pk, 'only for bob')
  for (const w of wraps) assert.equal((await ca.publish(w)).ok, true)
  // Eve asks for everything, including explicitly Bob's tag: she gets nothing.
  assert.equal((await ce.query([{ kinds: [1059] }])).length, 0)
  assert.equal((await ce.query([{ kinds: [1059], '#p': [b.pk] }])).length, 0)
  ca.close(); ce.close(); await relay.close()
})

test('live gift wrap reaches only its addressee', async () => {
  const { relay, url } = await startRelay()
  const [a, b, eve] = [person(), person(), person()]
  const ca = await online(url, a)
  const cb = await online(url, b)
  const ce = await online(url, eve)
  const got = { b: 0, eve: 0 }
  await new Promise((r) => cb.subscribe([{ kinds: [1059], '#p': [b.pk] }], { onEvent: () => got.b++, onEose: r }))
  await new Promise((r) => ce.subscribe([{ kinds: [1059] }], { onEvent: () => got.eve++, onEose: r }))
  for (const w of wrapText(a.sk, b.pk, 'hi').wraps) await ca.publish(w)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(got.b, 1)
  assert.equal(got.eve, 0)
  ca.close(); cb.close(); ce.close(); await relay.close()
})

test('nothing survives past 7 days even if created_at says it is recent', async () => {
  const { relay, url, clock } = await startRelay()
  const [a, b] = [person(), person()]
  const ca = await online(url, a)
  for (const w of wrapText(a.sk, b.pk, 'old').wraps) await ca.publish(w)
  await ca.publish(profile(a, clock.t))
  assert.equal(relay.store.count(), 3)
  clock.t += MAX_RETENTION_S - 1
  assert.equal(relay.sweep(), 0)
  clock.t += 1
  assert.equal(relay.sweep(), 3)
  assert.equal(relay.store.count(), 0)
  ca.close(); await relay.close()
})

test('expired-but-not-yet-swept events are not served', async () => {
  const { relay, url, clock } = await startRelay()
  const a = person()
  const ca = await online(url, a)
  await ca.publish(profile(a, clock.t))
  clock.t += MAX_RETENTION_S
  assert.equal((await ca.query([{ kinds: [0], authors: [a.pk] }])).length, 0)
  ca.close(); await relay.close()
})

test('retention cannot be configured above 7 days', async () => {
  const relay = createRelay({ retentionS: 365 * 24 * 3600 })
  assert.equal(relay.retention, MAX_RETENTION_S)
  assert.deepEqual(relay.info.retention, [{ time: MAX_RETENTION_S }])
  await relay.close()
})

test('a shorter NIP-40 expiration is honored', async () => {
  const { relay, url, clock } = await startRelay()
  const a = person()
  const ca = await online(url, a)
  await ca.publish(finalizeEvent({ kind: 0, created_at: clock.t, tags: [['expiration', String(clock.t + 60)]], content: '{}' }, a.sk))
  clock.t += 60
  assert.equal(relay.sweep(), 1)
  ca.close(); await relay.close()
})

test('event dated far in the future is refused', async () => {
  const { relay, url, clock } = await startRelay()
  const a = person()
  const ca = await online(url, a)
  const r = await ca.publish(profile(a, clock.t + 3600))
  assert.equal(r.ok, false)
  ca.close(); await relay.close()
})

test('a key that floods gets rate-limited', async () => {
  const { relay, url, clock } = await startRelay({ eventsPerMinute: 3 })
  const [a, b] = [person(), person()]
  const ca = await online(url, a)
  const results = []
  for (let i = 0; i < 4; i++) results.push(await ca.publish(wrapText(a.sk, b.pk, `m${i}`).wraps[0]))
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false])
  assert.match(results[3].message, /^rate-limited/)
  clock.t += 60
  assert.equal((await ca.publish(wrapText(a.sk, b.pk, 'later').wraps[0])).ok, true)
  ca.close(); await relay.close()
})

test('profile update replaces the old one instead of piling up', async () => {
  const { relay, url, clock } = await startRelay()
  const a = person()
  const ca = await online(url, a)
  await ca.publish(profile(a, clock.t, 'old'))
  await ca.publish(profile(a, clock.t + 1, 'new'))
  const got = await ca.query([{ kinds: [0], authors: [a.pk] }])
  assert.equal(got.length, 1)
  assert.equal(JSON.parse(got[0].content).name, 'new')
  ca.close(); await relay.close()
})

test('NIP-09 deletion only removes the author\'s own events', async () => {
  const { relay, url, clock } = await startRelay()
  const [a, b] = [person(), person()]
  const ca = await online(url, a)
  const cb = await online(url, b)
  const ev = profile(a, clock.t)
  await ca.publish(ev)
  await cb.publish(finalizeEvent({ kind: 5, created_at: clock.t, tags: [['e', ev.id]], content: '' }, b.sk))
  assert.equal(relay.store.count(), 1)
  await ca.publish(finalizeEvent({ kind: 5, created_at: clock.t, tags: [['e', ev.id]], content: '' }, a.sk))
  assert.equal(relay.store.count(), 0)
  ca.close(); cb.close(); await relay.close()
})

test('relay info document (NIP-11) states auth and the 7-day retention', async () => {
  const { relay, url } = await startRelay()
  const res = await fetch(url.replace('ws', 'http'), { headers: { accept: 'application/nostr+json' } })
  const info = await res.json()
  assert.equal(info.limitation.auth_required, true)
  assert.equal(info.retention[0].time, MAX_RETENTION_S)
  assert.ok(info.supported_nips.includes(17))
  await relay.close()
})

test('static server does not leak files outside web/', async () => {
  const { relay, url } = await startRelay()
  const base = url.replace('ws', 'http')
  for (const p of ['/../relay/store.mjs', '/%2e%2e/relay/store.mjs', '/..%2frelay%2fstore.mjs']) {
    const res = await fetch(base + p)
    assert.notEqual(res.status, 200, p)
  }
  await relay.close()
})
