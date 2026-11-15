#!/usr/bin/env node
// Haja MCP server (stdio). Plug it into YOUR agent (Claude Desktop, Claude Code, any MCP client):
//
//   HAJA_RELAY=wss://relay.example  HAJA_KEY=nsec1...  HAJA_ALLOW=npub1...,npub1...  node mcp/server.mjs
//
// It runs on your machine with your key; nothing about the agent runs on the Haja server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { connect } from '../lib/client.js'
import { parseSecret } from '../lib/messages.js'
import { createTools } from './tools.mjs'

const relay = process.env.HAJA_RELAY
const key = process.env.HAJA_KEY
if (!relay || !key) {
  console.error('haja-mcp: set HAJA_RELAY and HAJA_KEY (your nsec)')
  process.exit(1)
}
const secretKey = parseSecret(key)
const client = await connect(relay, secretKey)
const tools = createTools({
  client,
  secretKey,
  allow: (process.env.HAJA_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
  perDay: Number(process.env.HAJA_PER_DAY || 50),
  agentName: process.env.HAJA_AGENT_NAME || 'agent',
})

const out = (x) => ({ content: [{ type: 'text', text: JSON.stringify(x, null, 2) }] })
const server = new McpServer({ name: 'haja', version: '0.1.0' })

server.registerTool('haja_whoami', {
  description: 'Who this agent speaks for on Haja, who it may message and how many messages are left today.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => out(tools.whoami()))

server.registerTool('haja_read', {
  description: 'Read the owner\'s Haja messages from the last N hours (max 168: the relay keeps nothing older than 7 days).',
  inputSchema: { hours: z.number().int().min(1).max(168).optional(), from: z.string().optional().describe('npub of one contact') },
  annotations: { readOnlyHint: true },
}, async (args) => out(await tools.read(args)))

server.registerTool('haja_send', {
  description: 'Send a private, end-to-end encrypted message on the owner\'s behalf. The recipient sees it was written by an agent. Use dry_run first when unsure.',
  inputSchema: { to: z.string().describe('npub of the recipient'), text: z.string(), dry_run: z.boolean().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async (args) => out(await tools.send(args)))

await server.connect(new StdioServerTransport())
