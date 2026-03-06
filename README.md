# ZWRM Agent Templates

Official agent templates for [ZWRM](https://zwrm.eu). Each template is a specialized development environment that extends the [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) image.

## Available Templates

| Template | Description | Default Size |
|----------|-------------|-------------|
| [default](./default) | Full stack — Python, Go, Rust, Bun | `performance-2x` |
| [python-ml](./python-ml) | Machine learning — PyTorch, Jupyter, pandas | `performance-4x` |
| [python-api](./python-api) | API development — FastAPI, SQLAlchemy, PostgreSQL | `performance-2x` |
| [web](./web) | Web development — Bun, pnpm, Playwright | `performance-2x` |

## Usage

```bash
# Use a template when launching an agent
zwrm agent claude --template github.com/zwrm-eu/templates/python-ml
zwrm agent claude my-project --template github.com/zwrm-eu/templates/web

# Without --template, the default full-stack image is used
zwrm agent claude
```

## Creating Your Own Template

Create a GitHub repo with a `Dockerfile` that extends the base image:

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest
USER root
RUN apt-get update && apt-get install -y your-packages
USER agent
RUN pip install your-python-packages
```

Add an optional `zwrm-template.toml` for metadata:

```toml
[template]
name = "My Template"
description = "What this template is for"
default_size = "performance-2x"
tags = ["python", "web"]
```

Then use it: `zwrm agent claude --template github.com/you/your-template`
