import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { effectiveProxySites, loadRoutes, normalizeDomain, routeFor, setRoute } from '../routes.mjs'

test('normalizeDomain accepts domains and URLs, strips www, rejects junk', () => {
  assert.equal(normalizeDomain('WWW.MeineStadt.de'), 'meinestadt.de')
  assert.equal(normalizeDomain('https://immobilien.meinestadt.de/foo?x=1'), 'immobilien.meinestadt.de')
  assert.equal(normalizeDomain('*.indeed.com'), 'indeed.com')
  for (const bad of ['', 'localhost', 'not a domain', 'http://', '127.0.0.1']) assert.throws(() => normalizeDomain(bad), undefined, bad)
})

test('routeFor matches the domain and its subdomains only', () => {
  const sites = new Map([['meinestadt.de', 'proxy']])
  assert.equal(routeFor('meinestadt.de', sites), 'proxy')
  assert.equal(routeFor('immobilien.meinestadt.de', sites), 'proxy')
  assert.equal(routeFor('notmeinestadt.de', sites), 'direct')
  assert.equal(routeFor('google.com', sites), 'direct')
})

test('setRoute remembers choices; direct overrides a default; files stay tidy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'routes-'))
  const opts = { defaultsFile: path.join(dir, 'defaults.json'), routesFile: path.join(dir, 'ws', 'routes.json') }
  await writeFile(opts.defaultsFile, JSON.stringify({ proxy: ['meinestadt.de', 'indeed.com'] }))
  assert.deepEqual(effectiveProxySites(await loadRoutes(opts)), ['indeed.com', 'meinestadt.de'])

  let r = await setRoute('https://www.net-a-porter.com/en-de/', 'proxy', opts)
  assert.deepEqual(r.sites, ['indeed.com', 'meinestadt.de', 'net-a-porter.com'])
  r = await setRoute('indeed.com', 'direct', opts)
  assert.deepEqual(r.sites, ['meinestadt.de', 'net-a-porter.com'], 'a default can be switched off')
  r = await setRoute('net-a-porter.com', 'direct', opts)
  assert.deepEqual(r.sites, ['meinestadt.de'])
  r = await setRoute('indeed.com', 'proxy', opts)
  assert.deepEqual(r.sites, ['indeed.com', 'meinestadt.de'], 'switching a default back on removes the override')
  assert.deepEqual(JSON.parse(await readFile(opts.routesFile, 'utf8')), { proxy: [], direct: [] })
  await assert.rejects(setRoute('nope', 'proxy', opts), /not a domain/)
})

test('most specific rule wins; a choice covers its subdomains (review of the ipify run)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'routes-'))
  const opts = { defaultsFile: path.join(dir, 'defaults.json'), routesFile: path.join(dir, 'routes.json') }
  await writeFile(opts.defaultsFile, JSON.stringify({ proxy: ['meinestadt.de', 'api.example.org'] }))
  const { ruleMap, routeFor } = await import('../routes.mjs')
  const route = async (host) => routeFor(host, ruleMap(await loadRoutes(opts)))

  await setRoute('https://api.ipify.org/', 'proxy', opts)
  assert.equal(await route('api.ipify.org'), 'proxy')
  await setRoute('ipify.org', 'direct', opts)
  assert.equal(await route('api.ipify.org'), 'direct', 'direct on the parent clears the subdomain rule')

  await setRoute('immobilien.meinestadt.de', 'direct', opts)
  assert.equal(await route('immobilien.meinestadt.de'), 'direct', 'a specific direct rule beats a proxied parent')
  assert.equal(await route('www.meinestadt.de'), 'proxy')

  await setRoute('example.org', 'direct', opts)
  assert.equal(await route('api.example.org'), 'direct', 'a direct choice overrides a default for a subdomain too')
  await setRoute('example.org', 'proxy', opts)
  assert.equal(await route('api.example.org'), 'proxy')
  assert.equal(await route('example.org'), 'proxy')
})
