# Python API Template

Backend API development environment with FastAPI.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Python 3.12** with pip and venv
- **FastAPI** with uvicorn
- **SQLAlchemy** (async support) with Alembic migrations
- **httpx** for HTTP client
- **Celery** with Redis
- **pytest** with async and coverage plugins
- **ruff** linter/formatter

For databases, use `zwrm postgres create` to provision a managed PostgreSQL instance.

## Usage

```bash
zwrm agent claude --template github.com/zwrm-eu/templates/python-api
zwrm agent claude my-backend --template github.com/zwrm-eu/templates/python-api
```
