FROM ghcr.io/zwrm-eu/agent-base:latest

# Go development environment with common tooling.

USER root

# -- Go 1.22 -------------------------------------------------------------------
ENV GO_VERSION=1.22.5
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
    | tar -xz -C /usr/local

ENV PATH="/usr/local/go/bin:/home/agent/go/bin:${PATH}"

USER agent

# -- Go tools ------------------------------------------------------------------
RUN go install golang.org/x/tools/gopls@latest \
    && go install github.com/go-delve/delve/cmd/dlv@latest \
    && go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest \
    && go install github.com/air-verse/air@latest

CMD ["/bin/bash"]
