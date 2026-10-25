#!/usr/bin/env node
// End-to-end test: a real n8n instance runs both workflows against local mocks
// of the LLM API and of the WhatsApp Cloud API. Only localhost is contacted,
// no API key is needed and nothing is paid for.
//
//   npm run test:e2e
//
// Env:
//   N8N_BIN      path to an installed n8n binary (default: npx --yes n8n@N8N_VERSION)
//   N8N_VERSION  n8n version for npx (default: the one pinned in docker-compose.yml)
//   E2E_KEEP=1   keep the temporary n8n folder and print its path
//
// Needs Node >= 22.5 (node:sqlite reads n8n's execution list and static data).
import { spawn, execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const PINNED = (COMPOSE.match(/N8N_VERSION:-([0-9][^}]*)\}/) || [])[1];
const N8N_VERSION = process.env.N8N_VERSION || PINNED;
const MAIN_ID = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/whatsapp-llm-assistant.json'), 'utf8')).id;
const ERR_ID = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/error-handler.json'), 'utf8')).id;

const VERIFY_TOKEN = 'e2e-verify-token';
const APP_SECRET = 'e2e-app-secret';
const WA_TOKEN = 'e2e-access-token';
const LLM_KEY = 'e2e-llm-key';
const PHONE_ID = '106540352242922';
const FAIL_TO = '15550000003'; // the WhatsApp mock rejects sends to this number

