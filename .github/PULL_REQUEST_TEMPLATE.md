## Summary

<!-- Describe what this PR changes and why. -->

- Related Issue: #

## Scope & Impact

- [ ] Changes stay focused on a single issue/goal without unrelated refactoring.
- [ ] Only synthetic demo/test data is included (no real employee data, internal docs, or secrets).
- [ ] Tenant isolation (`org_id`) and server-side permission checks are preserved.
- [ ] Evidence remains append-only (corrections add superseding/retraction records instead of mutating history).
- [ ] Database schema changes include reversible Alembic migrations (`upgrade` / `downgrade`, single head).
- [ ] Frontend API client is regenerated from OpenAPI if backend schemas/routes changed.
- [ ] Any new dependencies are listed below with their exact versions and Apache-2.0-compatible licenses.

## Verification

<!-- List the commands and test suites you ran locally and their results. -->

- Backend lint & type checks:
- Frontend lint, typecheck & build:
- Tests:
