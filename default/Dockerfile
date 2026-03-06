FROM ghcr.io/zwrm-eu/agent-base:latest

# Full-stack development environment with Python, Go, Rust, and Bun.

USER root

# -- Python 3.12 ---------------------------------------------------------------
RUN add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev python3-pip \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# -- Go 1.22 -------------------------------------------------------------------
ENV GO_VERSION=1.22.5
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
    | tar -xz -C /usr/local

USER agent

# -- Rust (stable via rustup) --------------------------------------------------
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# -- Bun -----------------------------------------------------------------------
RUN curl -fsSL https://bun.sh/install | bash

# -- PATH setup ----------------------------------------------------------------
ENV PATH="/home/agent/.bun/bin:/home/agent/.cargo/bin:/usr/local/go/bin:/home/agent/go/bin:${PATH}"

CMD ["/bin/bash"]
