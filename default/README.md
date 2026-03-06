# Full Stack Template

The default agent environment with all major language toolchains pre-installed.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Python 3.12** with pip and venv
- **Go 1.22**
- **Rust** (stable via rustup)
- **Bun** (fast JavaScript runtime/bundler)
- **Node.js 22** (from base image)

## Usage

```bash
# This is the default — no --template needed
zwrm agent claude

# Or explicitly
zwrm agent claude --template github.com/zwrm-eu/templates/default
```
