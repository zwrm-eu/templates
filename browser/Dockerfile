FROM ghcr.io/zwrm-eu/agent-base:latest

# Browser agent (zwrm-eu/zwrm#1674): a real Chromium the agent drives through
# the `browser` MCP server (Playwright MCP), on every harness.
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

# Login shells (SSH, terminal) see the same browsers. Only scripts on this
# exact Playwright build find one there; other versions expect other revisions.
RUN echo 'export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' > /etc/profile.d/playwright.sh

# -- MCP servers every session gets (zwrm-eu/zwrm#1676) ------------------------
# /etc/zwrm/mcp.d/<name>.json → tools named mcp__<name>__<tool> on every
# harness. --no-sandbox in the manifest: Chromium's own sandbox needs user
# namespaces the guest kernel may not offer; the Firecracker VM is the
# isolation boundary.
COPY bin/zwrm-browser-mcp /usr/local/bin/zwrm-browser-mcp
COPY mcp.d/ /etc/zwrm/mcp.d/
RUN chmod 755 /usr/local/bin/zwrm-browser-mcp /etc/zwrm /etc/zwrm/mcp.d \
    && chmod 644 /etc/zwrm/mcp.d/*.json

USER agent

CMD ["/bin/bash"]
