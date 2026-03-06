FROM ghcr.io/zwrm-eu/agent-base:latest

# Python API development environment with FastAPI and common web tooling.

USER root

# -- Python 3.12 ---------------------------------------------------------------
RUN add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.12

USER agent

# -- Python packages -----------------------------------------------------------
RUN python3 -m pip install --user --no-cache-dir \
    fastapi uvicorn[standard] \
    sqlalchemy[asyncio] alembic \
    httpx pydantic-settings \
    celery[redis] redis \
    pytest pytest-asyncio pytest-cov \
    ruff

CMD ["/bin/bash"]
