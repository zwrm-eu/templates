#!/usr/bin/env node
// `desktop.mjs start`: start the virtual desktop (Xvfb, openbox, x11vnc) if it
// is not running, then exit. The image's /etc/zwrm/desktop.json names this as
// its start command, so zwrm-agentd can start the desktop when a member opens
// the live view before the agent has used computer use (zwrm-eu/zwrm#1680).
import { Display } from './display.mjs'

if (process.argv[2] !== 'start') {
  process.stderr.write('usage: desktop.mjs start\n')
  process.exit(2)
}
const int = (name, fallback) => {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(v) && v > 0 ? v : fallback
}
const display = new Display({
  num: int('ZWRM_COMPUTER_DISPLAY', 99),
  width: int('ZWRM_COMPUTER_WIDTH', 1280),
  height: int('ZWRM_COMPUTER_HEIGHT', 800),
  log: (msg) => process.stderr.write(`[zwrm-desktop] ${msg}\n`),
})
await display.ensure()
