# Web Development Template

Frontend and full-stack web development environment.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Node.js 22** (from base image)
- **Bun** (fast runtime/bundler/package manager)
- **pnpm** (via corepack)
- **TypeScript**, **tsx** (global)
- **create-next-app**, **create-vite** (project scaffolding)
- **Biome** (linter/formatter)
- **Playwright** with Chromium (E2E testing)

## Usage

```bash
zwrm agent claude --template github.com/zwrm-eu/templates/web
zwrm agent claude my-site --template github.com/zwrm-eu/templates/web
```
