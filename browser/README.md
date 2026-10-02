# Browser Template

An agent that can use a real web browser. Every session gets a `browser` MCP
server ([Playwright MCP](https://github.com/microsoft/playwright-mcp)) driving
a headless Chromium, on every harness (Claude, Codex, OpenCode, pi). The tools
show up as `mcp__browser__*`: navigate, click, type, fill forms, read the
page's accessibility snapshot, take screenshots, manage tabs, and more.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Playwright MCP** (pinned) with its matching **Chromium** in `/opt/ms-playwright`
- **X display stack** for computer use and the live view: Xvfb, openbox, xdotool, scrot, x11vnc, websockify
- Fonts for real-world pages (Liberation, Noto Color Emoji, plus Playwright's set)

The browser profile persists on the workspace volume
(`~/.zwrm/browser/profile`), so logins and cookies survive between sessions.
Snapshots and screenshots land in `~/.zwrm/browser/output`.

## Usage

```bash
zwrm agent claude --template github.com/zwrm-eu/templates/browser
zwrm agent claude researcher --template github.com/zwrm-eu/templates/browser
```

Your own scripts can use the same browsers: `PLAYWRIGHT_BROWSERS_PATH` is set
for SSH and terminal shells.

## Notes

- Use `performance-2x` or larger. Chromium renders in software (no GPU), and
  shared-CPU sizes are too slow for it.
- Web pages are untrusted input. A page can contain text written to steer the
  agent; review what an agent did on sites where it holds credentials.
- Needs a platform with image-declared MCP servers (zwrm v0.30.0+) and
  `/dev/shm` in every VM (v0.30.1+).
