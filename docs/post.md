# Post de lançamento (rascunho)

Cada frase abaixo tem prova no repositório (testes ou o e2e no navegador). Antes de mudar o texto, confira se a
frase nova continua verdade no código; "o que não faz" fica no post de propósito.

## X / Threads (EN)

I was sick of Meta's WhatsApp business model.
And sick of giving my phone number to everyone I want to talk to.

So I built my own messenger. It's called Haja.

- no phone number, no email: your account is a key made on your device
- end-to-end encrypted
- the server deletes everything after 7 days, and that limit is hard-coded
- your own AI agent (Claude, ChatGPT, whatever) can message on your behalf through MCP, only to the people you allow, and the other side sees it was the agent

Open source, MIT. Built on Nostr.
github.com/thiagopatzdorf/haja

## LinkedIn (EN, versão longa)

I was sick of Meta's business model for WhatsApp: a company that charges per message to talk to your own customers, and a phone number as the price of every conversation.

So I built my own messenger. Haja.

What it does today:
→ No phone number. No email. Your account is a cryptographic key created on your device. You share a link, not your number.
→ End-to-end encrypted (Nostr NIP-17). The server sees that someone wrote to someone, never who or what.
→ The server forgets everything after 7 days. Not a policy: a constant in the code. Your history lives on your phone.
→ Built for AI agents. Plug your own agent in through MCP and it can read and send for you, only to the people you allow, with a daily cap. Every message it writes is labelled as written by the agent.
→ We pay for no AI. Your agent is yours.

What it doesn't do yet: voice notes, groups, push notifications, a mobile app. They're next, in the open.

Open source (MIT), built on Nostr, so your key works in other apps too. Nobody gets locked in, including by us.

github.com/thiagopatzdorf/haja

## X / Threads (PT-BR)

Cansei do modelo de negócio da Meta no WhatsApp.
E cansei de dar meu telefone pra todo mundo com quem eu quero conversar.

Então fiz o meu próprio mensageiro. Haja.

- sem telefone e sem e-mail: tua conta é uma chave criada no teu aparelho
- cifrado de ponta a ponta
- o servidor apaga tudo em 7 dias, e o limite está no código
- teu agente de IA (Claude, ChatGPT, o que for) manda mensagem por ti via MCP, só pra quem tu deixar, e quem recebe vê que foi o agente

Código aberto, MIT. Em cima do Nostr.
github.com/thiagopatzdorf/haja
