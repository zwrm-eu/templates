// Display supervisor: the Xvfb desktop computer use draws on.
//
// The desktop starts on the FIRST tool call, not at boot, so agents that never
// use computer use pay nothing. Xvfb and the window manager run DETACHED from
// the MCP server: the server lives as long as one agent session, but apps the
// agent opened on the desktop should outlive it (the next session finds the
// same windows). A later server reuses a running desktop.
//
// A hard-killed Xvfb (OOM, kill -9) leaves its lock file and socket behind,
// and Xvfb refuses to start while its lock names a live pid, which by then can
// belong to anything. A lock whose pid is not a running Xvfb is stale and is
// cleared before starting. (Init wipes /tmp on every boot, so a reboot alone
// never leaves one.) Suspend/restore needs none of this: the whole guest,
// desktop included, resumes as it was.
//
// A VNC server (x11vnc) runs with the desktop, bound to loopback with no
// password: zwrm-agentd relays it to the control plane over its token-gated
// port for the dashboard's live view (zwrm-eu/zwrm#1680), so nothing else can
// reach it.
//
// The desktop processes get a minimal environment, not the spawning
// session's: they outlive that session, and its env carries session
// credentials.

import { execFile, spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'

const START_TIMEOUT_MS = 10_000
export const VNC_PORT = 5900

export function run(cmd, args, { env, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr || err?.message || '') })
    })
  })
}

export class Display {
  constructor({ num = 99, width = 1280, height = 800, log = () => {} } = {}) {
    this.num = num
    this.width = width
    this.height = height
    this.log = log
    this.name = `:${num}`
    this.env = { ...process.env, DISPLAY: this.name }
    const home = process.env.HOME || '/home/agent'
    this.desktopEnv = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      USER: process.env.USER || 'agent',
      LANG: process.env.LANG || 'C.UTF-8',
      DISPLAY: this.name,
    }
    this.desktopCwd = home
    this.starting = null
  }

  async alive() {
    return (await run('xdotool', ['getdisplaygeometry'], { env: this.env, timeout: 5_000 })).ok
  }

  // ensure starts the desktop if it is not running. Single-flight: parallel
  // tool calls share one start.
  async ensure() {
    if (!this.starting) {
      this.starting = this.#ensure().finally(() => { this.starting = null })
    }
    return this.starting
  }

  async #ensure() {
    if (await this.alive()) {
      await this.#ensureWindowManager()
      await this.#ensureVNC()
      return
    }
    await this.#clearStaleLock()
    this.log(`starting Xvfb ${this.name} ${this.width}x${this.height}`)
    this.#detach('Xvfb', [this.name, '-screen', '0', `${this.width}x${this.height}x24`, '-nolisten', 'tcp'])
    const deadline = Date.now() + START_TIMEOUT_MS
    while (!(await this.alive())) {
      if (Date.now() > deadline) throw new Error(`Xvfb ${this.name} did not start within ${START_TIMEOUT_MS / 1000}s`)
      await new Promise((r) => setTimeout(r, 200))
    }
    await this.#ensureWindowManager()
    await this.#ensureVNC()
  }

  // The live view's VNC server. -shared: several members may watch at once;
  // -forever: survive a viewer disconnecting; -localhost: loopback only.
  async #ensureVNC() {
    if ((await run('pgrep', ['-x', 'x11vnc'], { timeout: 5_000 })).ok) return
    this.log(`starting x11vnc on 127.0.0.1:${VNC_PORT}`)
    this.#detach('x11vnc', ['-display', this.name, '-rfbport', String(VNC_PORT), '-localhost', '-nopw',
      '-forever', '-shared', '-noxdamage', '-quiet'])
  }

  // A window manager gives new windows focus and stacking; without one,
  // dialogs open behind their parent and keyboard input goes nowhere.
  async #ensureWindowManager() {
    if ((await run('pgrep', ['-x', 'openbox'], { timeout: 5_000 })).ok) return
    this.log('starting openbox')
    this.#detach('openbox', [])
  }

  #detach(cmd, args) {
    const child = spawn(cmd, args, { env: this.desktopEnv, cwd: this.desktopCwd, detached: true, stdio: 'ignore' })
    child.on('error', (err) => this.log(`${cmd} failed to start: ${err.message}`))
    child.unref()
  }

  async #clearStaleLock() {
    const lock = `/tmp/.X${this.num}-lock`
    let pid
    try {
      pid = parseInt((await readFile(lock, 'utf8')).trim(), 10)
    } catch {
      return // no lock
    }
    let comm = ''
    try {
      comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim()
    } catch {}
    if (comm === 'Xvfb') return // a live server: alive() will see it shortly
    this.log(`clearing stale ${lock} (pid ${pid} is ${comm || 'not running'})`)
    await rm(lock, { force: true })
    await rm(`/tmp/.X11-unix/X${this.num}`, { force: true })
  }
}
