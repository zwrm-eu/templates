FROM ghcr.io/zwrm-eu/agent-base:latest

# Web development environment with Bun, pnpm, and Playwright.

USER root

# -- Playwright system dependencies -------------------------------------------
RUN npx playwright install-deps 2>/dev/null || true

USER agent

# -- Bun -----------------------------------------------------------------------
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/agent/.bun/bin:${PATH}"

# -- pnpm ----------------------------------------------------------------------
RUN corepack enable && corepack prepare pnpm@latest --activate

# -- Global npm tools ----------------------------------------------------------
RUN npm install -g typescript tsx create-next-app create-vite @biomejs/biome

# -- Playwright ----------------------------------------------------------------
RUN npx playwright install chromium

CMD ["/bin/bash"]
