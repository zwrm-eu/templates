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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULTS_FILE = '/etc/zwrm/browser/proxy-sites.json'
export const ROUTES_FILE = path.join(process.env.HOME || '/home/agent', '.zwrm/browser/routes.json')

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

// normalizeDomain accepts a domain or a URL and returns the bare host
// without a leading "www.", or throws.
export function normalizeDomain(input) {
  let host = String(input || '').trim().toLowerCase()
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname
    } catch {
      throw new Error(`not a domain or URL: ${input}`)
    }
  }
  host = host.replace(/^\*\./, '').replace(/\.$/, '').replace(/^www\./, '')
  if (!DOMAIN_RE.test(host)) throw new Error(`not a domain: ${input}`)
  return host
}

const uniq = (list) => [...new Set(list)].sort()

async function readJSON(file) {
  try {
    const v = JSON.parse(await readFile(file, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const domains = (list) => (Array.isArray(list) ? list : []).flatMap((d) => {
  try { return [normalizeDomain(d)] } catch { return [] }
})

export async function loadRoutes({ defaultsFile = DEFAULTS_FILE, routesFile = ROUTES_FILE } = {}) {
  const defaults = domains((await readJSON(defaultsFile)).proxy)
  const ws = await readJSON(routesFile)
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

// setRoute records the agent's choice for a domain in the workspace file.
export async function setRoute(domain, route, { defaultsFile = DEFAULTS_FILE, routesFile = ROUTES_FILE } = {}) {
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
  await mkdir(path.dirname(routesFile), { recursive: true })
  const tmp = `${routesFile}.tmp`
  await writeFile(tmp, JSON.stringify({ proxy: uniq(proxy), direct: uniq(direct) }, null, 2) + '\n')
  await rename(tmp, routesFile)
  return { domain: d, route, sites: effectiveProxySites(await loadRoutes({ defaultsFile, routesFile })) }
}
