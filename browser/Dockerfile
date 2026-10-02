FROM ghcr.io/zwrm-eu/agent-base:latest

# Browser agent (zwrm-eu/zwrm#1674): a real Chromium the agent drives through
# the `browser` MCP server (Playwright MCP), and a virtual desktop it operates
# by screenshot, mouse and keyboard through the `computer` MCP server, on
# every harness.
#
# Runtime notes for template authors reading this as an example:
#  - Dockerfile ENV does NOT reach the running VM (the init script is PID 1,
#    not Docker). Anything a tool needs at runtime goes in its MCP manifest's
#    "env" (for agent tools) or /etc/profile.d (for SSH/terminal shells).
#  - Browsers live under /opt, not $HOME: /home/agent is seeded onto the
#    persistent workspace volume, and ~400 MB of Chromium has no business there.

USER root

# -- Playwright MCP + its Chromium (PINNED) ------------------------------------
# The MCP server pins its own playwright build; the browser MUST be the one
# that build expects, so install it with the playwright CLI bundled inside the
# MCP package, never a separately installed `playwright`. Bump the version
# deliberately and rebuild. --no-shell: the headless shell (~270 MB) is unused,
# because the server launches the full Chromium even with --headless.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g @playwright/mcp@0.0.83 \
    && /usr/local/lib/node_modules/@playwright/mcp/node_modules/.bin/playwright install --with-deps --no-shell chromium \
    && chmod -R a+rX /opt/ms-playwright \
    && npm cache clean --force \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# -- Computer-use desktop (zwrm-eu/zwrm#1678) ----------------------------------
# Xvfb: the virtual display. openbox: a minimal window manager, so new windows
# get focus and stacking. xdotool + scrot: input and screenshots. imagemagick:
# zoom crops (and resizing, if the display is ever larger than 1280x800).
# x11vnc: the live view (loopback only; zwrm-agentd relays it, #1680).
# The `computer` MCP server starts the desktop on its first call; the live
# view can start it too (/etc/zwrm/desktop.json).
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    openbox \
    xdotool \
    scrot \
    imagemagick \
    x11vnc \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Dependencies first, so editing the server's source doesn't re-run npm ci.
COPY computer-mcp/package.json computer-mcp/package-lock.json /opt/zwrm-computer-mcp/
RUN cd /opt/zwrm-computer-mcp \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY computer-mcp/ /opt/zwrm-computer-mcp/
RUN rm -rf /opt/zwrm-computer-mcp/test && chmod -R a+rX /opt/zwrm-computer-mcp

# Login shells (SSH, terminal) see the same browsers. Only scripts on this
# exact Playwright build find one there; other versions expect other revisions.
RUN echo 'export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' > /etc/profile.d/playwright.sh

# -- MCP servers every session gets (zwrm-eu/zwrm#1676) ------------------------
# /etc/zwrm/mcp.d/<name>.json → tools named mcp__<name>__<tool> on every
# harness. --no-sandbox in the manifest: Chromium's own sandbox needs user
# namespaces the guest kernel may not offer; the Firecracker VM is the
# isolation boundary.
COPY bin/zwrm-browser-mcp bin/chromium /usr/local/bin/
COPY mcp.d/ /etc/zwrm/mcp.d/
# The desktop this image offers the dashboard's live view (zwrm-eu/zwrm#1680).
COPY desktop.json /etc/zwrm/desktop.json
RUN chmod 755 /usr/local/bin/zwrm-browser-mcp /usr/local/bin/chromium /etc/zwrm /etc/zwrm/mcp.d \
    && chmod 644 /etc/zwrm/mcp.d/*.json /etc/zwrm/desktop.json

USER agent

CMD ["/bin/bash"]
