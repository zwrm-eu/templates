# Template Authoring Guide

This guide walks you through creating, testing, and publishing agent templates for the zwrm platform.

## What is a Template?

A template is a GitHub repository containing a Dockerfile that extends the official `agent-base` image. It defines a specialized development environment — specific languages, tools, and configurations — that any user can deploy as a coding agent with a single command.

```bash
zwrm agent claude --template github.com/yourname/my-template
```

The `agent-base` image handles all the plumbing (SSH, credential storage, AI tools, platform CLI). Your template just adds the toolchain.

## What agent-base Provides

Your template inherits all of this automatically:

| Component | Details |
|-----------|---------|
| **OS** | Ubuntu 22.04 with build-essential, curl, git, jq, tmux, vim, ripgrep |
| **Node.js 22** | With corepack (required for Codex) |
| **GitHub CLI** | `gh` pre-installed and configured |
| **Claude Code** | Native installer, ready to use |
| **OpenAI Codex** | Global npm package |
| **zwrm CLI** | Platform CLI for deployments |
| **SSH Server** | Key-based auth, no passwords |
| **Agent user** | Non-root `agent` user with passwordless sudo |
| **Credential storage** | gnome-keyring for OAuth token persistence |
| **Home seeding** | `/home/agent` contents automatically seeded to persistent volume on first boot |

You do **not** need to install or configure any of the above.

## Creating Your First Template

### 1. Create the Repository

```
my-template/
├── Dockerfile              # Required — extends agent-base
├── zwrm-template.toml      # Optional — template metadata
└── README.md               # Recommended — with deploy badge
```

### 2. Write the Dockerfile

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest

# System packages — switch to root
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3-pip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# User packages — switch back to agent
USER agent
RUN pip install --user torch numpy pandas scikit-learn jupyter
```

Key rules:

- **Always start FROM `ghcr.io/zwrm-eu/agent-base:latest`**
- Use `USER root` for `apt-get` installs, then switch back to `USER agent`
- Use `--no-install-recommends` and clean up apt caches to keep images small
- Use `pip install --user` or install to `~/.local` for user-space packages
- Do **not** override SSH configuration or the agent user setup

### 3. Add Metadata (Optional)

Create `zwrm-template.toml` in the repository root:

```toml
[template]
name = "Python ML"
description = "Python machine learning environment with PyTorch and Jupyter"
author = "yourname"
icon = "zap"
tags = ["python", "ml", "pytorch", "jupyter"]
default_size = "performance-4x"
min_size = "performance-2x"

[template.env]
JUPYTER_PORT = "8888"
```

### 4. Push to GitHub

```bash
git init && git add . && git commit -m "Initial template"
gh repo create my-template --public --push
```

### 5. Deploy It

```bash
zwrm agent claude --template github.com/yourname/my-template
```

That's it. The platform clones your repo, builds the Dockerfile, and launches a VM with your environment.

## zwrm-template.toml Reference

All fields are optional. If the file is absent, the template still works — it just won't have metadata in the registry.

```toml
[template]
# Display name shown in the dashboard gallery
name = "Python ML"

# One-line description
description = "Python machine learning environment with PyTorch and Jupyter"

# GitHub username or organization
author = "yourname"

# Icon key (see Icon Registry below) or URL to a custom icon
icon = "zap"

# Tags for filtering in the gallery (lowercase, no spaces)
tags = ["python", "ml", "pytorch"]

# Recommended VM size (shown as default in launch modal)
# Options: shared-cpu-1x, shared-cpu-2x, shared-cpu-4x,
#          performance-1x, performance-2x, performance-4x, performance-8x
default_size = "performance-2x"

# Minimum VM size that can run this template
min_size = "shared-cpu-4x"

