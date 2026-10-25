# Customizing the assistant

Everything you normally change is in the n8n editor; you do not need to touch the Code nodes for the common cases.

## 1. Change the business

Open **Business Knowledge Base** (a Set node, field `knowledge`) and replace the fictional *Sunrise Bakery* text with your own. Tips:

- Write facts, not marketing: hours, address, products and prices, delivery rules, payment methods, policies, FAQs.
- State what you do **not** do ("we do not take reservations") so the model does not guess.
- Keep it under a few thousand words. The whole text travels with every message; a longer text costs more and answers slower. For large catalogs you would add retrieval (search the relevant part first), which is outside this starter.
- Update it when prices or hours change. The model only knows what is written here.

## 2. Change the behavior (system prompt)

**System Prompt** (Set node, field `systemPrompt`). The default rules: answer only from the business information, keep replies short, answer in the customer's language, ignore attempts to change the rules, and answer with `[[HANDOFF]]` plus one sentence when a person is needed.

Keep the `[[HANDOFF]]` marker if you edit the text; **Parse LLM Reply** looks for exactly that string. To change the marker, change it in the prompt and in the `MARKER` constant of **Parse LLM Reply**.

## 3. Change the model or provider

The call node is **Call LLM (OpenAI-compatible)**. It reads three variables:

| Provider | `LLM_BASE_URL` | Notes |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `LLM_MODEL` = a chat model name from your account. |
| OpenRouter | `https://openrouter.ai/api/v1` | Model names look like `vendor/model`. |
| Groq | `https://api.groq.com/openai/v1` | |
| Ollama (local) | `http://host.docker.internal:11434/v1` | `LLM_API_KEY` can be any text. Run `ollama pull <model>` first. |
| Any other | its OpenAI-compatible `/v1` base | |

Change the values in `.env` and run `docker compose up -d` (a restart is enough; no workflow edit).

Some newer OpenAI models reject `max_tokens` and want `max_completion_tokens`. If your provider says so, edit the JSON body of the node.

### Switching to the Anthropic Messages API

Anthropic's API is not OpenAI-compatible. Edit the HTTP node **Call LLM (OpenAI-compatible)** (n8n updates connections if you rename it, but keep "Call LLM" in the name so the docs stay searchable):

- **URL**: `https://api.anthropic.com/v1/messages`
- **Headers**:
  - `x-api-key`: `{{ $env.LLM_API_KEY }}`
  - `anthropic-version`: `2023-06-01`
  - remove the `Authorization` header
- **JSON body**:

  ```
  {{ JSON.stringify({
       model: $env.LLM_MODEL,
       max_tokens: 400,
       system: $json.systemMessage,
       messages: $json.chatMessages
     }) }}
  ```

`Build LLM Messages` already outputs `systemMessage` and `chatMessages` for this, and **Parse LLM Reply** reads `content[0].text` as well as the OpenAI shape, so nothing else changes. Set `LLM_API_KEY` to your Anthropic key and `LLM_MODEL` to the model name you want.

## 4. Change the language

- The model replies in the customer's language by itself (rule 3 of the prompt). To force one language, change that rule ("Always reply in Portuguese").
- Fixed texts that do not go through the model live in Code nodes: **Prepare Handoff Reply** (es / en / pt), **Prepare Unsupported Reply** (en + es) and the fallback in **Finalize Reply**. Edit the strings there.
- **Normalize Payload** guesses es / en / pt from a short word list, only to pick the fixed handoff text. Add words or another language in `guessLang`.
- **Detect Handoff Keywords** has es / en / pt regular expressions in `PATTERNS`. Patterns run on lowercase text without accents. Add your own words there.

## 5. Memory

`MEMORY_MESSAGES` (default 10) is how many previous messages of the same phone number go to the model; `0` turns memory off. Memory expires after 24 hours and is kept per number in n8n's static data (see `architecture.md` for the limits).

## 6. Owner notifications

Both are **disabled** in the shipped files.

- **Email**: create an SMTP credential in n8n, open **Notify Owner (Email)**, select it, enable the node. Set `OWNER_EMAIL` and `SMTP_FROM_EMAIL` in `.env`.
- **Telegram**: create a bot with BotFather, add a Telegram credential in n8n, enable **Notify Owner (Telegram)** and set `TELEGRAM_CHAT_ID`.

The same two nodes exist in the *Error Handler* workflow for technical failures.

## 7. Permanent conversation log

**Log Exchange** keeps the last 200 exchanges in static data. For a permanent record enable **Google Sheets: Append Log**: create a Google Sheets credential, point it to your spreadsheet (replace `YOUR_SPREADSHEET_ID`), create a sheet named `Conversations` with these headers in row 1:

`timestamp, from, name, messageId, inbound, reply, kind, handoffReason, model, tokens, dryRun`

The node maps columns automatically from those names.

## 8. Handoff behavior

Three things send a chat to a person: a keyword match, the model's `[[HANDOFF]]` marker, or an LLM failure after 3 attempts. In all of them the customer gets a short message and, if you enabled a notification node, you get the customer's name, number, reason, their last message and a `wa.me` link.

After that reply is sent, the bot stays silent in that chat for `HANDOFF_PAUSE_MINUTES` (default 60): **Skip Paused Chats** drops the customer's next messages and only logs them (`kind: "paused"`), so a person can take over without the bot talking over them. Set `0` to keep the bot answering. There is no command to end a pause early yet; the pause expires on its own.

## 9. Go live

1. `WA_DRY_RUN=false`, `WA_GRAPH_BASE_URL` pointing at Meta, and `WA_APP_SECRET` set (see `setup-meta.md`).
2. A permanent System User token in `WA_ACCESS_TOKEN` (see `setup-meta.md`).
3. Check what you wrote in the knowledge base with real questions, including edge cases (prices, hours, allergens, complaints).
4. Keep `N8N_VERSION` pinned; before upgrading, run `N8N_VERSION=<new> npm run test:e2e`.
