# ZWRM Agent Templates

Official agent templates for [ZWRM](https://zwrm.eu). Each template is a specialized development environment that extends the [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) image.

## Available Templates

| Template | Description | Default Size |
|----------|-------------|-------------|
| [default](./default) | Full stack — Python, Go, Rust, Bun | `performance-2x` |
| [go](./go) | Go — gopls, delve, golangci-lint, air | `performance-2x` |
| [python-api](./python-api) | Python API — FastAPI, SQLAlchemy, Redis | `performance-2x` |
| [web](./web) | Web — Bun, pnpm, Playwright, Next.js/Vite | `performance-2x` |

## Usage

```bash
# Use a template when launching an agent
zwrm agent claude --template github.com/zwrm-eu/templates/go
zwrm agent claude my-project --template github.com/zwrm-eu/templates/web

# Without --template, the default full-stack image is used
zwrm agent claude
```

## Creating Your Own Template

See the full [Template Authoring Guide](./CONTRIBUTING.md) for step-by-step instructions, Dockerfile best practices, `zwrm-template.toml` reference, and how to submit your template to the official registry.

Quick version:

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest
USER root
RUN apt-get update && apt-get install -y your-packages
USER agent
RUN pip install --user your-python-packages
```

Then use it: `zwrm agent claude --template github.com/you/your-template`
