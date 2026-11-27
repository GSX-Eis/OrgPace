# Security Policy

## Supported Versions

Security updates are applied to the latest release on the `master` branch (`0.1.x`).

| Version | Supported |
| :--- | :--- |
| `0.1.x` (`master`) | ✅ Yes |
| `< 0.1.0` | ❌ No |

## Self-Hosted Deployment Boundaries

OrgPace is designed for self-hosted deployment within your own infrastructure. When operating an instance:

- **Never use `.env.example` or `FASTAPI_ENV=development` in production.** Default example values (`changethis`, `demo-password-2026`) and development endpoints are strictly for isolated local evaluation. Use `./install.sh` to generate cryptographically random secrets (`SECRET_KEY`, `POSTGRES_PASSWORD`, internal service tokens) with `0600` file permissions.
- **Serve over HTTPS on untrusted networks.** Enable TLS via `./install.sh` (Let's Encrypt or managed reverse proxy) and avoid exposing database ports publicly.
- **Protect third-party credentials.** Jira tokens, AI model API keys, and IM app secrets are encrypted at rest and never returned in API responses or logs. Restrict outbound egress where appropriate if connecting to external LLM or IM providers.
- **Keep synthetic data separate.** Never commit real employee profiles, internal company records, chat transcripts, or credentials to issues, pull requests, or repository files.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or Discussions.**

If you discover a security issue in OrgPace, please report it privately using **GitHub Private Vulnerability Reporting**:

1. Open the repository **Security** tab: <https://github.com/GSX-Eis/OrgPace/security/advisories/new>
2. Provide a clear description of the vulnerability, affected components, reproduction steps, and potential impact.
3. Do not include live credentials or real organizational data in your report.

### What to Expect

- **Acknowledgment:** Maintainers aim to acknowledge private reports within **72 hours**.
- **Assessment & Fix:** We will work with you to validate the issue, assess severity, and prepare a fix or mitigation.
- **Coordinated Disclosure:** Once a patch is ready and released, we will coordinate disclosure timing and credit reporters who wish to be acknowledged.
