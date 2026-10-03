#!/usr/bin/env node
// Per-site router for the agent's browser. Chromium always uses this local
// proxy (127.0.0.1:ROUTER_PORT); for each connection it decides, by host,
// whether the site goes direct or through the agent's proxy, using the
// routes in routes.mjs.
//
// Both routes run through the host's egress gateway (zwrm-eu/zwrm#1692),
// at the VM's default gateway, whenever the gateway offers a proxy or the
// agent runs under a network policy: the gateway holds the proxy's
// credentials (they never enter the VM) and enforces the organization's
// policy on either route. A site the policy blocks is refused with a reason,
// which the router keeps for the `network` tools to report. With neither a
// proxy nor a policy (or on a host without a gateway), the router connects
// directly.
//
//   site-router.mjs --ensure   start the router detached unless it already runs
//   site-router.mjs            run in the foreground
//
// Routes and the gateway's status are re-read on POST /__zwrm/reload (the
// `network` tools call it after a change) and every few seconds. A reload
// closes open tunnels whose route changed, so the browser's next request
// reconnects the new way instead of reusing a pooled connection.

import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { openSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { effectiveProxySites, loadRoutes, routeFor, ruleMap } from './routes.mjs'

export const ROUTER_PORT = 18080
// The host's egress gateway: an HTTP proxy at the VM's default gateway.
export const GATEWAY_PORT = 1339
const RELOAD_EVERY_MS = 5000
// GET /__zwrm/health answers this, so --ensure can tell the router from any
// other program that happens to hold the port.
const HEALTH_MARKER = 'zwrm-site-router'
const MAX_BLOCKS = 20

// defaultGateway reads the IPv4 default gateway from /proc/net/route text.
export function defaultGateway(text) {
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f[1] === '00000000' && /^[0-9A-Fa-f]{8}$/.test(f[2] || '')) {
      const n = parseInt(f[2], 16)
      return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.')
    }
  }
  return null
}

function readGatewayAddr() {
  try {
    return defaultGateway(readFileSync('/proc/net/route', 'utf8'))
  } catch {
    return null
  }
}

