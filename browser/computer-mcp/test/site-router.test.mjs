import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultGateway, runRouter } from '../site-router.mjs'
import { setRoute } from '../routes.mjs'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

test('defaultGateway reads the default route from /proc/net/route', () => {
  const text = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'eth0\t00000000\t011010AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
    'eth0\t001010AC\t00000000\t0001\t0\t0\t0\tFCFFFFFF\t0\t0\t0\n'
  assert.equal(defaultGateway(text), '172.16.16.1')
  assert.equal(defaultGateway('Iface\tDestination\tGateway\n'), null)
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

// fakeGateway stands in for the host's egress gateway: it reports its offer
// at /__zwrm/egress, records each CONNECT's route, refuses blocked.test with
// the policy header, and tunnels everything else to the site.
async function fakeGateway(sitePort, offer) {
  const seen = []
  const gw = http.createServer((req, res) => {
    if (req.url === '/__zwrm/egress') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(offer)); return }
    res.writeHead(404); res.end()
  })
  gw.on('connect', (req, sock) => {
    seen.push(`${req.url} ${req.headers['x-zwrm-route']}`)
    if (req.url.startsWith('blocked.test')) {
      sock.end('HTTP/1.1 403 Forbidden\r\nX-Zwrm-Egress: blocked\r\nContent-Type: text/plain\r\n\r\nBlocked by your organization\'s network policy: blocked.test is on the blocked list.')
      return
    }
    const up = net.connect(sitePort, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up) })
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
  })
  const port = await listen(gw)
  return { gw, port, seen }
}

test('router: through the gateway each site carries its route; switching drops old tunnels; blocks are kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'router-'))
  const routesOpts = { defaultsFile: path.join(dir, 'defaults.json'), routesFile: path.join(dir, 'routes.json') }
  await writeFile(routesOpts.defaultsFile, JSON.stringify({ proxy: ['proxied.test'] }))
  const site = net.createServer((s) => { s.on('error', () => {}); s.write('hello-from-site') })
  const sitePort = await listen(site)
  const { gw, port: gwPort, seen } = await fakeGateway(sitePort, { proxy: true, restricted: true })

  const router = await runRouter({ port: 18990, gatewayBase: `http://127.0.0.1:${gwPort}`, routesOpts, log: () => {} })
  try {
    const a = await connectVia(18990, `proxied.test:${sitePort}`)
    assert.match(a.status, /200/)
    assert.equal(a.body, 'hello-from-site')
    const b = await connectVia(18990, `other.test:${sitePort}`)
    assert.equal(b.body, 'hello-from-site')
    assert.deepEqual(seen, [`proxied.test:${sitePort} proxy`, `other.test:${sitePort} direct`])

    // A policy refusal reaches the browser as a 403 and is remembered.
    const c = await connectVia(18990, 'blocked.test:443')
    assert.match(c.status, /403/)
    c.sock.destroy()
    const st = router.status()
    assert.equal(st.blocked[0].host, 'blocked.test')
    assert.match(st.blocked[0].reason, /blocked list/)

    // Switching proxied.test to direct closes its open tunnel on reload.
    const closed = new Promise((r) => a.sock.once('close', r))
    await setRoute('proxied.test', 'direct', routesOpts)
    await router.reload()
    await closed
    assert.deepEqual(router.sites(), [])
    b.sock.destroy()
  } finally {
    router.close(); site.close(); gw.close()
  }
})

