# Python API Template

Backend API development environment with FastAPI and PostgreSQL.

## What's Included

Everything from [agent-base](https://github.com/zwrm-eu/zwrm/pkgs/container/agent-base) plus:

- **Python 3.12** with pip and venv
- **FastAPI** with uvicorn
- **SQLAlchemy** (async support) with Alembic migrations
- **PostgreSQL** client libs (psycopg2, asyncpg)
- **Redis** client and Celery
- **httpx** for HTTP client
- **pytest** with async and coverage plugins
- **ruff** linter/formatter

## Usage

```bash
zwrm agent claude --template github.com/zwrm-eu/templates/python-api
zwrm agent claude my-backend --template github.com/zwrm-eu/templates/python-api
```
