# Browser Template

An agent that can use a real web browser and a desktop. Every session gets two
MCP servers, on every harness (Claude, Codex, OpenCode, pi):

- **`browser`** ([Playwright MCP](https://github.com/microsoft/playwright-mcp)):
  a Chromium driven through the page structure. It runs on the virtual
  desktop, so the live view shows what the agent is browsing and a person who
  takes control drives the same browser. The tools show up as
  `mcp__browser__*`: navigate, click, type, fill forms, read the page's
  accessibility snapshot, take screenshots, manage tabs, and more. Fast and
  reliable; the first choice for web tasks.
- **`computer`**: computer use on a 1280×800 virtual desktop, by screenshot,
  mouse and keyboard (`mcp__computer__screenshot`, `left_click`, `type`,
  `key`, `scroll`, `zoom`, …). It mirrors Anthropic's computer-use toolset and
  is ported from Anthropic's reference implementation. For desktop apps,
  canvas-heavy pages and sites that resist automation. It works on the same
  desktop and the same browser window: the agent opens a page with the
  `browser` tools, then clicks and types in it by sight. Other GUI apps can be
  started from the shell with `DISPLAY=:99`.

There is one browser, and it always runs visibly on the desktop, so every
page the agent opens through its tools shows in the live view. (Only a script
the agent writes and runs headless from its shell would not.)

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

## Route sites through a proxy

Some sites block datacenter IP addresses (Akamai- or Cloudflare-protected
sites often do), while others (Google) misbehave behind a proxy. Give the
agent a proxy with the agent secret `BROWSER_PROXY`, and it routes **per
site**, on its own:

```bash
printf %s "http://user:pass@proxy.example.com:8080" | zwrm agent secrets set BROWSER_PROXY --stdin --instance my-agent
```

- Every site goes direct by default. The agent's `network` tools
  (`proxy_status`, `use_proxy`, `use_direct`) switch a site when it gets
  blocked; the choice takes effect on the next page load and is remembered in
  the workspace (`~/.zwrm/browser/routes.json`). A choice covers the domain
  and its subdomains; the most specific rule wins.
- Sites known to refuse datacenter networks go through the proxy from the
  start (`/etc/zwrm/browser/proxy-sites.json`: meinestadt.de, indeed.com).
- How it works: the browser always uses a small router on `127.0.0.1:18080`
  inside the VM, which picks the route per connection. The proxy itself is
  used by the host's egress gateway (at the VM's default gateway, port 1339):
  the credentials stay on the host and never enter the VM.
- If the organization sets a network policy (`zwrm org egress`,
  `zwrm agent egress`), the host enforces it on both routes; a blocked site
  fails with "Blocked by your organization's network policy", and
  `proxy_status` lists recent blocks so the agent tells the person instead of
  retrying.
- Accepted: `http://` and `https://` proxies, with or without credentials. A
  value that isn't a proxy URL is ignored, with a warning in the control
  plane's log.
- It applies from the workspace's next boot or wake.
- Only the browser routes per site, not the agent's shell.
- Needs zwrm v0.31.0+ on every host (the egress gateway).

## Notes

- Use `performance-2x` or larger. Chromium renders in software (no GPU), and
  shared-CPU sizes are too slow for it.
- Each computer-use action waits 2 s for the screen to settle before its
  screenshot, so it is slower than the `browser` tools.
- Web pages are untrusted input. A page can contain text written to steer the
  agent; review what an agent did on sites where it holds credentials.
- Needs a platform with image-declared MCP servers (zwrm v0.30.0+) and
  `/dev/shm` in every VM (v0.30.1+).
