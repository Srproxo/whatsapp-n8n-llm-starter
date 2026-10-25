# Changelog

All notable changes to this project are documented here.

## [0.2.0] - 2026-10-25

First version run on a real n8n (2.44.6) instead of only offline.

### Added
- `X-Hub-Signature-256` verification: HMAC-SHA256 of the raw body with `WA_APP_SECRET`, constant-time compare, `401` on mismatch, fail closed when live without a secret. Compose enables `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.
- Bot pause after a human handoff (`HANDOFF_PAUSE_MINUTES`, default 60): later messages from that number are logged, not answered.
- `scripts/mock-llm.mjs` and `scripts/mock-whatsapp.mjs`: local, deterministic stand-ins for an OpenAI-compatible API and the Cloud API send endpoint.
- `WA_GRAPH_BASE_URL` (replaces `WA_GRAPH_VERSION`) so the send node can target the mock.
- `test/e2e.mjs` (`npm run test:e2e`): imports and publishes both workflows into n8n 2.44.6 and checks 16 scenarios over HTTP against the mocks. New CI job `e2e`.
- `scripts/simulate.sh` signs its requests like Meta.
- Screenshot of the workflow in the n8n editor (`docs/workflow.png`).

### Changed
- n8n pinned to 2.44.6 in `docker-compose.yml` and `.env.example` (was `latest`).
- `WEBHOOK_URL` renamed to `N8N_WEBHOOK_URL` (the old name is deprecated in n8n 2.x).
- The POST webhook answers from *Respond 200* / *Respond 401* after the signature check instead of "on received".
- Both workflows carry fixed ids and the main one presets its error workflow, so a CLI import needs no manual wiring.
- Main workflow laid out in two rows.

### Fixed
- Importing both workflows with one `n8n import:workflow --separate` call failed (`UNIQUE constraint failed: tag_entity.name`): both declared the same tag.

### Known limitations
- Static data is last-write-wins: overlapping executions lose each other's memory, dedupe, pause and log updates (measured in the e2e test, documented in `docs/architecture.md`).

## [0.1.0] - 2026-10-25

### Added
- n8n workflow `whatsapp-llm-assistant.json`: Meta webhook verification, message intake with deduplication, short-term memory per number, OpenAI-compatible LLM call, human handoff, WhatsApp Cloud API reply and exchange log.
- Separate `error-handler.json` workflow (Error Trigger) with optional email / Telegram alerts.
- `docker-compose.yml` and `.env.example` to run n8n locally.
- Example Meta payloads and `scripts/simulate.sh` to test without a real WhatsApp number.
- Offline tests (`npm test`) and a GitHub Actions workflow.
- Documentation: Meta setup, customization, architecture.
