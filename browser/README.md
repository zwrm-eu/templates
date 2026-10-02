# Browser Template

An agent that can use a real web browser and a desktop. Every session gets two
MCP servers, on every harness (Claude, Codex, OpenCode, pi):

- **`browser`** ([Playwright MCP](https://github.com/microsoft/playwright-mcp)):
  a headless Chromium driven through the page structure. The tools show up as
  `mcp__browser__*`: navigate, click, type, fill forms, read the page's
  accessibility snapshot, take screenshots, manage tabs, and more. Fast and
  reliable; the first choice for web tasks.
- **`computer`**: computer use on a 1280×800 virtual desktop, by screenshot,
  mouse and keyboard (`mcp__computer__screenshot`, `left_click`, `type`,
  `key`, `scroll`, `zoom`, …). It mirrors Anthropic's computer-use toolset and
  is ported from Anthropic's reference implementation. For desktop apps,
  canvas-heavy pages and sites that resist automation. The desktop starts on
  the first call; launch apps on it from the shell with `DISPLAY=:99`, e.g.
  `DISPLAY=:99 chromium https://example.com &`.

**Live view.** In the dashboard, the chat's side panel shows the desktop live
(VNC, relayed by the platform; nothing is exposed from the VM). Anyone who can
use the chat can watch; one person at a time can **take control** and use the
desktop with their own mouse and keyboard (the platform only passes input from
the person holding control). While they hold it, the agent's `computer` tools
refuse input and tell the model to wait; screenshots keep working so it can
see what was done, and its next observation after the hand-back tells it
control is back. This pause is cooperative: it stops the agent's computer-use
tools, not commands the agent runs in its shell. Control returns to the agent
when handed back, or on its own about 90 s after the person's browser goes
away. An org admin viewing a member's private chat can watch but not take
control.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Playwright MCP** (pinned) with its matching **Chromium** in `/opt/ms-playwright`
- **Computer-use server** in `/opt/zwrm-computer-mcp` with Xvfb, openbox,
  xdotool, scrot and ImageMagick
- `chromium`: the same Chromium, headed, for the desktop (own profile in
  `~/.zwrm/browser/desktop-profile`)
- The system libraries and fonts Chromium needs

The browser profile persists on the workspace volume
(`~/.zwrm/browser/profile`), so logins and cookies survive between sessions.
Snapshots and screenshots land in `~/.zwrm/browser/output`, capped at 100 MB
(oldest files are evicted first).

## Usage

```bash
zwrm agent claude --template github.com/zwrm-eu/templates/browser
zwrm agent claude researcher --template github.com/zwrm-eu/templates/browser
```

Scripts written against the same Playwright build (the one bundled with
Playwright MCP) can reuse the installed Chromium: `PLAYWRIGHT_BROWSERS_PATH`
points at it in SSH and terminal shells. Other Playwright versions expect a
different browser revision and need their own `playwright install`.

## Notes

- Use `performance-2x` or larger. Chromium renders in software (no GPU), and
  shared-CPU sizes are too slow for it.
- Each computer-use action waits 2 s for the screen to settle before its
  screenshot, so it is slower than the `browser` tools.
- Web pages are untrusted input. A page can contain text written to steer the
  agent; review what an agent did on sites where it holds credentials.
- Needs a platform with image-declared MCP servers (zwrm v0.30.0+) and
  `/dev/shm` in every VM (v0.30.1+).
