# Browser Template

An agent that can use a real web browser. Every session gets a `browser` MCP
server ([Playwright MCP](https://github.com/microsoft/playwright-mcp)) driving
a headless Chromium, on every harness (Claude, Codex, OpenCode, pi). The tools
show up as `mcp__browser__*`: navigate, click, type, fill forms, read the
page's accessibility snapshot, take screenshots, manage tabs, and more.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Playwright MCP** (pinned) with its matching **Chromium** in `/opt/ms-playwright`
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
- Web pages are untrusted input. A page can contain text written to steer the
  agent; review what an agent did on sites where it holds credentials.
- Needs a platform with image-declared MCP servers (zwrm v0.30.0+) and
  `/dev/shm` in every VM (v0.30.1+).
