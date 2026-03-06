# Go Template

Go development environment for APIs, CLIs, and backend services.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Go 1.22**
- **gopls** (language server)
- **delve** (debugger)
- **golangci-lint** (linter)
- **air** (live reload)
- **PostgreSQL** client

## Usage

```bash
zwrm agent claude --template github.com/zwrm-eu/templates/go
zwrm agent claude my-api --template github.com/zwrm-eu/templates/go
```
