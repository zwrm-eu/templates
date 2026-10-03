#!/usr/bin/env node
// `network` MCP server: lets the agent decide, per site, whether its browser
// goes direct or through the agent's proxy (BROWSER_PROXY), and remembers the
// choice in the workspace (routes.mjs). The person never has to; the agent
// switches when a site blocks it and keeps what works.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { effectiveProxySites, loadRoutes, normalizeDomain, setRoute } from './routes.mjs'
import { ROUTER_PORT } from './site-router.mjs'

const configured = Boolean(process.env.BROWSER_PROXY)

const NOT_CONFIGURED =
  'No proxy is configured for this agent, so every site uses the VM\'s own network. If a site keeps blocking ' +
  'you, tell the person it refuses datacenter networks; an admin can add a proxy (agent secret BROWSER_PROXY), ' +
  'after which you can route that site through it.'

// Ask the running router to re-read routes now (and drop tunnels whose route
// changed), so a reload uses the new route at once. The router also re-reads
// on its own every few seconds, so a failure here only delays the switch.
async function notifyRouter() {
  try {
    await fetch(`http://127.0.0.1:${ROUTER_PORT}/__zwrm/reload`, { method: 'POST', signal: AbortSignal.timeout(2000) })
  } catch {}
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

const server = new McpServer({ name: 'zwrm-network', version: '0.1.0' })

server.registerTool('proxy_status', {
  description: 'Show whether a proxy is available for the browser and which sites currently go through it. ' +
    'Every other site goes direct from this VM.',
  inputSchema: {},
}, async () => {
  if (!configured) return text(NOT_CONFIGURED)
  const sites = effectiveProxySites(await loadRoutes())
  return text(`A proxy is configured. Sites routed through it: ${sites.length ? sites.join(', ') : 'none'}. ` +
    'All other sites go direct.')
})

server.registerTool('use_proxy', {
  description: 'Route a site through the proxy from now on, for this workspace (remembered across sessions). ' +
    'Use it when a site blocks the browser: "Access Denied", "You don\'t have permission", an endless ' +
    '"Just a moment…" or "verify you are human" check, ERR_HTTP2_PROTOCOL_ERROR or connection resets on one ' +
    'site while others load. Then reload the page. Do not ask the person first; this is a routine switch.',
  inputSchema: { domain: z.string().describe('The site, e.g. "meinestadt.de" or a URL; subdomains are included') },
}, async ({ domain }) => {
  if (!configured) return text(NOT_CONFIGURED, true)
  try {
    const r = await setRoute(domain, 'proxy')
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
    if (configured) await notifyRouter()
    return text(`${r.domain} now goes direct (remembered). Reload the page.`)
  } catch (err) {
    return text(String(err.message || err), true)
  }
})

await server.connect(new StdioServerTransport())
