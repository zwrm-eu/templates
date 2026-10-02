#!/usr/bin/env node
// zwrm computer-use MCP server (zwrm-eu/zwrm#1678). Stdio server, spawned by
// agentd for every session from /etc/zwrm/mcp.d/computer.json; its tools reach
// the model as mcp__computer__<action>, mirroring Anthropic's computer toolset
// (computer_toolset_20260801: one tool per action, named after the action).
//
// Environment: ZWRM_COMPUTER_DISPLAY (default 99), ZWRM_COMPUTER_WIDTH /
// ZWRM_COMPUTER_HEIGHT (default 1280x800, a scaling target, so screenshots
// are 1:1 with the display), ZWRM_COMPUTER_SCREENSHOT_DELAY_MS (default 2000,
// the reference's settle time before the screenshot that follows an action).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Display } from './display.mjs'
import { CLICK_ACTIONS, Computer, KEY_REPEAT_MAX, MAX_DURATION_S, ToolError } from './computer.mjs'

const int = (name, fallback) => {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(v) && v > 0 ? v : fallback
}

const log = (msg) => process.stderr.write(`[zwrm-computer] ${msg}\n`)
const display = new Display({
  num: int('ZWRM_COMPUTER_DISPLAY', 99),
  width: int('ZWRM_COMPUTER_WIDTH', 1280),
  height: int('ZWRM_COMPUTER_HEIGHT', 800),
  log,
})
const computer = new Computer({
  display,
  screenshotDelayMs: process.env.ZWRM_COMPUTER_SCREENSHOT_DELAY_MS !== undefined
    ? Math.max(0, parseInt(process.env.ZWRM_COMPUTER_SCREENSHOT_DELAY_MS, 10) || 0)
    : 2000,
})
const [frameW, frameH] = computer.screenshotSize()

// Shared vocabulary. Coordinates are screenshot pixels: the frame of the
// screenshots these tools return.
const coordinate = z.array(z.number().int().min(0)).length(2)
  .describe(`[x, y] in screenshot pixels (0..${frameW - 1}, 0..${frameH - 1})`)
const modifier = z.string().optional()
  .describe("Modifier keys to hold during the action, xdotool syntax, e.g. 'shift' or 'ctrl+shift'")
const duration = z.number().min(0).max(MAX_DURATION_S).describe('Seconds')

const DESKTOP = `a ${frameW}x${frameH} Linux desktop (X display ${display.name}, openbox window manager). ` +
  `Start GUI apps from the shell with DISPLAY=${display.name}, e.g. \`DISPLAY=${display.name} chromium https://example.com &\`.`

const TOOLS = {
  screenshot: { description: `Take a screenshot of ${DESKTOP} Call this first to see the screen.`, input: {} },
  zoom: {
    description: 'Return a magnified, full-resolution view of a screen region, fitted to the screenshot frame. Use it to read small text. Coordinates for other actions stay in screenshot pixels.',
    input: { region: z.array(z.number().int().min(0)).length(4).describe('[x0, y0, x1, y1] in screenshot pixels, x0 < x1 and y0 < y1') },
  },
  cursor_position: { description: 'Return the current mouse position in screenshot pixels.', input: {} },
  mouse_move: { description: 'Move the mouse to a position.', input: { coordinate } },
  left_click_drag: {
    description: 'Press the left button at start_coordinate, drag to coordinate, release.',
    input: { start_coordinate: coordinate, coordinate, text: modifier },
  },
  left_mouse_down: { description: 'Press and hold the left mouse button at the current position.', input: {} },
  left_mouse_up: { description: 'Release the left mouse button at the current position.', input: {} },
  key: {
    description: "Press a key or key chord, xdotool keysym syntax: 'Return', 'Tab', 'ctrl+a', 'ctrl+shift+t', 'Page_Down'.",
    input: { text: z.string().describe('Key or chord'), repeat: z.number().int().min(1).max(KEY_REPEAT_MAX).optional().describe('Press it this many times (default 1)') },
  },
  hold_key: { description: 'Hold a key or chord down for a duration, then release it.', input: { text: z.string().describe('Key or chord'), duration } },
  type: { description: 'Type a string of text at the keyboard focus.', input: { text: z.string() } },
  scroll: {
    description: 'Scroll the mouse wheel, optionally after moving to a position.',
    input: {
      coordinate: coordinate.optional(),
      scroll_direction: z.enum(['up', 'down', 'left', 'right']),
      scroll_amount: z.number().int().min(0).describe('Wheel clicks'),
      text: modifier,
    },
  },
  wait: { description: 'Wait for a duration, then take a screenshot.', input: { duration } },
}
for (const action of CLICK_ACTIONS) {
  TOOLS[action] = {
    description: `${action.replace('_', ' ')} at a position (or the current one if omitted).`,
    input: { coordinate: coordinate.optional(), text: modifier },
  }
}

function toContent(result) {
  const content = []
  const text = [result.output, result.error].filter(Boolean).join('\n')
  if (text) content.push({ type: 'text', text })
  if (result.image) content.push({ type: 'image', data: result.image, mimeType: 'image/png' })
  if (content.length === 0) content.push({ type: 'text', text: 'done' })
  return { content }
}

const server = new McpServer({ name: 'zwrm-computer', version: '0.1.0' })
for (const [action, spec] of Object.entries(TOOLS)) {
  server.registerTool(action, { description: spec.description, inputSchema: spec.input }, async (args) => {
    try {
      return toContent(await computer.call(action, args))
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `${action} failed: ${err?.message || err}`
      return { isError: true, content: [{ type: 'text', text: message }] }
    }
  })
}

await server.connect(new StdioServerTransport())
