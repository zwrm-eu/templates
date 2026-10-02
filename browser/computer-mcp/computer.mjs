// Computer actions: a port of Anthropic's reference computer-use tool
// (anthropics/claude-quickstarts, computer-use-demo/computer_use_demo/tools/
// computer.py, MIT License, Copyright (c) 2023 Anthropic), following its
// newest shape, computer_toolset_20260801: every action is its own tool, a
// pointer action's held modifier chord is spelled `text`, `key` takes an
// optional `repeat`, and `zoom` is always available.
//
// Differences from the reference, all deliberate:
//  - xdotool/scrot/convert run with argv arrays, never through a shell, so
//    model-supplied text cannot reach a shell;
//  - screenshots are written to a temp file and deleted once encoded;
//  - every call first makes sure the desktop is running (Display.ensure);
//  - a move to where the pointer already is, is skipped (see moveTo): the
//    reference's `mousemove --sync` stalls there.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run as defaultRun } from './display.mjs'

export const TYPING_DELAY_MS = 12
export const TYPING_GROUP_SIZE = 50
export const KEY_REPEAT_MAX = 100
// wait / hold_key sleep inside one MCP request, and the MCP SDK times a request
// out at 60 s by default (the pi/codex bridge sets no longer timeout). The
// reference allows 100 s; anything over ~58 s would come back as a timeout
// while the server kept sleeping, delaying the next call.
export const MAX_DURATION_S = 50

// A held modifier chord or held key: xdotool keysyms joined by '+'
// ('shift', 'ctrl+shift', 'Shift_L'). Validated because it lands in an
// xdotool command chain as a bare word, where 'exec' or '--help' would be
// parsed as a command or option instead of a key.
const KEYSYM_CHORD = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/

// Sizes above XGA/WXGA are not recommended: screenshots are scaled down to the
// target with the display's aspect ratio (reference MAX_SCALING_TARGETS).
export const MAX_SCALING_TARGETS = [
  { width: 1024, height: 768 }, // 4:3
  { width: 1280, height: 800 }, // 16:10
  { width: 1366, height: 768 }, // ~16:9
]

const CLICK_ARGS = {
  left_click: ['1'],
  right_click: ['3'],
  middle_click: ['2'],
  double_click: ['--repeat', '2', '--delay', '10', '1'],
  triple_click: ['--repeat', '3', '--delay', '10', '1'],
}
export const CLICK_ACTIONS = Object.keys(CLICK_ARGS)

const SCROLL_BUTTON = { up: '4', down: '5', left: '6', right: '7' }

export class ToolError extends Error {}

// Take-over (zwrm-eu/zwrm#1680): while a member watching the live view holds
// input, zwrm-agentd's control file reads "user <expiry-ms>" and the agent may
// only observe. The lease lapses on its own if the member's browser goes away,
// so a stale file never locks the agent out. Same rule as agentd's
// parseControl.
export const CONTROL_FILE = '/tmp/.zwrm-desktop-control'
const OBSERVE_ACTIONS = new Set(['screenshot', 'zoom', 'cursor_position', 'wait'])

export function parseControl(text, now = Date.now()) {
  const [holder, expiry] = String(text || '').trim().split(/\s+/)
  return holder === 'user' && Number(expiry) > now ? 'user' : 'agent'
}

export const USER_HAS_CONTROL =
  'A person has taken control of this desktop and is using it right now. Do not send input. ' +
  'You can still observe: call wait (e.g. 30 seconds) and take a screenshot to see what they did, ' +
  'then continue once they hand control back.'

export class Computer {
  constructor({ display, run = defaultRun, screenshotDelayMs = 2000, sleep, controlFile = CONTROL_FILE } = {}) {
    this.display = display
    this.controlFile = controlFile
    this.run = run
    this.screenshotDelayMs = screenshotDelayMs
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
    // One action at a time: interleaved xdotool chains (a drag racing a
    // click) would produce input no model asked for.
    this.queue = Promise.resolve()
  }

  async controlHolder() {
    try {
      return parseControl(await readFile(this.controlFile, 'utf8'))
    } catch {
      return 'agent'
    }
  }

  get width() { return this.display.width }
  get height() { return this.display.height }

  // The coordinate frame the model works in (screenshot pixels).
  screenshotSize() {
    return this.scale('computer', this.width, this.height)
  }

  // scale maps between screenshot pixels ('api') and display pixels
  // ('computer'); identity when the display already is a scaling target.
  scale(source, x, y) {
    const ratio = this.width / this.height
    let target = null
    for (const dim of MAX_SCALING_TARGETS) {
      // allow some error in the aspect ratio - not all ratios are exactly 16:9
      if (Math.abs(dim.width / dim.height - ratio) < 0.02) {
        if (dim.width < this.width) target = dim
        break
      }
    }
    // Pixels run 0..width-1: the pointer clamps at width-1, so accepting
    // `width` would make moveTo see a position it can never reach (and
    // `mousemove --sync` would stall there).
    if (!target) {
      if (source === 'api' && (x >= this.width || y >= this.height)) {
        throw new ToolError(`Coordinates ${x}, ${y} are out of bounds`)
      }
      return [x, y]
    }
    const fx = target.width / this.width
    const fy = target.height / this.height
    if (source === 'api') {
      const [w, h] = this.screenshotSize()
      if (x >= w || y >= h) throw new ToolError(`Coordinates ${x}, ${y} are out of bounds`)
      return [Math.min(Math.round(x / fx), this.width - 1), Math.min(Math.round(y / fy), this.height - 1)]
    }
    return [Math.round(x * fx), Math.round(y * fy)]
  }