const children = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-n8n-e2e-'));
const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(what, fn, timeoutMs = 30000, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

function start(name, cmd, args, env) {
  const out = fs.openSync(path.join(tmp, `${name}.log`), 'a');
  const child = spawn(cmd, args, { env, stdio: ['ignore', out, out], detached: process.platform !== 'win32' });
  children.push({ name, child });
  return child;
}

function n8nCommand(args) {
  return process.env.N8N_BIN ? [process.env.N8N_BIN, args] : ['npx', ['--yes', `n8n@${N8N_VERSION}`, ...args]];
}

function n8nCli(args, env) {
  const [cmd, full] = n8nCommand(args);
  return new Promise((resolve, reject) => {
    execFile(cmd, full, { env, maxBuffer: 16 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`n8n ${args.join(' ')} failed:\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

function stopAll() {
  for (const { child } of children.reverse()) {
    if (child.exitCode !== null) continue;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

function tail(name, lines = 40) {
  const file = path.join(tmp, `${name}.log`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n') : '';
}

// ------------------------------------------------------------------ setup
const [n8nPort, brokerPort, llmPort, waPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
const BASE = `http://127.0.0.1:${n8nPort}`;
const LLM = `http://127.0.0.1:${llmPort}`;
const WA = `http://127.0.0.1:${waPort}`;

const env = {
  ...process.env,
  N8N_USER_FOLDER: tmp,
  N8N_ENCRYPTION_KEY: 'e2e-encryption-key-not-a-secret',
  N8N_PORT: String(n8nPort),
  N8N_LISTEN_ADDRESS: '127.0.0.1',
  N8N_RUNNERS_BROKER_PORT: String(brokerPort),
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_SECURE_COOKIE: 'false',
  // the same two settings docker-compose.yml applies
  N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false',
  NODE_FUNCTION_ALLOW_BUILTIN: 'crypto',
  WA_VERIFY_TOKEN: VERIFY_TOKEN,
  WA_APP_SECRET: APP_SECRET,
  WA_PHONE_NUMBER_ID: PHONE_ID,
  WA_ACCESS_TOKEN: WA_TOKEN,
  WA_GRAPH_BASE_URL: `${WA}/v21.0`,
  WA_DRY_RUN: 'false',
  LLM_BASE_URL: `${LLM}/v1`,
  LLM_API_KEY: LLM_KEY,
  LLM_MODEL: 'mock-model',
  MEMORY_MESSAGES: '10',
  HANDOFF_PAUSE_MINUTES: '60',
};

process.on('exit', () => {
  stopAll();
  if (process.env.E2E_KEEP) console.log(`[e2e] kept ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push([true, name]);
    log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push([false, name]);
    log(`FAIL ${name}\n${err.stack || err}`);
  }
}

// ------------------------------------------------------------------ helpers
const getJson = async (url, init) => (await fetch(url, init)).json();
const waMessages = () => getJson(`${WA}/__messages`);
const llmRequests = () => getJson(`${LLM}/__requests`);

function sign(raw, secret = APP_SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
}

function fixture(name, patch = {}) {
  const body = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures', `${name}.json`), 'utf8'));
  const value = body.entry[0].changes[0].value;
  if (value.messages && Object.keys(patch).length) {
    const m = value.messages[0];
    if (patch.from) {
      m.from = patch.from;
      value.contacts[0].wa_id = patch.from;
    }
    if (patch.id) m.id = patch.id;
    if (patch.text !== undefined) m.text = { body: patch.text };
  }
  return body;
}

async function post(body, { signature = 'valid' } = {}) {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'content-type': 'application/json' };
  if (signature === 'valid') headers['x-hub-signature-256'] = sign(raw);
  if (signature === 'wrong') headers['x-hub-signature-256'] = sign(raw, 'not-the-app-secret');
  const res = await fetch(`${BASE}/webhook/whatsapp`, { method: 'POST', headers, body: raw });
  return { status: res.status, text: await res.text() };
}

let db;
async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(tmp, '.n8n', 'database.sqlite'), { readOnly: true });
}
const executions = (workflowId = MAIN_ID) =>
  db.prepare('SELECT id, status FROM execution_entity WHERE workflowId = ? ORDER BY id').all(workflowId);
const staticData = () => {
  const row = db.prepare('SELECT staticData FROM workflow_entity WHERE id = ?').get(MAIN_ID);
  return (row && row.staticData && JSON.parse(row.staticData).global) || {};
};
const DONE = new Set(['success', 'error', 'crashed', 'canceled']);

/** Run fn (which triggers executions) and wait until `count` new ones have finished. */
async function settled(fn, count = 1, workflowId = MAIN_ID, timeoutMs = 30000) {
  const before = executions(workflowId).length;
  const out = await fn();
  await waitFor(`${count} execution(s) of ${workflowId} to finish`, () => {
    const list = executions(workflowId);
    return list.length >= before + count && list.every((e) => DONE.has(e.status)) ? list : null;
  }, timeoutMs);
  return out;
}

const repliesTo = async (to) => (await waMessages()).filter((m) => m.to === to);

// ------------------------------------------------------------------ run
log(`n8n ${process.env.N8N_BIN ? `(${process.env.N8N_BIN})` : N8N_VERSION} in ${tmp}`);
start('mock-llm', process.execPath, [path.join(ROOT, 'scripts/mock-llm.mjs')], {
  ...process.env, PORT: String(llmPort), MOCK_LLM_API_KEY: LLM_KEY, MOCK_LLM_DELAY_MS: '300',
});
start('mock-whatsapp', process.execPath, [path.join(ROOT, 'scripts/mock-whatsapp.mjs')], {
  ...process.env, PORT: String(waPort), MOCK_WA_TOKEN: WA_TOKEN, MOCK_WA_FAIL_TO: FAIL_TO,
});
await waitFor('mocks', async () => (await fetch(`${LLM}/health`)).ok && (await fetch(`${WA}/health`)).ok, 10000);

try {
  log('importing and publishing workflows');
  for (const file of ['workflows/error-handler.json', 'workflows/whatsapp-llm-assistant.json']) {
    await n8nCli(['import:workflow', `--input=${path.join(ROOT, file)}`], env);
  }
  for (const id of [ERR_ID, MAIN_ID]) await n8nCli(['publish:workflow', `--id=${id}`], env);

  log('starting n8n');
  start('n8n', ...n8nCommand(['start']), env);
  await waitFor('n8n /healthz', async () => (await fetch(`${BASE}/healthz`)).ok, 180000, 500);
  await waitFor('production webhook', async () => (await fetch(`${BASE}/webhook/whatsapp`)).status !== 404, 60000, 500);
  await openDb();
} catch (err) {
  console.error(err.message, '\n--- n8n log ---\n', tail('n8n'));
  process.exit(1);
}

await step('GET verification: right token echoes hub.challenge', async () => {
  const res = await fetch(`${BASE}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '1158201444');
});

await step('GET verification: wrong token gets 403', async () => {
  const res = await fetch(`${BASE}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1158201444`);
  assert.equal(res.status, 403);
});

await step('POST with a wrong or missing X-Hub-Signature-256 gets 401 and is not processed', async () => {
  const body = fixture('text-message', { id: 'wamid.E2E.BADSIG' });
  const wrong = await settled(() => post(body, { signature: 'wrong' }));
  assert.equal(wrong.status, 401);
  const missing = await settled(() => post(body, { signature: 'none' }));
  assert.equal(missing.status, 401);
  assert.equal((await llmRequests()).length, 0, 'no LLM call');
  assert.equal((await waMessages()).length, 0, 'no WhatsApp message');
  assert.ok(!(staticData().seen || {})['wamid.E2E.BADSIG'], 'not even deduplicated');
});

await step('delivery status update: 200, no LLM call, no reply', async () => {
  const res = await settled(() => post(fixture('status-update')));
  assert.equal(res.status, 200);
  assert.equal((await llmRequests()).length, 0);
  assert.equal((await waMessages()).length, 0);
});

const ALEX = '15557654321';
await step('text message: LLM answer is sent through the Cloud API', async () => {
  const res = await settled(() => post(fixture('text-message')));
  assert.equal(res.status, 200);
  const [sent, ...more] = await repliesTo(ALEX);
  assert.equal(more.length, 0);
  assert.equal(sent.text, 'Mock answer: Hola! ¿A qué hora abren el sábado y cuánto sale una docena de galletas?');
  assert.equal(sent.phoneNumberId, PHONE_ID);
  assert.equal(sent.body.messaging_product, 'whatsapp');
  const [req] = await llmRequests();
  assert.equal(req.authorization, `Bearer ${LLM_KEY}`);
  assert.equal(req.body.model, 'mock-model');
  assert.equal(req.body.messages[0].role, 'system');
  assert.match(req.body.messages[0].content, /Sunrise Bakery/);
  assert.equal(req.body.messages.length, 2);
});

await step('duplicate delivery of the same message id: no second reply', async () => {
  const res = await settled(() => post(fixture('text-message')));
  assert.equal(res.status, 200);
  assert.equal((await repliesTo(ALEX)).length, 1);
  assert.equal((await llmRequests()).length, 1);
});

await step('follow-up message: the previous exchange is sent as memory', async () => {
  await settled(() => post(fixture('text-message', { id: 'wamid.E2E.FOLLOWUP', text: 'And on Sunday?' })));
  const replies = await repliesTo(ALEX);
  assert.equal(replies.length, 2);
  assert.equal(replies[1].text, 'Mock answer: And on Sunday?');
  const req = (await llmRequests()).at(-1);
  assert.deepEqual(req.body.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(req.body.messages[2].content, /^Mock answer: Hola!/);
});

await step('image message: polite "text only" notice, no LLM call', async () => {
  const before = (await llmRequests()).length;
  await settled(() => post(fixture('image-message')));
  const last = (await repliesTo(ALEX)).at(-1);
  assert.match(last.text, /only read text messages/);
  assert.equal((await llmRequests()).length, before);
});

await step('scripts/simulate.sh: signed requests are accepted', async () => {
  const run = (cmd) => new Promise((resolve, reject) => {
    execFile('bash', [path.join(ROOT, 'scripts/simulate.sh'), cmd], {
      env: { ...process.env, BASE_URL: BASE, WA_VERIFY_TOKEN: VERIFY_TOKEN, WA_APP_SECRET: APP_SECRET },
    }, (err, stdout, stderr) => (err ? reject(err) : resolve(stdout + stderr)));
  });
  assert.match(await run('verify'), /<< HTTP 200/);
  const before = (await repliesTo(ALEX)).length;
  const out = await settled(() => run('text'));
  assert.match(out, /<< HTTP 200/);
  assert.equal((await repliesTo(ALEX)).length, before + 1);
});

const SAM = '15558889999';
await step('customer asks for a person: handoff reply without LLM call, chat paused', async () => {
  const before = (await llmRequests()).length;
  await settled(() => post(fixture('human-request')));
  const [sent] = await repliesTo(SAM);
  assert.equal(sent.text, 'Thanks for your message. A member of our team will contact you shortly.');
  assert.equal((await llmRequests()).length, before);
  assert.ok(staticData().paused[SAM] > Date.now() + 59 * 60 * 1000, 'paused for about 60 minutes');
});

await step('paused chat: the bot stays silent and logs the message', async () => {
  const before = (await llmRequests()).length;
  await settled(() => post(fixture('human-request', { id: 'wamid.E2E.PAUSED', text: 'Hello? What time do you open?' })));
  assert.equal((await repliesTo(SAM)).length, 1, 'no new reply');
  assert.equal((await llmRequests()).length, before, 'no LLM call');
  const entry = staticData().log.at(-1);
  assert.equal(entry.kind, 'paused');
  assert.equal(entry.inbound, 'Hello? What time do you open?');
});

await step('LLM answers with [[HANDOFF]]: customer gets the model\'s sentence, chat paused', async () => {
  const to = '15550000001';
  await settled(() => post(fixture('text-message', { from: to, id: 'wamid.E2E.MARKER', text: 'Is there a human I could ask about a wedding cake?' })));
  const [sent] = await repliesTo(to);
  assert.equal(sent.text, 'A person from our team will contact you soon.');
  assert.ok(staticData().paused[to] > Date.now());
});

await step('LLM keeps failing: 3 attempts, then the handoff fallback reply', async () => {
  const to = '15550000002';
  const before = (await llmRequests()).length;
  await settled(() => post(fixture('text-message', { from: to, id: 'wamid.E2E.LLMFAIL', text: 'MOCK_LLM_FAIL what are your prices?' })));
  assert.equal((await llmRequests()).length - before, 3);
  const [sent] = await repliesTo(to);
  assert.equal(sent.text, 'Thanks for your message. A member of our team will contact you shortly.');
  const entry = staticData().log.at(-1);
  assert.deepEqual([entry.kind, entry.handoffReason], ['handoff', 'llm_error']);
});

await step('WhatsApp send fails for good: execution errors and the error workflow runs', async () => {
  const errorRunsBefore = executions(ERR_ID).length;
  await settled(() => post(fixture('text-message', { from: FAIL_TO, id: 'wamid.E2E.SENDFAIL', text: 'Do you sell bread?' })));
  assert.equal(executions().at(-1).status, 'error');
  const runs = await waitFor('error workflow execution', () => {
    const list = executions(ERR_ID);
    return list.length > errorRunsBefore && list.every((e) => DONE.has(e.status)) ? list : null;
  });
  assert.equal(runs.at(-1).status, 'success');
});

await step('burst of messages arriving together: every one gets its reply', async () => {
  const numbers = ['15550000011', '15550000012', '15550000013', '15550000014'];
  await settled(() => Promise.all(numbers.map((from, i) =>
    post(fixture('text-message', { from, id: `wamid.E2E.BURST${i}`, text: `Burst question ${i}` })))), numbers.length);
  for (const [i, n] of numbers.entries()) assert.equal((await repliesTo(n))[0].text, `Mock answer: Burst question ${i}`);
  // Known limit, not asserted: static data is saved whole at the end of each
  // execution (last write wins), so overlapping executions lose each other's
  // memory / dedupe / log updates. See docs/architecture.md.
  const state = staticData();
  const kept = numbers.filter((n) => (state.memory[n] || []).length === 2).length;
  log(`     note: memory kept for ${kept}/${numbers.length} overlapping executions (static data is last-write-wins)`);
});

await step('every other execution of the main workflow succeeded', async () => {
  const failed = executions().filter((e) => e.status !== 'success');
  assert.equal(failed.length, 1, `unexpected failures: ${JSON.stringify(failed)}`);
});

const bad = results.filter(([ok]) => !ok);
log(`${results.length - bad.length}/${results.length} passed`);
if (bad.length) {
  console.log('--- n8n log (tail) ---\n' + tail('n8n', 60));
  process.exitCode = 1;
}
process.exit();