test('router: with neither proxy nor policy it connects directly; a proxy route goes direct without a proxy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'router-'))
  const routesOpts = { defaultsFile: path.join(dir, 'defaults.json'), routesFile: path.join(dir, 'routes.json') }
  await writeFile(routesOpts.defaultsFile, JSON.stringify({ proxy: ['127.0.0.1'] }))
  const site = net.createServer((s) => { s.on('error', () => {}); s.write('hello-from-site') })
  const sitePort = await listen(site)
  const { gw, port: gwPort, seen } = await fakeGateway(sitePort, { proxy: false, restricted: false })
  const router = await runRouter({ port: 18992, gatewayBase: `http://127.0.0.1:${gwPort}`, routesOpts, log: () => {} })
  try {
    const a = await connectVia(18992, `127.0.0.1:${sitePort}`)
    assert.equal(a.body, 'hello-from-site')
    assert.deepEqual(seen, [], 'nothing to enforce or carry: the gateway is not involved')
    a.sock.destroy()
  } finally {
    router.close(); site.close(); gw.close()
  }
  // No gateway at all (an older host): direct.
  const site2 = net.createServer((s) => { s.on('error', () => {}); s.write('hi') })
  const port2 = await listen(site2)
  const router2 = await runRouter({ port: 18993, gatewayBase: 'http://127.0.0.1:1', routesOpts, log: () => {} })
  try {
    const b = await connectVia(18993, `127.0.0.1:${port2}`)
    assert.equal(b.body, 'hi')
    b.sock.destroy()
  } finally {
    router2.close(); site2.close()
  }
})

test('review: a bad CONNECT port is a 400, not a crash; health answers; a mid-stream reset adds no 502', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'router-'))
  const routesOpts = { defaultsFile: path.join(dir, 'd.json'), routesFile: path.join(dir, 'r.json') }
  // A site that sends a little "TLS" and then resets the connection.
  const site = net.createServer((s) => { s.on('error', () => {}); s.write('TLSDATA'); setTimeout(() => s.resetAndDestroy(), 100) })
  const sitePort = await listen(site)
  const router = await runRouter({ port: 18991, gatewayBase: 'http://127.0.0.1:1', routesOpts, log: () => {} })
  try {
    for (const bad of ['example.com:99999', '127.0.0.1:65536', 'example.com:0']) {
      const r = await connectVia(18991, bad)
      assert.match(r.status, /400/, bad)
      r.sock.destroy()
    }
    const health = await fetch('http://127.0.0.1:18991/__zwrm/health').then((x) => x.text())
    assert.equal(health, 'zwrm-site-router', 'the router still answers after bad requests')

    const got = await new Promise((resolve) => {
      const s = net.connect(18991, '127.0.0.1', () => s.write(`CONNECT 127.0.0.1:${sitePort} HTTP/1.1\r\n\r\n`))
      let buf = ''
      s.on('data', (d) => { buf += d })
      s.on('close', () => resolve(buf))
      s.on('error', () => {})
    })
    assert.match(got, /^HTTP\/1\.1 200 Connection Established\r\n\r\nTLSDATA/)
    assert.doesNotMatch(got, /502/, 'an upstream reset after the 200 must not inject a 502 into the tunnel')
  } finally {
    router.close(); site.close()
  }
})

test('review: a gateway that closes before answering fails the CONNECT; a refusal is answered at once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'router-'))
  const routesOpts = { defaultsFile: path.join(dir, 'd.json'), routesFile: path.join(dir, 'r.json') }
  const gw = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ proxy: false, restricted: true })) })
  gw.on('connect', (req, sock) => {
    if (req.url.startsWith('vanish.test')) { sock.end(); return }
    // Like Go's http.Error: Content-Length, connection kept open.
    const body = 'Blocked by your organization\'s network policy: nope.'
    sock.write(`HTTP/1.1 403 Forbidden\r\nX-Zwrm-Egress: blocked\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  })
  const gwPort = await listen(gw)
  const router = await runRouter({ port: 18994, gatewayBase: `http://127.0.0.1:${gwPort}`, routesOpts, log: () => {} })
  try {
    const a = await connectVia(18994, 'vanish.test:443')
    assert.match(a.status, /502/)
    a.sock.destroy()
    const t0 = Date.now()
    const b = await connectVia(18994, 'nope.test:443')
    assert.match(b.status, /403/)
    assert.ok(Date.now() - t0 < 500, `refusal took ${Date.now() - t0} ms`)
    b.sock.destroy()
    assert.match(router.status().blocked[0].reason, /nope\.$/)
  } finally {
    router.close(); gw.close()
  }
})
