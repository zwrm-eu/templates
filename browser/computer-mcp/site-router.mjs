#!/usr/bin/env node
// Per-site router for the agent's browser. Chromium always uses this local
// proxy (127.0.0.1:ROUTER_PORT); for each connection it decides, by host,
// whether to go direct (the VM's own address) or through the agent's proxy
// (BROWSER_PROXY), using the routes in routes.mjs. It also carries the
// proxy's credentials, which Chromium's proxy setting cannot.
//
//   site-router.mjs --check    validate BROWSER_PROXY, exit non-zero with a message
//   site-router.mjs --ensure   start the router detached unless it already runs
//   site-router.mjs            run in the foreground
//
// Routes are re-read on POST /__zwrm/reload (the `network` tools call it after
// a change) and every few seconds. A reload closes open tunnels whose route
// changed, so the browser's next request reconnects the new way instead of
// reusing a pooled connection.

import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { effectiveProxySites, loadRoutes, routeFor, ruleMap } from './routes.mjs'

export const ROUTER_PORT = 18080
const RELOAD_EVERY_MS = 5000
// GET /__zwrm/health answers this, so --ensure can tell the router from any
// other program that happens to hold the port.
const HEALTH_MARKER = 'zwrm-site-router'

// parseUpstream validates BROWSER_PROXY: http(s)://[user:pass@]host:port.
export function parseUpstream(value) {
  let url
  try {
    url = new URL(value || '')
  } catch {
    throw new Error('BROWSER_PROXY is not a URL (want http://[user:pass@]host:port)')
  }
  const scheme = url.protocol.replace(/:$/, '')
  if (scheme !== 'http' && scheme !== 'https') throw new Error(`BROWSER_PROXY has unsupported scheme "${scheme}" (http or https)`)
  if (!url.hostname || !url.port) throw new Error('BROWSER_PROXY needs a host and a port')
  const user = decodeURIComponent(url.username)
  const pass = decodeURIComponent(url.password)
  return {
    tls: scheme === 'https',
    host: url.hostname,
    port: Number(url.port),
    auth: user || pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : null,
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
const mode = isMain ? process.argv[2] : 'imported'
if (mode === '--check') {
  try {
    parseUpstream(process.env.BROWSER_PROXY)
  } catch (err) {
    process.stderr.write(`zwrm-browser-mcp: ${err.message}\n`)
    process.exit(1)
  }
  process.exit(0)
}
if (mode === '--ensure') {
  const state = await ensureRouter()
  if (state === 'foreign') process.stderr.write(`zwrm-browser-mcp: another program holds 127.0.0.1:${ROUTER_PORT}; the browser's proxy router cannot start\n`)
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

export async function runRouter({ port = ROUTER_PORT, upstreamValue = process.env.BROWSER_PROXY, routesOpts, log = (m) => process.stderr.write(`[site-router] ${m}\n`) } = {}) {
  const upstream = parseUpstream(upstreamValue)
  let routes = await loadRoutes(routesOpts)
  let rules = ruleMap(routes)
  const tunnels = new Set() // {host, via, sockets}

  // Reloads apply in the order they started, so a slow stale read can never
  // overwrite a newer one.
  let reloadChain = Promise.resolve()
  const reload = () => (reloadChain = reloadChain.then(applyRoutes, applyRoutes))
  const applyRoutes = async () => {
    routes = await loadRoutes({ ...routesOpts, log })
    rules = ruleMap(routes)
    for (const t of tunnels) {
      if (routeFor(t.host, rules) !== t.via) {
        for (const s of t.sockets) s.destroy()
        tunnels.delete(t)
      }
    }
  }
  const timer = setInterval(() => { reload().catch(() => {}) }, RELOAD_EVERY_MS)
  timer.unref()

  // dialUpstream opens a CONNECT tunnel to target through the agent's proxy.
  const dialUpstream = (target, onReady, onFail) => {
    const sock = upstream.tls
      ? tls.connect({ host: upstream.host, port: upstream.port, servername: upstream.host })
      : net.connect(upstream.port, upstream.host)
    sock.once(upstream.tls ? 'secureConnect' : 'connect', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${upstream.auth ? `Proxy-Authorization: ${upstream.auth}\r\n` : ''}\r\n`)
    })
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > 16384) { sock.destroy(); onFail('bad proxy response') }
        return
      }
      sock.off('data', onData)
      const status = buf.subarray(0, buf.indexOf('\r\n')).toString()
      if (!/^HTTP\/1\.[01] 200/.test(status)) { sock.destroy(); onFail(status); return }
      onReady(sock, buf.subarray(end + 4))
    }
    sock.on('data', onData)
    sock.once('error', (err) => onFail(err.message))
    return sock
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/__zwrm/health') {
      res.end(HEALTH_MARKER)
      return
    }
    if (req.url.startsWith('/__zwrm/reload')) {
      reload().then(() => res.end(JSON.stringify({ sites: effectiveProxySites(routes) })), (err) => { res.writeHead(500); res.end(String(err)) })
      return
    }
    // Plain http:// requests arrive in absolute form.
    let target
    try { target = new URL(req.url) } catch { res.writeHead(400); res.end(); return }
    const via = routeFor(target.hostname, rules)
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    const opts = via === 'proxy'
      ? { host: upstream.host, port: upstream.port, path: req.url, method: req.method, headers: upstream.auth ? { ...headers, 'proxy-authorization': upstream.auth } : headers }
      : { host: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`, method: req.method, headers }
    const client = via === 'proxy' && upstream.tls ? https : http
    const up = client.request(opts, (r) => {
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
    const host = target.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    const port = Number(target.match(/:(\d+)$/)?.[1] || 443)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const via = routeFor(host, rules)
    const tunnel = { host, via, sockets: [client] }
    tunnels.add(tunnel)
    const done = () => { tunnels.delete(tunnel); for (const s of tunnel.sockets) s.destroy() }
    client.on('error', done)
    client.on('close', done)
    let open = false
    const established = (up, early) => {
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
    const fail = (why) => {
      if (open) return done()
      log(`${via} ${target}: ${why}`)
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      done()
    }
    try {
      if (via === 'proxy') {
        dialUpstream(target, established, fail)
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
  log(`listening on 127.0.0.1:${port}; proxy sites: ${effectiveProxySites(routes).join(', ') || '(none)'}`)
  return { server, reload, close: () => { clearInterval(timer); for (const t of tunnels) for (const s of t.sockets) s.destroy(); server.close() }, sites: () => effectiveProxySites(routes) }
}
