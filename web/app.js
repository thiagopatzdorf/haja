// Haja web client. History lives on this device (localStorage); the relay keeps 7 days at most.
import { connect, finalizeEvent, generateSecretKey, getPublicKey, npubEncode, nsecEncode, openWrap, parsePubkey, parseSecret, readInbox, sendText } from './vendor/nostr.js'

const $ = (id) => document.getElementById(id)
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('haja.' + k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem('haja.' + k, JSON.stringify(v)) } catch {} },
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const relayUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host

let sk = null
let me = null
let client = null
let current = null
let contacts = store.get('contacts', {}) // pubkey -> { name }
let chats = store.get('history', {}) // pubkey -> [{id, from, text, at, agent}]

function status(t) { $('status').textContent = t || '' }

function boot() {
  const saved = store.get('key', null)
  if (saved) return start(parseSecret(saved))
  $('welcome').hidden = false
  $('create').onclick = () => {
    const key = generateSecretKey()
    store.set('key', hex(key))
    start(key, $('name').value.trim())
  }
  $('doImport').onclick = () => {
    try {
      const key = parseSecret($('import').value)
      store.set('key', hex(key))
      start(key)
    } catch { status('That is not a valid secret key.') }
  }
}

async function start(key, name) {
  sk = key
  me = getPublicKey(sk)
  $('welcome').hidden = true
  $('app').hidden = false
  status('Connecting…')
  try {
    client = await connect(relayUrl, sk)
  } catch (e) { return status(e.message) }
  status('')
  const profile = store.get('profile', {})
  if (name) profile.name = name
  store.set('profile', profile)
  // The relay forgets everything after 7 days, so the profile is republished on every start.
  if (profile.name) client.publish(finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ name: profile.name }) }, sk))

  for (const m of await readInbox(client, sk)) keep(m)
  client.subscribe([{ kinds: [1059], '#p': [me], since: Math.floor(Date.now() / 1000) - 2 * 24 * 3600 }], {
    onEvent: (w) => { const m = openWrap(sk, w); if (m) keep(m) },
  })
  addFromHash()
  window.addEventListener('hashchange', addFromHash)
  renderContacts()
  fetchNames()
}

function peerOf(m) { return m.from === me ? m.to : m.from }

function keep(m) {
  const peer = peerOf(m)
  if (!peer) return
  if (!contacts[peer]) { contacts[peer] = { name: null }; store.set('contacts', contacts); fetchNames() }
  const list = chats[peer] || (chats[peer] = [])
  if (list.some((x) => x.id === m.id)) return
  list.push({ id: m.id, from: m.from, text: m.text, at: m.at, agent: m.agent })
  list.sort((a, b) => a.at - b.at)
  store.set('history', chats)
  renderContacts()
  if (current === peer) renderMessages()
}

async function fetchNames() {
  const pks = Object.keys(contacts)
  if (!pks.length || !client) return
  for (const ev of await client.query([{ kinds: [0], authors: pks }])) {
    try { contacts[ev.pubkey].name = JSON.parse(ev.content).name || null } catch {}
  }
  store.set('contacts', contacts)
  renderContacts()
}

const label = (pk) => contacts[pk]?.name || npubEncode(pk).slice(0, 14) + '…'

function renderContacts() {
  const ul = $('contacts')
  ul.replaceChildren()
  // Names arrive after the chat is open (kind 0 query); keep the header in step with them.
  if (current) $('peer').textContent = label(current)
  const order = Object.keys(contacts).sort((a, b) => (chats[b]?.at(-1)?.at || 0) - (chats[a]?.at(-1)?.at || 0))
  for (const pk of order) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.className = 'contact' + (pk === current ? ' on' : '')
    btn.textContent = label(pk)
    const last = chats[pk]?.at(-1)
    if (last) { const s = document.createElement('small'); s.textContent = last.text.slice(0, 40); btn.append(s) }
    btn.onclick = () => open(pk)
    li.append(btn)
    ul.append(li)
  }
}

function open(pk) {
  current = pk
  document.body.classList.add('in-chat')
  $('empty').hidden = true
  $('chatHead').hidden = false
  $('sendForm').hidden = false
  $('peer').textContent = label(pk)
  renderContacts()
  renderMessages()
  $('text').focus()
}

function renderMessages() {
  const ol = $('messages')
  ol.replaceChildren()
  for (const m of chats[current] || []) {
    const li = document.createElement('li')
    li.className = m.from === me ? 'mine' : 'theirs'
    const p = document.createElement('p')
    p.textContent = m.text
    li.append(p)
    const meta = document.createElement('small')
    meta.textContent = new Date(m.at * 1000).toLocaleString() + (m.agent ? ` · written by ${m.agent} (agent)` : '')
    li.append(meta)
    ol.append(li)
  }
  ol.scrollTop = ol.scrollHeight
}

function addContact(input) {
  try {
    const raw = input.includes('#to=') ? input.split('#to=')[1] : input
    const pk = parsePubkey(raw)
    if (pk === me) return status('That is you.')
    if (!contacts[pk]) { contacts[pk] = { name: null }; store.set('contacts', contacts) }
    fetchNames()
    open(pk)
    status('')
  } catch { status('That is not a Haja ID.') }
}

function addFromHash() {
  const m = location.hash.match(/#to=(npub1[0-9a-z]+)/)
  if (m) { addContact(m[1]); window.history.replaceState(null, '', location.pathname) }
}

$('addForm').onsubmit = (e) => { e.preventDefault(); addContact($('add').value.trim()); $('add').value = '' }
$('sendForm').onsubmit = async (e) => {
  e.preventDefault()
  const text = $('text').value
  if (!text.trim() || !current) return
  $('text').value = ''
  try {
    await sendText(client, sk, current, text)
    status('')
  } catch (err) { status(err.message); $('text').value = text }
}
$('back').onclick = () => { document.body.classList.remove('in-chat'); current = null; renderContacts() }
$('me').onclick = () => {
  const link = `${location.origin}/#to=${npubEncode(me)}`
  $('myLink').value = link
  $('wa').href = 'https://wa.me/?text=' + encodeURIComponent(`Talk to me on Haja, no phone number needed: ${link}`)
  $('nsec').hidden = true
  $('meDialog').showModal()
}
$('copy').onclick = async () => { try { await navigator.clipboard.writeText($('myLink').value); status('Link copied.') } catch { $('myLink').select() } }
$('reveal').onclick = () => { $('nsec').value = nsecEncode(sk); $('nsec').hidden = false }

boot()
