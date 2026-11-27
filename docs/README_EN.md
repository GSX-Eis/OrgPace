# Documentation Index (English)

Welcome to the **OrgPace** documentation. Most end-user and operations guides are currently authored in Simplified Chinese (`ZH`) alongside bilingual development docs; this page provides English navigation and a concise deployment and configuration reference.

> 中文用户请访问[中文文档索引](README.md)或[简体中文主页](../README_CN.md)。

## Quick Reference: Deployment & Configuration

### 1. Local Evaluation (Docker Compose)

> [!CAUTION]
> **Evaluation Only:** `.env.example` runs in development mode with placeholder secrets (`changethis`, `demo-password-2026`) and synthetic demo accounts. Never expose a development deployment to untrusted networks.

- **Prerequisites:** Docker and Docker Compose (`>= 2.24.4`), recommended **>= 20 GiB** free disk space (do not build with `< 15 GiB`).
- **First Build Time:** Typically **3–8 minutes** on first run while images and frontend assets are built; subsequent starts take seconds.
- **Commands:**
  ```bash
  git clone https://github.com/GSX-Eis/OrgPace.git
  cd OrgPace
  cp .env.example .env
  docker compose up -d --wait
  ```
- Open **<http://localhost:8000>** and use the top-right `中文 / EN` toggle at any time.
- **API Key Not Required for Demo:** Local evaluation with `examples/demo-org/` works out of the box without configuring any AI model API key. You only configure a model provider in **Admin → Models** if you want to test AI profile drafting or conversational assistant turns.

### 2. Production Installation (`./install.sh`)

For LAN or public-domain HTTPS deployments:

```bash
git clone https://github.com/GSX-Eis/OrgPace.git
cd OrgPace
./install.sh
```

- Generates random secrets with `0600` `.env` permissions and disables demo data (`SEED_DEMO_DATA=false`).
- Supports HTTP (LAN), self-signed HTTPS, or automatic Let's Encrypt HTTPS (`EPP_ACCESS=https-letsencrypt`).
- Outputs a single-use 72-hour setup link (`.../setup#token=...`) for initial organization creation.
- Full details: [Production Deployment Guide](deploy.md) (`ZH`).

### 3. Key Configuration Areas (Web Admin)

Once logged in as an organization administrator, configure integrations directly in the web UI (no `.env` edits needed for tenant credentials):

- **Data Sources (`Admin → Sources`):** Connect **Jira Cloud** (API token), **Jira Data Center** (PAT / Basic Auth), or upload **CSV / XLSX** work records.
- **Collaboration Channels (`Admin → IM Channels`):** Connect **Feishu** or **WeCom** via outbound persistent connections (no public inbound webhook URL required).
- **AI Models (`Admin → Models`):** Optionally configure **OpenAI**, **Anthropic Claude**, **DeepSeek**, **Qwen (DashScope)**, **Moonshot / Kimi**, **OpenRouter**, **Ollama**, **OpenAI-compatible** endpoints, or **ChatGPT Subscription**.

## Documentation Directory

### Overview & Demo Data

| Document | Language | Description |
| :--- | :---: | :--- |
| [Project Home (`README.md`)](../README.md) | EN | Product overview, tour, integrations, and quick start |
| [Project Home (`README_CN.md`)](../README_CN.md) | ZH | Simplified Chinese project overview |
| [Synthetic Demo Org](../examples/demo-org/README.md) | ZH | Synthetic 12-person demo organization structure and credentials |
| [Capability Dictionary Templates](../templates/README.md) | ZH | Industry capability dictionary YAML templates |

### Deployment & Operations

| Document | Language | Description |
| :--- | :---: | :--- |
| [Production Deployment & Maintenance](deploy.md) | ZH | `./install.sh`, HTTPS setup, upgrades, backups, and troubleshooting |
| [Docker Compose Guide](deployment-docker-compose.md) | ZH | Local Docker Compose stack, ports, and worker health |
| [Cross-Service Smoke Script](../tests/smoke/compose_smoke.sh) | Shell | Automated stack health and role-isolation smoke check |

### User Guides

| Document | Language | Description |
| :--- | :---: | :--- |
| [Admin Guide](admin-guide.md) | ZH | Organization setup, roster/source sync, model & channel configuration |
| [Manager Guide](manager-guide.md) | ZH | Capability reviews, team workload forecasting, and cross-team scheduling |
| [Employee Guide](employee-guide.md) | ZH | Self-review, availability windows, and built-in assistant usage |
| [Published Profile Export](profile-export.md) | ZH | CSV/JSON export fields and read-only profile export behavior |

### Development & Architecture

| Document | Language | Description |
| :--- | :---: | :--- |
| [Contributing Guide](../CONTRIBUTING.md) | EN | Contribution workflow, coding standards, local checks, and licensing |
| [Development Guide](development.md) | EN / ZH | Local dev servers, PostgreSQL setup, and test commands |
| [Architecture & Extension Boundaries](architecture.md) | ZH | Permission boundaries, service responsibilities, and data flow |
| [Extending OrgPace](extending.md) | ZH | Adding data connectors, chat adapters, and capability templates |
| [Architecture Decision Records](adr/README.md) | ZH | Historical technical decision log |

### Security & Governance

| Document | Language | Description |
| :--- | :---: | :--- |
| [Security Policy](../SECURITY.md) | EN | Self-hosted security boundaries and private vulnerability reporting |
| [Code of Conduct](../CODE_OF_CONDUCT.md) | EN | Contributor Covenant v2.1 |
| [Third-Party Licenses](licenses.md) | ZH | Dependency license audit and Apache-2.0 / MIT compliance notes |