[template.env]
# Default environment variables injected into the agent VM
# Users can override these at launch time
MY_VAR = "default_value"
```

## Dockerfile Best Practices

### Do

- **Extend `agent-base`** — it provides everything your template needs as a foundation
- **Clean up after apt** — `&& apt-get clean && rm -rf /var/lib/apt/lists/*`
- **Install user tools as `agent`** — `pip install --user`, `cargo install`, `go install`
- **Use multi-line RUN** — combine related commands to reduce layers
- **Pin versions** when reproducibility matters — `python3.12` not just `python3`

### Don't

- **Don't override SSH config** — agent-base sets up key-based auth correctly
- **Don't change the agent user** — the platform expects `USER agent` with home at `/home/agent`
- **Don't set ENTRYPOINT or CMD** — the platform manages the boot process
- **Don't install Claude Code or Codex** — they're already in agent-base
- **Don't install Node.js** — Node 22 is already in agent-base (add more versions if needed)

### Example: Go Template

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest

USER root

# Go 1.22
RUN curl -fsSL https://go.dev/dl/go1.22.0.linux-amd64.tar.gz \
    | tar -xz -C /usr/local
ENV PATH="/usr/local/go/bin:${PATH}"

USER agent

# Go tools
ENV GOPATH="/home/agent/go"
ENV PATH="${GOPATH}/bin:${PATH}"
RUN go install golang.org/x/tools/gopls@latest \
    && go install github.com/go-delve/delve/cmd/dlv@latest \
    && go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest \
    && go install github.com/air-verse/air@latest
```

### Example: Rust Template

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest

USER agent

# Rust (installed as agent user)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/home/agent/.cargo/bin:${PATH}"

# Common tools
RUN cargo install cargo-watch cargo-edit cargo-expand
```

### Example: Web Development Template

```dockerfile
FROM ghcr.io/zwrm-eu/agent-base:latest

USER agent

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/agent/.bun/bin:${PATH}"

# pnpm
RUN corepack prepare pnpm@latest --activate

# Playwright dependencies
USER root
RUN npx playwright install-deps
USER agent
RUN npx playwright install
```

## Home Directory Seeding

Any files in `/home/agent` at build time are automatically copied to the agent's persistent volume on first boot. This means:

- Config files (`.bashrc`, `.gitconfig`, editor configs) persist across sessions
- Installed packages in `~/.local`, `~/.cargo`, `~/.rustup` survive reconnects
- The first boot seeds the volume; subsequent boots use the existing volume contents

You don't need to add any special logic for this — the platform handles it via the skel system.

## Monorepo / Subdirectory Templates

Templates can live in a subdirectory of a larger repository. Users specify the path after the repo URL:

```bash
zwrm agent claude --template github.com/yourorg/templates/python-ml
```

The platform clones the repo and uses the `python-ml` subdirectory as the build context. This is how the official templates are organized:

```
github.com/zwrm-eu/templates/
├── go/
│   ├── Dockerfile
│   └── zwrm-template.toml
├── python-api/
│   ├── Dockerfile
│   └── zwrm-template.toml
└── web/
    ├── Dockerfile
    └── zwrm-template.toml
```

## Adding a Deploy Badge

Add this to your template's README so users can deploy with one click:

```markdown
[![Deploy on zwrm](https://dashboard.zwrm.eu/badge.svg)](https://dashboard.zwrm.eu/new/agent?template=github.com/yourname/my-template)
```

This links to the dashboard, which opens the agent launch modal pre-filled with your template.

## VM Sizes

Reference for the `default_size` and `min_size` fields:

| Preset | vCPUs | Memory |
|--------|-------|--------|
| shared-cpu-1x | 1 | 256 MB |
| shared-cpu-2x | 1 | 512 MB |
| shared-cpu-4x | 2 | 1 GB |
| performance-1x | 1 | 2 GB |
| performance-2x | 2 | 4 GB |
| performance-4x | 4 | 8 GB |
| performance-8x | 8 | 16 GB |

Most development templates work well with `performance-2x`. ML/data science templates that load large models should use `performance-4x` or higher.

## Icon Registry

Built-in icon keys for use in `zwrm-template.toml`:

| Key | Description |
|-----|-------------|
| `box` | Generic package icon (default) |
| `terminal` | Terminal/CLI icon |
| `zap` | Lightning bolt (API/performance) |
| `globe` | Web/network icon |

More icon keys will be added as the template ecosystem grows. You can also specify a URL to a custom icon.

## Caching and Rebuilds

- Template images are cached by **repository URL + commit hash**
- Pushing a new commit to your template repo invalidates the cache
- The next agent launch with your template triggers a fresh build
- Builds are fast thanks to Docker layer caching and shallow clones

## Submitting to the Official Registry

To have your template listed in the dashboard gallery:

1. Ensure your template follows the guidelines above
2. Test it works: `zwrm agent claude --template github.com/yourname/my-template`
3. Open a pull request to the [zwrm repository](https://github.com/zwrm-eu/zwrm) adding your template to `templates/registry.json`:

```json
{
  "id": "my-template",
  "name": "My Template",
  "description": "One-line description of what this template provides.",
  "repo": "github.com/yourname/my-template",
  "icon": "zap",
  "tags": ["relevant", "tags"],
  "default_size": "performance-2x",
  "featured": false,
  "official": false
}
```

4. The PR will be reviewed for quality and security before merging

### Registry Requirements

- Template must extend `ghcr.io/zwrm-eu/agent-base:latest`
- Repository must be public
- Must include a `zwrm-template.toml` with at minimum `name` and `description`
- Dockerfile must build successfully
- `id` must be unique, lowercase, and use hyphens (e.g., `python-ml`, `rust-embedded`)
