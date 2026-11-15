# Haja

<!-- resumo: Haja, mensageiro sem telefone e sem e-mail sobre Nostr: relay com AUTH, teto por chave e nada guardado mais de 7 dias; cliente web; MCP para o agente de IA da própria pessoa mandar mensagem em nome dela, com lista de quem pode receber e teto por dia. MIT. -->

**A messenger with no phone number, no email, and room for your own AI agents.**

I was sick of Meta's business model for WhatsApp, and sick of handing my phone number to everyone I want to talk to.
So Haja: your identity is a key made on your device. You share a link, not a number.

```
you (browser, key never leaves it) ──► Haja relay ◄── your friend
                                        ▲
your AI agent (Claude, ChatGPT, local) ─┘ via MCP, with limits you set
```

## What it does today (v0)

| | |
|---|---|
| **No phone, no email** | Your account is a [Nostr](https://nostr.com) key pair created in the browser. Share `https://<host>/#to=npub…` and people can reach you. |
| **End-to-end encrypted** | Private messages are NIP-17: sealed with NIP-44 and gift-wrapped (NIP-59). The relay sees "someone wrote to this key", not who, and never the text. |
| **Gone in 7 days** | The relay deletes everything 7 days after receiving it. The cap is a constant in code (`MAX_RETENTION_S`), not a setting: configuring more is clamped back. Your history lives on your device. |
| **Your agent, not ours** | `mcp/server.mjs` lets *your* AI agent read and send on your behalf. You choose who it may message (`HAJA_ALLOW`) and how many per day (`HAJA_PER_DAY`). Every message it sends is labelled "written by <agent>" for the person receiving it. Haja runs no AI and pays for none. |
| **Anti-spam without identity checks** | Writing needs NIP-42 AUTH, each key is rate-limited, and only the event kinds a messenger needs are accepted (no public feed to spam). |
| **One process** | The relay also serves the web client. `node:sqlite`, no other database. |

## Run it

Node 22.13 or newer.

```bash
npm install
npm start                 # relay + web client on http://localhost:7777
npm test                  # 29 tests: relay rules, encryption, agent limits
node tests/web.e2e.mjs    # real browser: two people chat, then an agent writes (needs Playwright)
```

Settings (environment): `PORT` (7777), `HAJA_DB` (`haja.db`), `HAJA_EVENTS_PER_MINUTE` (60), `HAJA_RETENTION_S` (604800, cannot go higher).

Put it behind TLS (Caddy, a Cloudflare tunnel, anything) so the browser uses `wss://`.

## Give your agent a Haja

```json
{
  "mcpServers": {
    "haja": {
      "command": "node",
      "args": ["/path/to/haja/mcp/server.mjs"],
      "env": {
        "HAJA_RELAY": "wss://your-relay",
        "HAJA_KEY": "nsec1… (export it from the web app: My ID → Back up my key)",
        "HAJA_ALLOW": "npub1friend…,npub1other…",
        "HAJA_PER_DAY": "50",
        "HAJA_AGENT_NAME": "claude"
      }
    }
  }
}
```

Tools: `haja_whoami`, `haja_read` (up to 168 hours), `haja_send` (with `dry_run`). An empty `HAJA_ALLOW` means the agent can message nobody; `*` means anyone.

## What it does not do yet

Said plainly, so nobody finds out the hard way:

- **No hosted service yet.** You run your own relay for now.
- **Your key sits in the browser's localStorage**, not behind a passkey. Clear the site data without a backup and the account is gone. Passkey protection is next.
- **The MCP server holds your key** on your machine. The plan is NIP-46 remote signing, so the agent asks to sign and never sees the key.
- **No voice notes, photos, groups or calls.** Voice and photos are next (encrypted files that also expire in 7 days); groups after.
- **No push notifications and no mobile app.** The web app works on a phone browser.
- **Offline for more than 7 days = you miss what arrived meanwhile.** That is the price of not keeping your messages.
- **One relay, one SQLite file.** Nostr lets each person name their own inbox relay (NIP-65), which is how it will scale out; that is not built.

## Why Nostr

Identity is a key, so there is no number to collect and no account to lock you into: you can take your key to any other Nostr relay or client. Bots and agents are just more keys. We run the relays and keep them fast; the protocol keeps the exit open.

## License

MIT.
