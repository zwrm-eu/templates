// Per-site browser routing: which domains the browser reaches through the
// agent's proxy (BROWSER_PROXY) instead of the VM's own address.
//
// Most sites work from the VM's address, and some (Google) break through a
// proxy, so the default is direct and only listed domains use the proxy. The
// image ships defaults for sites known to block datacenter addresses; the agent
// adds or overrides domains with the `network` tools, and those choices are
// kept on the workspace volume, so they survive sessions and reboots.
//
//   defaults:  /etc/zwrm/browser/proxy-sites.json   { "proxy": ["meinestadt.de"] }
//   workspace: ~/.zwrm/browser/routes.json           { "proxy": [...], "direct": [...] }
//
// A domain covers itself and its subdomains, and the most specific rule wins:
// "meinestadt.de" through the proxy with "immobilien.meinestadt.de" direct
// sends only that subdomain direct. Workspace choices override the defaults.

import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

export const DEFAULTS_FILE = '/etc/zwrm/browser/proxy-sites.json'
export const ROUTES_FILE = path.join(process.env.HOME || '/home/agent', '.zwrm/browser/routes.json')

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

// normalizeDomain accepts a domain or a URL and returns the bare host
// without a leading "www.", or throws.
export function normalizeDomain(input) {
  let host = String(input || '').trim().toLowerCase().replace(/^\*\./, '')
  // Parse as a URL either way: it strips scheme, path and port, and turns an
  // internationalized name (münchen.de) into its punycode form.
  try {
    host = new URL(host.includes('://') ? host : `http://${host}`).hostname
  } catch {
    throw new Error(`not a domain or URL: ${input}`)
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '')
  if (!DOMAIN_RE.test(host)) throw new Error(`not a domain: ${input}`)
  return host
}

const uniq = (list) => [...new Set(list)].sort()

async function readJSON(file, log = () => {}) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return {} // no file yet
  }
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : {}
  } catch {
    log(`ignoring ${file}: not valid JSON`)
    return {}
  }
}

const domains = (list) => (Array.isArray(list) ? list : []).flatMap((d) => {
  try { return [normalizeDomain(d)] } catch { return [] }
})

export async function loadRoutes({ defaultsFile = DEFAULTS_FILE, routesFile = ROUTES_FILE, log } = {}) {
  const defaults = domains((await readJSON(defaultsFile, log)).proxy)
  const ws = await readJSON(routesFile, log)
  const proxy = domains(ws.proxy)
  const direct = domains(ws.direct)
  return { defaults: uniq(defaults), proxy: uniq(proxy), direct: uniq(direct) }
}

// ruleMap: domain → 'proxy' | 'direct'. Defaults are proxy rules; the
// workspace's own choices override them.
export function ruleMap(routes) {
  const rules = new Map()
  for (const d of routes.defaults) rules.set(d, 'proxy')
  for (const d of routes.proxy) rules.set(d, 'proxy')
  for (const d of routes.direct) rules.set(d, 'direct')
  return rules
}

// effectiveProxySites lists the domains with a proxy rule (for status).
export function effectiveProxySites(routes) {
  return uniq([...ruleMap(routes)].filter(([, r]) => r === 'proxy').map(([d]) => d))
}

export function matches(host, domain) {
  host = String(host).toLowerCase().replace(/\.$/, '')
  return host === domain || host.endsWith(`.${domain}`)
}

// routeFor applies the most specific matching rule; no rule means direct.
export function routeFor(host, rules) {
  let best = null
  for (const [d, r] of rules) {
    if (matches(host, d) && (!best || d.length > best[0].length)) best = [d, r]
  }
  return best ? best[1] : 'direct'
}

// Writes are serialized: in this process by a promise chain, across
// processes (two sessions' `network` servers) by a lock directory, so
// concurrent changes never lose one another.
let writeChain = Promise.resolve()

async function withLock(routesFile, fn) {
  const lock = `${routesFile}.lock`
  await mkdir(path.dirname(routesFile), { recursive: true })
  for (let i = 0; ; i++) {
    try {
      await mkdir(lock)
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      if (i > 50) { await rmdir(lock).catch(() => {}); continue } // stale (holder died): ~5 s
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    return await fn()
  } finally {
    await rmdir(lock).catch(() => {})
  }
}

// setRoute records the agent's choice for a domain in the workspace file.
export function setRoute(domain, route, opts = {}) {
  const p = writeChain.then(() => withLock(opts.routesFile || ROUTES_FILE, () => setRouteNow(domain, route, opts)))
  writeChain = p.catch(() => {})
  return p
}

async function setRouteNow(domain, route, { defaultsFile = DEFAULTS_FILE, routesFile = ROUTES_FILE } = {}) {
  const d = normalizeDomain(domain)
  if (route !== 'proxy' && route !== 'direct') throw new Error(`unknown route ${route}`)
  const routes = await loadRoutes({ defaultsFile, routesFile })
  // The choice covers the domain and everything under it: drop the stored
  // rules for its subdomains, which would otherwise outrank it.
  const under = (x) => x === d || x.endsWith(`.${d}`)
  const proxy = routes.proxy.filter((x) => !under(x))
  const direct = routes.direct.filter((x) => !under(x))
  // Defaults (always proxy rules) for subdomains would outrank the choice too:
  // a direct choice overrides them explicitly.
  if (route === 'direct') {
    for (const x of routes.defaults) if (x !== d && under(x)) direct.push(x)
  }
  // Record the domain's own rule only where it changes the outcome: compare
  // with what its default, or the remaining rules above it, would decide.
  const others = ruleMap({ defaults: routes.defaults.filter((x) => x !== d), proxy, direct })
  const otherwise = routes.defaults.includes(d) ? 'proxy' : routeFor(d, others)
  if (otherwise !== route) (route === 'proxy' ? proxy : direct).push(d)
  const tmp = `${routesFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify({ proxy: uniq(proxy), direct: uniq(direct) }, null, 2) + '\n')
  await rename(tmp, routesFile)
  return { domain: d, route, sites: effectiveProxySites(await loadRoutes({ defaultsFile, routesFile })) }
}
