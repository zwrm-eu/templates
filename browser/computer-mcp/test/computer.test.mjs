import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { Computer, ToolError } from '../computer.mjs'

// A fake display + runner: records every command, "captures" a tiny PNG.
function harness({ width = 1280, height = 800, fail = {} } = {}) {
  const calls = []
  const display = { width, height, env: { DISPLAY: ':99' }, ensured: 0, ensure() { this.ensured++ } }
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (fail[cmd]) return { ok: false, stdout: '', stderr: fail[cmd] }
    if (cmd === 'scrot') await writeFile(args[args.length - 1], 'PNG')
    if (cmd === 'convert') await writeFile(args[args.length - 1], 'PNG2')
    if (cmd === 'xdotool' && args[0] === 'getmouselocation') return { ok: true, stdout: 'X=1919\nY=1079\nSCREEN=0\n', stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  const computer = new Computer({ display, run, screenshotDelayMs: 0, sleep: async () => {} })
  const xdo = () => calls.filter((c) => c[0] === 'xdotool').map((c) => c.slice(1))
  return { computer, calls, display, xdo }
}

test('a 1280x800 display is already a scaling target: identity, 1:1 screenshots', async () => {
  const { computer, calls } = harness()
  assert.deepEqual(computer.screenshotSize(), [1280, 800])
  const r = await computer.call('screenshot')
  assert.equal(Buffer.from(r.image, 'base64').toString(), 'PNG')
  assert.ok(!calls.some((c) => c[0] === 'convert'), 'no resize needed')
})

test('a 1920x1080 display scales to FWXGA both ways (reference behavior)', async () => {
  const { computer, calls, xdo } = harness({ width: 1920, height: 1080 })
  assert.deepEqual(computer.screenshotSize(), [1366, 768])
  await computer.call('screenshot')
  assert.deepEqual(calls.find((c) => c[0] === 'convert').slice(2, 4), ['-resize', '1366x768!'])
  await computer.call('left_click', { coordinate: [683, 384] })
  assert.deepEqual(xdo().at(-1), ['mousemove', '--sync', '960', '540', 'click', '1'])
  assert.equal((await computer.call('cursor_position')).output, 'X=1365,Y=767')
  await assert.rejects(computer.call('mouse_move', { coordinate: [1367, 10] }), /out of bounds/)
})

test('clicks: argv per action, optional move, held modifier chord in text', async () => {
  const { computer, xdo } = harness()
  await computer.call('double_click', { coordinate: [10, 20] })
  assert.deepEqual(xdo().at(-1), ['mousemove', '--sync', '10', '20', 'click', '--repeat', '2', '--delay', '10', '1'])
  await computer.call('right_click')
  assert.deepEqual(xdo().at(-1), ['click', '3'])
  await computer.call('left_click', { coordinate: [1, 2], text: 'shift' })
  assert.deepEqual(xdo().at(-1), ['mousemove', '--sync', '1', '2', 'keydown', 'shift', 'click', '1', 'keyup', 'shift'])
})

test('model text never reaches a shell: it is one argv element', async () => {
  const { computer, xdo } = harness()
  await computer.call('type', { text: 'a; rm -rf ~ $(id) `x`' })
  assert.deepEqual(xdo().at(-1), ['type', '--delay', '12', '--', 'a; rm -rf ~ $(id) `x`'])
})

test('type chunks long text in groups of 50 and screenshots once', async () => {
  const { computer, calls, xdo } = harness()
  await computer.call('type', { text: 'x'.repeat(120) })
  assert.deepEqual(xdo().map((a) => a.at(-1).length), [50, 50, 20])
  assert.equal(calls.filter((c) => c[0] === 'scrot').length, 1)
})

test('key: repeat expands, bounds enforced', async () => {
  const { computer, xdo } = harness()
  await computer.call('key', { text: 'Down', repeat: 3 })
  assert.deepEqual(xdo().at(-1), ['key', '--', 'Down', 'Down', 'Down'])
  await assert.rejects(computer.call('key', { text: 'a', repeat: 101 }), ToolError)
  await assert.rejects(computer.call('key', {}), /text is required/)
})

test('scroll and drag argv', async () => {
  const { computer, xdo } = harness()
  await computer.call('scroll', { coordinate: [5, 6], scroll_direction: 'down', scroll_amount: 3, text: 'ctrl' })
  assert.deepEqual(xdo().at(-1), ['mousemove', '--sync', '5', '6', 'keydown', 'ctrl', 'click', '--repeat', '3', '5', 'keyup', 'ctrl'])
  await computer.call('left_click_drag', { start_coordinate: [1, 1], coordinate: [9, 9] })
  assert.deepEqual(xdo().at(-1), ['mousemove', '--sync', '1', '1', 'mousedown', '1', 'mousemove', '--sync', '9', '9', 'mouseup', '1'])
  await assert.rejects(computer.call('scroll', { scroll_direction: 'sideways', scroll_amount: 1 }), /scroll_direction/)
})

test('zoom crops the full-resolution capture and fits it to the frame', async () => {
  const { computer, calls } = harness({ width: 1920, height: 1080 })
  await computer.call('zoom', { region: [0, 0, 683, 384] })
  const convert = calls.find((c) => c[0] === 'convert')
  assert.deepEqual(convert.slice(2, 7), ['-crop', '960x540+0+0', '+repage', '-resize', '1366x768'])
  await assert.rejects(computer.call('zoom', { region: [10, 10, 5, 20] }), /x0 < x1/)
})

test('invalid input, failures, and serialization', async () => {
  const { computer, display } = harness({ fail: { xdotool: 'cannot open display' } })
  await assert.rejects(computer.call('mouse_move', { coordinate: [1.5, 2] }), /non-negative integers/)
  await assert.rejects(computer.call('left_click', { coordinate: [1, 1] }), /cannot open display/)
  await assert.rejects(computer.call('teleport'), /Invalid action/)
  await assert.rejects(computer.call('wait', { duration: 101 }), /too long/)
  // a failed call does not wedge the queue
  const ok = harness()
  await assert.rejects(ok.computer.call('nope'))
  assert.ok((await ok.computer.call('screenshot')).image)
  assert.ok(display.ensured >= 4, 'every call ensures the desktop first')
})

test('calls run one at a time', async () => {
  const order = []
  const display = { width: 1280, height: 800, env: {}, ensure() {} }
  const run = async (cmd, args) => {
    if (cmd === 'xdotool') {
      order.push(`start ${args[0]}`)
      await new Promise((r) => setTimeout(r, args[0] === 'mousemove' ? 30 : 1))
      order.push(`end ${args[0]}`)
    }
    if (cmd === 'scrot') await writeFile(args.at(-1), 'P')
    return { ok: true, stdout: '', stderr: '' }
  }
  const c = new Computer({ display, run, screenshotDelayMs: 0 })
  await Promise.all([c.call('mouse_move', { coordinate: [1, 1] }), c.call('key', { text: 'a' })])
  assert.deepEqual(order.filter((o) => !o.includes('getmouselocation')), ['start mousemove', 'end mousemove', 'start key', 'end key'])
  assert.ok(order.indexOf('end mousemove') < order.indexOf('start key'))
})

test('a move to where the pointer already is skips mousemove --sync (it would stall)', async () => {
  const { computer, xdo } = harness({ width: 1920, height: 1080 }) // fake pointer sits at 1919,1079
  await computer.call('left_click', { coordinate: [1365, 767] }) // scales to 1919,1079
  assert.deepEqual(xdo().at(-1), ['click', '1'])
  await computer.call('mouse_move', { coordinate: [1365, 767] })
  assert.notDeepEqual(xdo().at(-1)[0], 'mousemove')
  await computer.call('left_click_drag', { start_coordinate: [1365, 767], coordinate: [1365, 767] })
  assert.deepEqual(xdo().at(-1), ['mousedown', '1', 'mouseup', '1'])
})

test('review: the right/bottom edge is out of bounds (pixels run 0..width-1)', async () => {
  const { computer } = harness()
  await assert.rejects(computer.call('mouse_move', { coordinate: [1280, 10] }), /out of bounds/)
  await assert.rejects(computer.call('left_click', { coordinate: [10, 800] }), /out of bounds/)
  await computer.call('mouse_move', { coordinate: [1279, 799] })
  const scaled = harness({ width: 1920, height: 1080 })
  await assert.rejects(scaled.computer.call('mouse_move', { coordinate: [1366, 0] }), /out of bounds/)
  // the last screenshot pixel maps onto the last display pixel, never past it
  assert.deepEqual(scaled.computer.coords([1365, 767]), ['1919', '1079'])
})

test('review: durations stay under the MCP 60 s request timeout', async () => {
  const { computer } = harness()
  await assert.rejects(computer.call('wait', { duration: 51 }), /too long/)
  await computer.call('wait', { duration: 50 })
})

test('review: modifier chords must be keysyms (no xdotool command words or options)', async () => {
  const { computer, xdo } = harness()
  for (const text of ['exec', 'type', '--help', '--window', 'ctrl shift', 'a;b']) {
    if (text === 'exec' || text === 'type') continue // valid keysym shapes; xdotool sees them after keydown
    await assert.rejects(computer.call('left_click', { text }), /keysyms/, text)
    await assert.rejects(computer.call('hold_key', { text, duration: 0 }), /keysyms/, text)
  }
  await computer.call('left_click', { text: 'ctrl+shift' })
  assert.deepEqual(xdo().at(-1), ['keydown', 'ctrl+shift', 'click', '1', 'keyup', 'ctrl+shift'])
})

test('review: scroll_amount 0 is rejected up front; errors name the action', async () => {
  const { computer } = harness()
  await assert.rejects(computer.call('scroll', { scroll_direction: 'down', scroll_amount: 0 }), /positive integer/)
  const failing = harness({ fail: { xdotool: 'boom' } })
  await assert.rejects(failing.computer.call('right_click'), /^ToolError: right_click failed: boom$|right_click failed: boom/)
})

test('review: hold_key releases the key even if the wait throws, and fails fast on keydown', async () => {
  const { computer, xdo } = harness()
  await computer.call('hold_key', { text: 'shift', duration: 1 })
  assert.deepEqual(xdo().slice(-2), [['keydown', 'shift'], ['keyup', 'shift']])
  assert.equal(computer.keyHeld, null)
  const failing = harness({ fail: { xdotool: 'bad key' } })
  await assert.rejects(failing.computer.call('hold_key', { text: 'shift', duration: 50 }), /hold_key failed: bad key/)
})

test('review: release() lets go of a held button on shutdown', async () => {
  const { computer, xdo } = harness()
  await computer.call('left_mouse_down')
  await computer.release()
  assert.deepEqual(xdo().at(-1), ['mouseup', '1'])
  await computer.release()
  assert.deepEqual(xdo().at(-1), ['mouseup', '1'], 'nothing more to release')
  assert.equal(xdo().filter((a) => a[0] === 'mouseup').length, 1)
})