  coords(coordinate, name = 'coordinate') {
    if (!Array.isArray(coordinate) || coordinate.length !== 2 ||
        !coordinate.every((n) => Number.isInteger(n) && n >= 0)) {
      throw new ToolError(`${name} must be [x, y] with non-negative integers`)
    }
    return this.scale('api', coordinate[0], coordinate[1]).map(String)
  }

  // call runs one action (a member tool name) serially. Returns
  // { output?, error?, image? } with image as base64 PNG.
  call(action, input = {}) {
    const p = this.queue.then(async () => {
      if (!OBSERVE_ACTIONS.has(action) && (await this.controlHolder()) === 'user') {
        throw new ToolError(USER_HAS_CONTROL)
      }
      await this.display.ensure()
      return this.#dispatch(action, input || {})
    })
    this.queue = p.catch(() => {})
    return p
  }

  async #dispatch(action, a) {
    switch (action) {
      case 'screenshot':
        return this.screenshot()
      case 'cursor_position': {
        const r = await this.xdotool(['getmouselocation', '--shell'])
        const x = parseInt(/X=(\d+)/.exec(r.stdout)?.[1], 10)
        const y = parseInt(/Y=(\d+)/.exec(r.stdout)?.[1], 10)
        if (!Number.isInteger(x) || !Number.isInteger(y)) throw new ToolError(`cursor_position failed: ${r.stderr}`)
        const [sx, sy] = this.scale('computer', x, y)
        return { output: `X=${sx},Y=${sy}` }
      }
      case 'mouse_move':
        return this.act(await this.moveTo(this.coords(a.coordinate)), action)
      case 'left_mouse_down':
      case 'left_mouse_up':
        this.buttonHeld = action === 'left_mouse_down'
        return this.act([action === 'left_mouse_down' ? 'mousedown' : 'mouseup', '1'], action)
      case 'left_click_drag': {
        const start = this.coords(a.start_coordinate, 'start_coordinate')
        const end = this.coords(a.coordinate)
        const drag = end[0] === start[0] && end[1] === start[1] ? [] : ['mousemove', '--sync', ...end]
        return this.act(this.withModifier(a.text,
          [...(await this.moveTo(start)), 'mousedown', '1', ...drag, 'mouseup', '1']), action)
      }
      case 'key': {
        const text = this.requireText(a.text, action)
        const repeat = a.repeat ?? 1
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > KEY_REPEAT_MAX) {
          throw new ToolError(`repeat must be an integer between 1 and ${KEY_REPEAT_MAX}`)
        }
        return this.act(['key', '--', ...Array(repeat).fill(text)], action)
      }
      case 'hold_key': {
        const text = this.chord(this.requireText(a.text, action), 'text')
        const duration = this.duration(a.duration)
        const down = await this.xdotool(['keydown', text])
        if (!down.ok) throw new ToolError(`hold_key failed: ${down.stderr.trim()}`)
        this.keyHeld = text
        try {
          await this.sleep(duration * 1000)
        } finally {
          await this.xdotool(['keyup', text])
          this.keyHeld = null
        }
        return this.act([], action)
      }
      case 'type': {
        const text = this.requireText(a.text, action)
        const errors = []
        for (let i = 0; i < text.length; i += TYPING_GROUP_SIZE) {
          const r = await this.xdotool(['type', '--delay', String(TYPING_DELAY_MS), '--', text.slice(i, i + TYPING_GROUP_SIZE)])
          if (!r.ok) errors.push(r.stderr)
        }
        return { ...(errors.length ? { error: errors.join('') } : {}), image: (await this.screenshot()).image }
      }
      case 'scroll': {
        const direction = a.scroll_direction
        if (!SCROLL_BUTTON[direction]) throw new ToolError(`scroll_direction must be 'up', 'down', 'left', or 'right'`)
        // xdotool rejects --repeat 0, so (unlike the reference) 0 is invalid.
        const amount = a.scroll_amount
        if (!Number.isInteger(amount) || amount < 1) throw new ToolError('scroll_amount must be a positive integer')
        const move = a.coordinate != null ? await this.moveTo(this.coords(a.coordinate)) : []
        return this.act([...move, ...this.withModifier(a.text, ['click', '--repeat', String(amount), SCROLL_BUTTON[direction]])], action)
      }
      case 'wait':
        await this.sleep(this.duration(a.duration) * 1000)
        return this.screenshot()
      case 'zoom':
        return this.zoom(a.region)
      default:
        if (CLICK_ARGS[action]) {
          const move = a.coordinate != null ? await this.moveTo(this.coords(a.coordinate)) : []
          return this.act([...move, ...this.withModifier(a.text, ['click', ...CLICK_ARGS[action]])], action)
        }
        throw new ToolError(`Invalid action: ${action}`)
    }
  }

  requireText(text, action) {
    if (typeof text !== 'string' || text === '') throw new ToolError(`text is required for ${action}`)
    return text
  }

  duration(d) {
    if (typeof d !== 'number' || !Number.isFinite(d)) throw new ToolError('duration must be a number')
    if (d < 0) throw new ToolError('duration must be non-negative')
    if (d > MAX_DURATION_S) throw new ToolError('duration is too long')
    return d
  }

  // moveTo returns the xdotool steps that put the pointer at display pixels
  // [x, y], or none when it is already there: `mousemove --sync` to the
  // pointer's current position waits for a motion event that never comes
  // (xdotool stalls ~17 s). Xvfb starts the pointer at the screen centre, so a
  // first click there would hit it every time.
  async moveTo([x, y]) {
    const r = await this.xdotool(['getmouselocation', '--shell'])
    if (r.ok && r.stdout.includes(`X=${x}\n`) && r.stdout.includes(`Y=${y}\n`)) return []
    return ['mousemove', '--sync', x, y]
  }

  chord(text, name) {
    if (!KEYSYM_CHORD.test(text)) {
      throw new ToolError(`${name} must be xdotool keysyms joined by '+', e.g. 'shift' or 'ctrl+shift'`)
    }
    return text
  }

  // withModifier wraps xdotool steps in keydown/keyup of a held chord.
  withModifier(text, steps) {
    if (!text) return steps
    const chord = this.chord(text, 'text')
    return ['keydown', chord, ...steps, 'keyup', chord]
  }

  // release lets go of anything this server left pressed. The desktop
  // outlives the server (and the session), so a key or button still down
  // when it exits would stay down for the next session. Best effort: called
  // on shutdown, nothing to do after a SIGKILL.
  async release() {
    if (this.keyHeld) await this.xdotool(['keyup', this.keyHeld])
    if (this.buttonHeld) await this.xdotool(['mouseup', '1'])
    this.keyHeld = null
    this.buttonHeld = false
  }

  xdotool(args) {
    return this.run('xdotool', args, { env: this.display.env })
  }

  // act runs one xdotool chain, lets the UI settle, and returns a screenshot.
  async act(args, action) {
    if (args.length) {
      const r = await this.xdotool(args)
      if (!r.ok) throw new ToolError(`${action} failed: ${r.stderr.trim()}`)
    }
    await this.sleep(this.screenshotDelayMs)
    return { image: (await this.screenshot()).image }
  }

  async #capture(dir, name) {
    const file = path.join(dir, name)
    const r = await this.run('scrot', ['--overwrite', '--pointer', file], { env: this.display.env })
    if (!r.ok) throw new ToolError(`screenshot failed: ${r.stderr.trim()}`)
    return file
  }

  async screenshot() {
    return this.#withTemp(async (dir) => {
      const file = await this.#capture(dir, 'screen.png')
      const [w, h] = this.screenshotSize()
      if (w !== this.width || h !== this.height) {
        const r = await this.run('convert', [file, '-resize', `${w}x${h}!`, file])
        if (!r.ok) throw new ToolError(`screenshot resize failed: ${r.stderr.trim()}`)
      }
      return { image: (await readFile(file)).toString('base64') }
    })
  }

  // zoom returns a magnified capture of region [x0, y0, x1, y1] (screenshot
  // pixels), cropped from a full-resolution capture and fitted, aspect kept,
  // within the screenshot frame. Coordinates stay in screenshot pixels after.
  async zoom(region) {
    if (!Array.isArray(region) || region.length !== 4 || !region.every((n) => Number.isInteger(n) && n >= 0)) {
      throw new ToolError('region must be [x0, y0, x1, y1] with non-negative integers')
    }
    if (region[2] <= region[0] || region[3] <= region[1]) throw new ToolError('region must satisfy x0 < x1 and y0 < y1')
    const [x0, y0] = this.scale('api', region[0], region[1])
    const [x1, y1] = this.scale('api', region[2], region[3])
    const [fw, fh] = this.screenshotSize()
    return this.#withTemp(async (dir) => {
      const raw = await this.#capture(dir, 'raw.png')
      const out = path.join(dir, 'zoom.png')
      const r = await this.run('convert', [raw, '-crop', `${x1 - x0}x${y1 - y0}+${x0}+${y0}`, '+repage', '-resize', `${fw}x${fh}`, out])
      if (!r.ok) throw new ToolError(`zoom failed: ${r.stderr.trim()}`)
      return { image: (await readFile(out)).toString('base64') }
    })
  }

  async #withTemp(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'zwrm-computer-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
