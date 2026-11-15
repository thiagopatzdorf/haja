// End-to-end in a real browser: two people, no phone, no email, talk through the relay;
// then the owner's agent (MCP tools) writes and the friend sees the "agent" label.
// Run: node tests/web.e2e.mjs [screenshot-dir]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRelay } from '../relay/relay.mjs'
import { connect } from '../lib/client.js'
import { parsePubkey, parseSecret } from '../lib/messages.js'
import { createTools } from '../mcp/tools.mjs'

// Playwright is preinstalled globally in CI boxes; require() resolves it where ESM import would not.
const { chromium } = createRequire(import.meta.url)('playwright')
const shots = process.argv[2]
const relay = createRelay({ port: 0 })
const wsUrl = await relay.listen()
const base = wsUrl.replace('ws://', 'http://')
const browser = await chromium.launch()
try {
  const ana = await (await browser.newContext({ viewport: { width: 390, height: 780 } })).newPage()
  const bia = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage()
  for (const [p, name] of [[ana, 'Ana'], [bia, 'Bia']]) {
    await p.goto(base)
    await p.fill('#name', name)
    await p.click('#create')
    await p.waitForSelector('#app:not([hidden])')
  }
  await bia.click('#me')
  const biaLink = await bia.inputValue('#myLink')
  await bia.click('#meDialog form button')

  await ana.goto(biaLink.replace(/^https?:\/\/[^/]+/, base))
  await ana.waitForSelector('#sendForm:not([hidden])')
  await ana.fill('#text', 'Oi Bia! Sem telefone, sem e-mail.')
  await ana.click('#sendForm button')

  await bia.waitForSelector('#contacts .contact')
  await bia.click('#contacts .contact')
  await bia.waitForSelector('#messages li.theirs >> text=Sem telefone')
  await bia.fill('#text', 'Funcionou 🕊️')
  await bia.click('#sendForm button')
  await ana.waitForSelector('#messages li.theirs >> text=Funcionou')
  assert.equal(await ana.textContent('#peer'), 'Bia')

  // Ana's own agent, with her key, allowed to talk to Bia only.
  const anaKey = parseSecret(JSON.parse(await ana.evaluate(() => localStorage.getItem('haja.key'))))
  const biaPk = parsePubkey(biaLink.split('#to=')[1])
  const c = await connect(wsUrl, anaKey)
  const tools = createTools({ client: c, secretKey: anaKey, allow: [biaLink.split('#to=')[1]], agentName: 'claude' })
  const r = await tools.send({ to: biaLink.split('#to=')[1], text: 'Lembrete da Ana: almoço amanhã às 12h.' })
  assert.equal(r.status, 'SENT', JSON.stringify(r))
  await bia.waitForSelector('#messages li.theirs >> text=written by claude (agent)')
  c.close()
  assert.ok(biaPk)

  if (shots) {
    await ana.screenshot({ path: `${shots}/haja-celular.png` })
    await bia.screenshot({ path: `${shots}/haja-desktop.png` })
  }
  console.log('e2e ok: browser to browser, and agent to browser with the agent label')
} finally {
  await browser.close()
  await relay.close()
}