// gatewayStatus asks the host gateway what it offers this VM:
// { available, proxy, restricted }.
export async function gatewayStatus(base) {
  if (!base) return { available: false, proxy: false, restricted: false }
  try {
    const r = await fetch(`${base}/__zwrm/egress`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return { available: false, proxy: false, restricted: false }
    const s = await r.json()
    return { available: true, proxy: Boolean(s.proxy), restricted: Boolean(s.restricted) }
  } catch (err) {
    // Refused: no gateway on this host. Anything else (a slow answer, a
    // reset) is transient: the caller keeps what it knew.
    if (err?.cause?.code === 'ECONNREFUSED') return { available: false, proxy: false, restricted: false }
    return { available: false, proxy: false, restricted: false, transient: true }
  }
}

// routerState: 'up' (our router answers), 'down' (nothing listens) or
// 'foreign' (something else holds the port).
export async function routerState(port = ROUTER_PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__zwrm/health`, { signal: AbortSignal.timeout(1500) })
    return (await r.text()).trim() === HEALTH_MARKER ? 'up' : 'foreign'
  } catch (err) {
    return err?.cause?.code === 'ECONNREFUSED' ? 'down' : 'foreign'
  }
}

// ensureRouter starts the router detached unless it already runs; the
// `network` tools call it too, so a router that died mid-session comes back.
export async function ensureRouter() {
  let state = await routerState()
  if (state === 'down') {
    const log = openSync('/tmp/zwrm-site-router.log', 'a')
    spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
    for (let i = 0; i < 50 && (state = await routerState()) === 'down'; i++) await new Promise((r) => setTimeout(r, 100))
  }
  return state
}

// routerStatus is the running router's view: the gateway's offer, the
// sites routed through the proxy, and recent policy blocks.
export async function routerStatus(port = ROUTER_PORT) {
  const r = await fetch(`http://127.0.0.1:${port}/__zwrm/status`, { signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`site router status: HTTP ${r.status}`)
  return r.json()
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
const mode = isMain ? process.argv[2] : 'imported'
if (mode === '--ensure') {
  const state = await ensureRouter()
  if (state === 'foreign') process.stderr.write(`zwrm-browser-mcp: another program holds 127.0.0.1:${ROUTER_PORT}; the browser's site router cannot start\n`)
  process.exit(state === 'up' ? 0 : 1)
}
if (mode === undefined) {
  // One bad connection must never take the router (and with it all of the
  // browser's network) down: log and keep serving.
  process.on('uncaughtException', (err) => process.stderr.write(`[site-router] uncaught: ${err?.stack || err}\n`))
  try {
    await runRouter()
  } catch (err) {
    // A second router racing the first loses the port: that's fine.
    if (err?.code === 'EADDRINUSE') process.exit(0)
    throw err
  }
}

export async function runRouter({
  port = ROUTER_PORT,
  gatewayBase = (() => { const a = readGatewayAddr(); return a ? `http://${a}:${GATEWAY_PORT}` : null })(),
  routesOpts,
  log = (m) => process.stderr.write(`[site-router] ${m}\n`),
} = {}) {
  const gwURL = gatewayBase ? new URL(gatewayBase) : null
  let routes = await loadRoutes(routesOpts)
  let rules = ruleMap(routes)
  let gateway = await gatewayStatus(gatewayBase)
  let gatewayMisses = 0
  const tunnels = new Set() // {host, via, sockets}
  const blocks = [] // recent policy refusals, newest first

  const noteBlock = (host, reason) => {
    const i = blocks.findIndex((b) => b.host === host)
    if (i >= 0) blocks.splice(i, 1)
    blocks.unshift({ host, reason, at: new Date().toISOString() })
    blocks.length = Math.min(blocks.length, MAX_BLOCKS)
  }

  // useGateway: whether connections go through the host gateway at all.
  const useGateway = () => gateway.available && (gateway.proxy || gateway.restricted)
  // routeOf: the route a host takes now. A site routed through the proxy
  // goes direct while no proxy is offered.
  const routeOf = (host) => {
    const via = routeFor(host, rules)
    return via === 'proxy' && !gateway.proxy ? 'direct' : via
  }

  // Reloads apply in the order they started, so a slow stale read can never
  // overwrite a newer one.
  let reloadChain = Promise.resolve()
  const reload = () => (reloadChain = reloadChain.then(applyRoutes, applyRoutes))
  const applyRoutes = async () => {
    routes = await loadRoutes({ ...routesOpts, log })
    rules = ruleMap(routes)
    const before = useGateway()
    const next = await gatewayStatus(gatewayBase)
    // One slow or failed poll must not flip routing (and close every
    // tunnel): keep the last known status until three in a row fail.
    if (next.transient && gateway.available && ++gatewayMisses < 3) {
      // keep the last known status
    } else {
      gatewayMisses = 0
      gateway = next
    }
    const gatewayChanged = before !== useGateway()
    for (const t of tunnels) {
      if (gatewayChanged || routeOf(t.host) !== t.via) {
        for (const s of t.sockets) s.destroy()
        tunnels.delete(t)
      }
    }
  }
  const timer = setInterval(() => { reload().catch(() => {}) }, RELOAD_EVERY_MS)
  timer.unref()

  // dialGateway opens a CONNECT tunnel to target through the host gateway,
  // on the given route. onRefused(status, blocked, reason) when the gateway
  // answers with anything but 200.
  const dialGateway = (target, via, onReady, onRefused, onFail) => {
    const sock = net.connect(Number(gwURL.port), gwURL.hostname)
    // Exactly one of onReady/onRefused/onFail runs, whatever the socket does.
    let settled = false
    const settle = (fn, ...args) => {
      if (settled) return
      settled = true
      sock.setTimeout(0)
      fn(...args)
    }
    const failed = (why) => settle(() => { sock.destroy(); onFail(why) })
    sock.once('connect', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nX-Zwrm-Route: ${via}\r\n\r\n`)
    })
    // A gateway that never answers, or closes before its headers, must not
    // leave the browser's CONNECT pending.
    sock.setTimeout(15000, () => failed('gateway timed out'))
    sock.once('error', (err) => failed(err.message))
    sock.once('close', () => failed('gateway closed the connection'))
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > 16384) failed('bad gateway response')
        return
      }
      sock.off('data', onData)
      const head = buf.subarray(0, end).toString()
      const nl = head.indexOf('\r\n')
      const status = nl >= 0 ? head.slice(0, nl) : head
      if (/^HTTP\/1\.[01] 200/.test(status)) {
        settle(() => {
          sock.removeAllListeners('error')
          sock.removeAllListeners('close')
          onReady(sock, buf.subarray(end + 4))
        })
        return
      }
      const blocked = /\r\nx-zwrm-egress:\s*blocked/i.test(head)
      // The refusal's reason is the body (Content-Length bounded: the
      // gateway keeps the connection open after it).
      const lenMatch = head.match(/\r\ncontent-length:\s*(\d+)/i)
      const want = lenMatch ? Math.min(Number(lenMatch[1]), 4096) : 4096
      let body = buf.subarray(end + 4)
      const refuse = () => settle(() => { sock.destroy(); onRefused(status, blocked, body.subarray(0, want).toString().trim()) })
      if (body.length >= want) { refuse(); return }
      sock.removeAllListeners('close')
      sock.removeAllListeners('error')
      sock.on('data', (d) => { body = Buffer.concat([body, d]); if (body.length >= want) refuse() })
      sock.once('end', refuse)
      sock.once('close', refuse)
      sock.once('error', refuse)
      setTimeout(refuse, 1000).unref()
    }
    sock.on('data', onData)
    return sock
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/__zwrm/health') {
      res.end(HEALTH_MARKER)
      return
    }
    if (req.url === '/__zwrm/status') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ gateway, sites: effectiveProxySites(routes), blocked: blocks }))
      return
    }
    if (req.url.startsWith('/__zwrm/reload')) {
      reload().then(() => res.end(JSON.stringify({ sites: effectiveProxySites(routes), gateway })), (err) => { res.writeHead(500); res.end(String(err)) })
      return
    }
    // Plain http:// requests arrive in absolute form.
    let target
    try { target = new URL(req.url) } catch { res.writeHead(400); res.end(); return }
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    let opts
    if (useGateway()) {
      // Absolute form to the gateway, which applies the policy per request.
      opts = { host: gwURL.hostname, port: Number(gwURL.port), path: req.url, method: req.method, headers: { ...headers, 'x-zwrm-route': routeOf(target.hostname) } }
    } else {
      opts = { host: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`, method: req.method, headers }
    }
    const up = http.request(opts, (r) => {
      if (r.headers['x-zwrm-egress'] === 'blocked') noteBlock(target.hostname, `blocked by the organization's network policy (HTTP ${r.statusCode})`)
      res.writeHead(r.statusCode, r.headers)
      r.pipe(res)
      // A response cut off mid-body must end the browser's request too.
      r.on('aborted', () => res.destroy())
      r.on('error', () => res.destroy())
    })
    up.on('error', () => { if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end() } })
    req.pipe(up)
  })

  server.on('connect', (req, client, head) => {
    const target = req.url
    const host = target.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
    const port = Number(target.match(/:(\d+)$/)?.[1] || 443)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const viaGateway = useGateway()
    const via = routeOf(host)
    const tunnel = { host, via, sockets: [client] }
    tunnels.add(tunnel)
    const done = () => { tunnels.delete(tunnel); for (const s of tunnel.sockets) s.destroy() }
    client.on('error', done)
    client.on('close', done)
    let open = false
    const established = (up, early) => {
      // The browser gave up while we dialed: nothing to tunnel to.
      if (client.destroyed) { up.destroy(); return }
      open = true
      // From here on, upstream errors close the tunnel; they must not write
      // a 502 into an established stream.
      up.removeAllListeners('error')
      tunnel.sockets.push(up)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (early?.length) client.write(early)
      if (head?.length) up.write(head)
      up.pipe(client)
      client.pipe(up)
      up.on('error', done)
      up.on('close', done)
    }
    // answer ends the browser's CONNECT with an error status, letting it
    // flush rather than destroying the socket under it.
    const answer = (msg) => {
      tunnels.delete(tunnel)
      for (const s of tunnel.sockets) if (s !== client) s.destroy()
      client.end(msg)
    }
    const fail = (why) => {
      if (open) return done()
      log(`${via} ${target}: ${why}`)
      answer('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    }
    const refused = (status, blocked, reason) => {
      if (open) return done()
      if (blocked) {
        noteBlock(host, reason || 'blocked by the organization\'s network policy')
        log(`blocked ${target}: ${reason}`)
        answer('HTTP/1.1 403 Forbidden\r\nX-Zwrm-Egress: blocked\r\n\r\n')
      } else {
        log(`${via} ${target}: gateway answered ${status}`)
        answer('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      }
    }
    try {
      if (viaGateway) {
        dialGateway(target, via, established, refused, fail)
      } else {
        const up = net.connect(port, host, () => established(up))
        up.once('error', (err) => fail(err.message))
      }
    } catch (err) {
      fail(err.message)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  log(`listening on 127.0.0.1:${port}; gateway ${gatewayBase || '(none)'} ${JSON.stringify(gateway)}; proxy sites: ${effectiveProxySites(routes).join(', ') || '(none)'}`)
  return {
    server,
    reload,
    close: () => { clearInterval(timer); for (const t of tunnels) for (const s of t.sockets) s.destroy(); server.close() },
    sites: () => effectiveProxySites(routes),
    status: () => ({ gateway, sites: effectiveProxySites(routes), blocked: blocks }),
  }
}
