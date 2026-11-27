# Contributing to OrgPace

Thank you for your interest in contributing to **OrgPace**! We welcome bug reports, documentation improvements, capability dictionary templates, integrations, and code pull requests from the community.

> 中文读者也可参考[文档索引（中文）](docs/README.md)与[中文主页](README_CN.md)。

## Ways to Contribute

- **Ask Questions & Share Ideas:** Start a thread in [GitHub Discussions](https://github.com/GSX-Eis/OrgPace/discussions) for usage questions, deployment tips, or feature brainstorming.
- **Report Bugs:** Open an issue using the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.yml). Never include real employee information, chat logs, or secrets.
- **Propose Features or Extensions:** Open a [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) before implementing large features, schema changes, or new dependencies.
- **Report Security Issues Privately:** See [SECURITY.md](SECURITY.md) — never disclose vulnerabilities in public issues or PRs.

All contributors are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Local Development Setup

### Prerequisites

- Python 3.14+ and [`uv`](https://docs.astral.sh/uv/)
- [Bun](https://bun.sh/) and Node.js (`>= 22.19.0`)
- Docker and Docker Compose (`>= 2.24.4`) for PostgreSQL and full-stack verification

### Install Dependencies & Run Dev Servers

1. Copy the example environment file from the repository root (for local development only):

   ```bash
   cp .env.example .env
   ```

2. Start PostgreSQL and prepare the database:

   ```bash
   docker compose -f compose.yml -f compose.dev.yml up -d db
   uv sync --all-packages --frozen
   (cd backend && uv run bash scripts/prestart.sh)
   ```

3. Start the backend and frontend dev servers in separate terminals:

   ```bash
   # Terminal 1 (Backend API at http://localhost:8000)
   (cd backend && uv run fastapi dev)

   # Terminal 2 (Frontend UI at http://localhost:5173)
   bun install --frozen-lockfile
   (cd frontend && bun run dev)
   ```

See [docs/development.md](docs/development.md) for more details on local development workflows and test databases, and [docs/extending.md](docs/extending.md) (`ZH`) if you are adding data connectors, chat channel adapters, or industry capability dictionary templates.

## Engineering Conventions

Please follow these core principles across all changes:

- **One focused PR per issue:** Keep changes minimal and avoid unrelated refactoring.
- **Tenant & permission boundaries:** Every business query must stay scoped to its organization (`org_id`), with authorization enforced server-side.
- **Append-only evidence:** Never update or delete historical evidence records; represent corrections with superseding or retraction records.
- **Database migrations:** Any schema change must include an Alembic migration tested for both `upgrade` and `downgrade`, keeping a single migration head.
- **Generated API client:** Regenerate the TypeScript client (`bash scripts/generate-client.sh`) whenever backend API routes or schemas change—never hand-edit generated files.
- **Synthetic data only:** All tests, examples, and screenshots must use 100% synthetic organizations, accounts, and work records. Never commit real employee data or secrets.
- **Bilingual UI & i18n:** User-facing web copy supports both English and Simplified Chinese; add translation keys for both locales instead of hardcoding UI strings.

## Checks & Testing

Run static checks and relevant tests before opening or updating a pull request:

```bash
# Backend lint & type checks
(cd backend && uv run bash scripts/lint.sh)

# Frontend lint, i18n, typecheck & build
(cd frontend && bunx biome check --no-errors-on-unmatched --files-ignore-unknown=true ./ && bunx tsc --noEmit && bun run build)
bun frontend/scripts/check-i18n.ts
bun frontend/scripts/check-no-chinese.ts

# Backend tests (requires Postgres running)
(cd backend && uv run pytest tests/<relevant-path> -x -q)
```

Do not delete or skip existing tests or weaken lint/type checks to make CI pass.

## Pull Request Process

1. Fork the repository and create a branch from `master`.
2. Write clear commit messages and fill out the [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md).
3. If adding or updating dependencies, list exact package versions and verify license compatibility with **Apache-2.0** (see [docs/licenses.md](docs/licenses.md)).
4. Ensure all GitHub Actions checks pass and respond to review feedback.

## Licensing

By submitting a contribution to OrgPace, you certify that you have the right to submit the work and agree that your contribution is licensed under the **Apache License 2.0** (inbound = outbound), without requiring a separate CLA.

- Project license: [LICENSE](LICENSE)
- Attribution & third-party notices: [NOTICE](NOTICE)
- Upstream template attribution: [licenses/full-stack-fastapi-template-MIT.txt](licenses/full-stack-fastapi-template-MIT.txt)
- Third-party dependency audit: [docs/licenses.md](docs/licenses.md) (`ZH`)
