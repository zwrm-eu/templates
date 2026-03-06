FROM ghcr.io/zwrm-eu/agent-base:latest

# Web development environment with Bun, pnpm, and Playwright.

USER root

# -- Playwright system dependencies -------------------------------------------
RUN npx playwright install-deps 2>/dev/null || true

# -- Global npm tools (install as root to avoid cache permission issues) -------
RUN npm install -g typescript tsx create-next-app create-vite @biomejs/biome

# -- pnpm (corepack enable needs root) -----------------------------------------
RUN corepack enable

# Fix npm cache ownership (base image's root npm install leaves root-owned files)
RUN rm -rf /home/agent/.npm

USER agent

# -- Bun -----------------------------------------------------------------------
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/agent/.bun/bin:${PATH}"

# -- pnpm ----------------------------------------------------------------------
RUN corepack prepare pnpm@latest --activate

# -- Playwright ----------------------------------------------------------------
RUN npx playwright install chromium

CMD ["/bin/bash"]
