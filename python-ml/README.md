# Python ML Template

Machine learning development environment with PyTorch and data science tools.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Python 3.12** with pip and venv
- **PyTorch** (CPU) with torchvision and torchaudio
- **scikit-learn**, **numpy**, **pandas**, **matplotlib**, **seaborn**
- **Hugging Face** transformers and datasets

## Usage

```bash
zwrm agent claude --template github.com/zwrm-eu/templates/python-ml
zwrm agent claude my-research --template github.com/zwrm-eu/templates/python-ml
```

Recommended size: `performance-4x` (4 vCPUs, 8GB RAM) for ML workloads.
