# Setting up WhatsApp Cloud API (Meta)

This guide takes you from nothing to a webhook that Meta calls on your n8n. Meta's console changes names and layout from time to time; if a label differs, follow the same idea and check Meta's current documentation.

## 0. What you need

- A Facebook account and a Meta business portfolio (Business Manager).
- n8n reachable over **HTTPS** from the internet (Meta refuses plain HTTP). While developing, use a tunnel.
- A phone that can receive WhatsApp messages (your own, as a test recipient).

## 1. Create the app

1. Go to <https://developers.facebook.com/apps> and choose **Create app**.
2. Pick the use case / type **Business** (the one that offers WhatsApp) and attach your business portfolio.
3. In the app dashboard, add the **WhatsApp** product.

## 2. Use the test number

On **WhatsApp > API Setup** Meta gives you, at no setup cost:

- a **test phone number** (the "From" number),
- its **Phone number ID** -> `WA_PHONE_NUMBER_ID`,
- a **temporary access token**, valid about 24 hours -> `WA_ACCESS_TOKEN` (for first tests only),
- a list of **recipient numbers**: add your own phone and confirm it with the code WhatsApp sends. The test number can only message numbers on this list.

Send the sample "hello world" template from that page once to open a conversation window with your phone.

Also copy the **App secret** (**App settings > Basic > App secret > Show**) into `WA_APP_SECRET`. The workflow uses it to check the `X-Hub-Signature-256` header Meta adds to every webhook POST; with `WA_DRY_RUN=false` and no secret, every POST is refused.

## 3. Run n8n and import the workflows

```bash
cp .env.example .env        # fill WA_*, LLM_*, N8N_ENCRYPTION_KEY
docker compose up -d
docker compose exec n8n n8n import:workflow --separate --input=/workflows
docker compose exec n8n n8n publish:workflow --id=waLlmAssistErrH1
docker compose exec n8n n8n publish:workflow --id=waLlmAssistMain1
docker compose restart n8n
```

The CLI keeps the workflow ids, so the main workflow's error workflow is already set. Open <http://localhost:5678> and create the owner account to see the workflows and their executions.

If you prefer the editor: **Workflows > Import from file**, first `workflows/error-handler.json`, then `workflows/whatsapp-llm-assistant.json`; in the main workflow set **Settings > Error workflow** to *WhatsApp LLM Assistant - Error Handler*, and **Publish** both. Meta can only reach the **production** URL, which exists while the workflow is published.

Quick check without Meta (point `LLM_BASE_URL` and `WA_GRAPH_BASE_URL` at the mocks as in the README quick start, or keep `WA_DRY_RUN=true`):

```bash
scripts/simulate.sh all     # signs each POST with WA_APP_SECRET, like Meta
```

and look at the **Executions** tab of n8n.

## 4. Expose n8n over HTTPS

Pick one:

- **Cloudflare quick tunnel**: `cloudflared tunnel --url http://localhost:5678` prints an `https://<random>.trycloudflare.com` address that changes every run.
- **ngrok**: `ngrok http 5678`.
- **A server with a domain** and a reverse proxy (Caddy, Traefik, nginx) with a TLS certificate. Recommended for anything permanent.

Then set `N8N_WEBHOOK_URL` in `.env` to that public address **with a trailing slash** (example: `https://assistant.example.com/`) and run `docker compose up -d` again. n8n builds the webhook URLs from this value; without it the editor shows `localhost` URLs.

## 5. Register the webhook in Meta

1. **WhatsApp > Configuration > Webhook > Edit**.
2. **Callback URL**: `https://<your-public-address>/webhook/whatsapp`
3. **Verify token**: the exact value of `WA_VERIFY_TOKEN` in your `.env`.
4. **Verify and save**. Meta sends the GET request; the workflow answers with the challenge only if the token matches. If it fails, check that the workflow is published, that the URL ends in `/webhook/whatsapp` (not `/webhook-test/`) and that n8n received the variable (restart the container after editing `.env`).
5. Under **Webhook fields** click **Manage** and **subscribe to `messages`**. Without this subscription Meta verifies the URL but never sends customer messages.

## 6. First real test

Set `WA_DRY_RUN=false`, `WA_GRAPH_BASE_URL=https://graph.facebook.com/v21.0` and `WA_APP_SECRET` in `.env`, restart (`docker compose up -d`), and write to the test number from your phone. You should get the assistant's reply within a few seconds and see the execution in n8n.

Notes:

- Free-form replies are only allowed within **24 hours of the customer's last message** (the "customer service window"). To write first or after 24 h you need an approved message template.
- The test number and temporary token are for development. Messages from numbers that are not in the recipient list will not arrive.

## 7. Permanent token (System User)

The 24-hour token expires; the assistant would stop answering. For anything lasting:

1. Open <https://business.facebook.com/settings> (Business settings) for your portfolio.
2. **Users > System users > Add**. Create one with the **Admin** role.
3. **Add assets**: give it **full control** over your app and over your WhatsApp account.
4. **Generate new token**: select your app, set expiration to **Never**, and tick the permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
5. Copy the token once into `WA_ACCESS_TOKEN` in `.env`. Treat it like a password and never commit it.

## 8. Going live with a real number

- Add your own business phone number in **WhatsApp > API Setup** (it cannot be registered in the regular WhatsApp app at the same time).
- Complete **business verification** if Meta asks for it, set the display name, and add a payment method: sending business-initiated messages is billed by Meta according to its current pricing, shown in your WhatsApp Manager.
- Switch the app to **Live** mode.
- Update `WA_PHONE_NUMBER_ID` to the new number's ID.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "The callback URL or verify token couldn't be validated" | Workflow not published, wrong path, token mismatch, or n8n not reachable from the internet. |
| Meta shows failed deliveries; executions end at *Respond 401* | `WA_APP_SECRET` missing or not the app secret of the app that owns the webhook. |
| Verified, but no messages arrive | Not subscribed to `messages`, or your phone is not in the recipient list. |
| Execution fails at *Send WhatsApp Reply* with 401 / code 190 | Expired or wrong `WA_ACCESS_TOKEN`. |
| Fails with code 131047 | Outside the 24-hour window: a template is required. |
| Fails at *Call LLM* | Check `LLM_BASE_URL` (must end in `/v1` or equivalent, not `/chat/completions`), the key and the model name. |
| Expressions show `$env` access errors | `N8N_BLOCK_ENV_ACCESS_IN_NODE` must be `false` (the compose file sets it). |
| *Verify Signature* fails with "Cannot find module 'crypto'" | `NODE_FUNCTION_ALLOW_BUILTIN=crypto` is missing (the compose file sets it). |
