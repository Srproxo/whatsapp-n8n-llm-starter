# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-10-25

### Added
- n8n workflow `whatsapp-llm-assistant.json`: Meta webhook verification, message intake with deduplication, short-term memory per number, OpenAI-compatible LLM call, human handoff, WhatsApp Cloud API reply and exchange log.
- Separate `error-handler.json` workflow (Error Trigger) with optional email / Telegram alerts.
- `docker-compose.yml` and `.env.example` to run n8n locally.
- Example Meta payloads and `scripts/simulate.sh` to test without a real WhatsApp number.
- Offline tests (`npm test`) and a GitHub Actions workflow.
- Documentation: Meta setup, customization, architecture.
