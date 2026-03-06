FROM ghcr.io/zwrm-eu/agent-base:latest

# Machine learning environment with Python, PyTorch, and data science tools.

USER root

# -- Python 3.12 ---------------------------------------------------------------
RUN add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev python3-pip \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

USER agent

# -- Python packages -----------------------------------------------------------
RUN python3 -m pip install --user --no-cache-dir \
    torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu \
    && python3 -m pip install --user --no-cache-dir \
    numpy pandas scikit-learn matplotlib seaborn \
    transformers datasets \
    pytest

CMD ["/bin/bash"]
