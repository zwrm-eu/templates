#!/usr/bin/env node
// `network` MCP server: lets the agent decide, per site, whether its browser
// goes direct or through the agent's proxy, and remembers the choice in the
// workspace (routes.mjs). The person never has to; the agent switches when a
// site blocks it and keeps what works.
//
// The proxy itself lives on the host (zwrm-eu/zwrm#1692): the host's egress
// gateway holds its credentials and enforces the organization's network
// policy on both routes. These tools only choose the route; they cannot
// reach a site the policy blocks, and they say so instead of retrying.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { normalizeDomain, setRoute } from './routes.mjs'
import { ROUTER_PORT, ensureRouter, routerStatus } from './site-router.mjs'

const NOT_CONFIGURED =
  'No proxy is configured for this agent, so every site uses the VM\'s own network. If a site keeps blocking ' +
  'you, tell the person it refuses datacenter networks; an admin can add a proxy (agent secret BROWSER_PROXY), ' +
  'after which you can route that site through it.'

const POLICY_BLOCKED =
  'is blocked by the organization\'s network policy. No route reaches it: do not retry or switch routes; ' +
  'tell the person the site is blocked by their organization\'s policy, which an organization admin can change.'

// status returns the running router's view (restarting a router that died),
// or null when it cannot be reached.
async function status() {
  if ((await ensureRouter().catch(() => 'down')) !== 'up') return null
  return routerStatus().catch(() => null)
}

// blockedReason returns the policy's reason for refusing domain (or a
// subdomain of it), from the router's recent blocks.
function blockedReason(st, domain) {
  const b = st?.blocked?.find((x) => x.host === domain || x.host.endsWith(`.${domain}`) || domain.endsWith(`.${x.host}`))
  return b?.reason
}

// Ask the running router to re-read routes now (and drop tunnels whose route
// changed), so a reload uses the new route at once. The router also re-reads
// on its own every few seconds, so a failure here only delays the switch.
async function notifyRouter() {
  await ensureRouter().catch(() => {}) // a router that died comes back
  try {
    await fetch(`http://127.0.0.1:${ROUTER_PORT}/__zwrm/reload`, { method: 'POST', signal: AbortSignal.timeout(2000) })
  } catch {}
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

const server = new McpServer({ name: 'zwrm-network', version: '0.2.0' })

server.registerTool('proxy_status', {
  description: 'Show whether a proxy is available for the browser, which sites go through it, and which sites ' +
    'the organization\'s network policy recently blocked. Call it when a page fails with ' +
    'ERR_TUNNEL_CONNECTION_FAILED or "Blocked by your organization\'s network policy" before trying anything else.',
  inputSchema: {},
}, async () => {
  const st = await status()
  if (!st) {
    return text('The browser\'s site router is not running, so the browser cannot reach any site. ' +
      'Close the browser (browser_close) and open the page again; if that does not help, tell the person.', true)
  }
  const lines = []
  if (st.gateway?.proxy) {
    lines.push(`A proxy is configured. Sites routed through it: ${st.sites.length ? st.sites.join(', ') : 'none'}. All other sites go direct.`)
  } else {
    lines.push(NOT_CONFIGURED)
  }
  if (st.gateway?.restricted) {
    lines.push('The organization limits which sites this agent may reach (a network policy, set by an admin).')
  }
  if (st.blocked?.length) {
    lines.push('Recently blocked by the organization\'s network policy (no route reaches these; tell the person):')
    for (const b of st.blocked.slice(0, 10)) lines.push(`- ${b.host}: ${b.reason}`)
  }
  return text(lines.join('\n'))
})

server.registerTool('use_proxy', {
  description: 'Route a site through the proxy from now on, for this workspace (remembered across sessions). ' +
    'Use it when a site blocks the browser: "Access Denied", "You don\'t have permission", an endless ' +
    '"Just a moment…" or "verify you are human" check, ERR_HTTP2_PROTOCOL_ERROR or connection resets on one ' +
    'site while others load. Then reload the page. Do not ask the person first; this is a routine switch. ' +
    'Not for a mistyped or unreachable address (ERR_NAME_NOT_RESOLVED), and not for a site the organization\'s ' +
    'network policy blocks (check proxy_status): a proxy does not fix those.',
  inputSchema: { domain: z.string().describe('The site, e.g. "meinestadt.de" or a URL; subdomains are included') },
}, async ({ domain }) => {
  let d
  try {
    d = normalizeDomain(domain)
  } catch (err) {
    return text(String(err.message || err), true)
  }
  const st = await status()
  const reason = blockedReason(st, d)
  if (reason) return text(`${d} ${POLICY_BLOCKED} (${reason})`, true)
  if (!st?.gateway?.proxy) return text(NOT_CONFIGURED, true)
  try {
    const r = await setRoute(d, 'proxy')
    await notifyRouter()
    return text(`${r.domain} now goes through the proxy (remembered). Reload the page. ` +
      `If it is still blocked, the site refuses this proxy too: switch it back with use_direct and tell the person.`)
  } catch (err) {
    return text(String(err.message || err), true)
  }
})

server.registerTool('use_direct', {
  description: 'Route a site directly from this VM again (remembered). Use it when a site fails or hangs ' +
    'through the proxy but worked before, or after use_proxy did not help.',
  inputSchema: { domain: z.string().describe('The site, e.g. "google.com" or a URL') },
}, async ({ domain }) => {
  try {
    const r = await setRoute(domain, 'direct')
    await notifyRouter()
    return text(`${r.domain} now goes direct (remembered). Reload the page.`)
  } catch (err) {
    return text(String(err.message || err), true)
  }
})

await server.connect(new StdioServerTransport())
