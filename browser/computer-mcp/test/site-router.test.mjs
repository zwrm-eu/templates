import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseUpstream, runRouter } from '../site-router.mjs'
import { setRoute } from '../routes.mjs'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

test('parseUpstream validates and builds the auth header', () => {
  const u = parseUpstream('http://alice:s3cr%25t@10.0.0.1:8080')
  assert.equal(u.auth, 'Basic ' + Buffer.from('alice:s3cr%t').toString('base64'))
  assert.deepEqual([u.host, u.port, u.tls], ['10.0.0.1', 8080, false])
  for (const bad of ['', 'not a url', 'socks5://h:1', 'http://hostonly']) assert.throws(() => parseUpstream(bad), undefined, bad)
})

// connectVia opens a CONNECT tunnel through the router to target and reads the
// target's greeting, which names who answered.
function connectVia(routerPort, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(routerPort, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    let buf = ''
    s.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\r\n\r\n')
      if (i >= 0 && buf.length > i + 4) { resolve({ status: buf.slice(0, buf.indexOf('\r\n')), body: buf.slice(i + 4), sock: s }) }
      else if (i >= 0 && !buf.startsWith('HTTP/1.1 200')) { resolve({ status: buf.slice(0, buf.indexOf('\r\n')), body: '', sock: s }) }
    })
    s.on('error', reject)
  })
}

test('router: chosen sites go through the authenticated proxy, others direct; switching drops old tunnels', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'router-'))
  const routesOpts = { defaultsFile: path.join(dir, 'defaults.json'), routesFile: path.join(dir, 'routes.json') }
  await writeFile(routesOpts.defaultsFile, JSON.stringify({ proxy: ['proxied.test'] }))

  // A "site": greets with "direct" unless reached through the fake proxy.
  const site = net.createServer((s) => { s.on('error', () => {}); s.write('hello-from-site') })
  const sitePort = await listen(site)
  // The fake upstream proxy: requires auth, tunnels to the site, tags it.
  const seen = []
  const want = 'Basic ' + Buffer.from('u:p').toString('base64')
  const upstream = http.createServer()
  upstream.on('connect', (req, sock) => {
    seen.push(`${req.url} ${req.headers['proxy-authorization'] === want ? 'auth-ok' : 'auth-bad'}`)
    if (req.headers['proxy-authorization'] !== want) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return }
    const up = net.connect(sitePort, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up) })
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
  })
  const upstreamPort = await listen(upstream)

  // Hosts resolve to 127.0.0.1 via the target "localhost-ish" names below.
  const router = await runRouter({ port: 0 || 18990, upstreamValue: `http://u:p@127.0.0.1:${upstreamPort}`, routesOpts, log: () => {} })
  try {
    // proxied.test → through the proxy (the proxy connects on to the site).
    const a = await connectVia(18990, `proxied.test:${sitePort}`)
    assert.match(a.status, /200/)
    assert.equal(a.body, 'hello-from-site')
    assert.deepEqual(seen, [`proxied.test:${sitePort} auth-ok`])
    // 127.0.0.1 (not listed) → direct, the proxy never sees it.
    const b = await connectVia(18990, `127.0.0.1:${sitePort}`)
    assert.equal(b.body, 'hello-from-site')
    assert.equal(seen.length, 1, 'direct traffic must not touch the proxy')

    // Switching proxied.test to direct closes its open tunnel on reload.
    const closed = new Promise((r) => a.sock.once('close', r))
    await setRoute('proxied.test', 'direct', routesOpts)
    await router.reload()
    await closed
    assert.deepEqual(router.sites(), [])
    b.sock.destroy()
  } finally {
    router.close(); site.close(); upstream.close()
  }
})
