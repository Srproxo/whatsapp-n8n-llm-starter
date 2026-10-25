'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadJson } = require('./helpers/harness');

const FILES = ['workflows/whatsapp-llm-assistant.json', 'workflows/error-handler.json'];
const STICKY = 'n8n-nodes-base.stickyNote';
const TRIGGERS = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.errorTrigger']);

function edges(wf) {
  const out = [];
  for (const [from, v] of Object.entries(wf.connections)) {
    for (const branch of v.main || []) for (const t of branch) out.push([from, t.node]);
  }
  return out;
}

for (const file of FILES) {
  const wf = loadJson(file);
  const names = wf.nodes.map((n) => n.name);

  test(`${file}: valid structure`, () => {
    assert.equal(typeof wf.name, 'string');
    assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0);
    assert.equal(wf.active, false, 'ships inactive');
    assert.equal(wf.settings.executionOrder, 'v1');
    for (const n of wf.nodes) {
      assert.ok(n.id && n.name && n.type && n.typeVersion, `node ${n.name} misses basic fields`);
      assert.ok(Array.isArray(n.position) && n.position.length === 2, `${n.name} position`);
    }
  });

  test(`${file}: unique node names and ids`, () => {
    assert.equal(new Set(names).size, names.length);
    const ids = wf.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test(`${file}: every connection points to existing nodes`, () => {
    for (const [from, to] of edges(wf)) {
      assert.ok(names.includes(from), `unknown source: ${from}`);
      assert.ok(names.includes(to), `unknown target: ${to}`);
    }
  });

  test(`${file}: no orphan nodes (sticky notes excepted) and everything reachable from a trigger`, () => {
    const real = wf.nodes.filter((n) => n.type !== STICKY);
    const triggers = real.filter((n) => TRIGGERS.has(n.type)).map((n) => n.name);
    assert.ok(triggers.length > 0, 'no trigger');
    const seen = new Set(triggers);
    const queue = [...triggers];
    const e = edges(wf);
    while (queue.length) {
      const cur = queue.pop();
      for (const [f, t] of e) if (f === cur && !seen.has(t)) { seen.add(t); queue.push(t); }
    }
    for (const n of real) assert.ok(seen.has(n.name), `unreachable or orphan: ${n.name}`);
  });

  test(`${file}: Code nodes compile`, () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new AsyncFunction('$input', '$json', '$env', '$getWorkflowStaticData', '$', n.parameters.jsCode), n.name);
    }
  });

  test(`${file}: HTTP Request nodes retry 3 times`, () => {
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
      assert.equal(n.retryOnFail, true, `${n.name} retryOnFail`);
      assert.equal(n.maxTries, 3, `${n.name} maxTries`);
      assert.ok(n.waitBetweenTries >= 500, `${n.name} waitBetweenTries`);
    }
  });

  test(`${file}: owner notifications are disabled by default`, () => {
    const notify = wf.nodes.filter((n) => n.name.startsWith('Notify Owner'));
    assert.ok(notify.length >= 1);
    for (const n of notify) assert.equal(n.disabled, true, n.name);
  });

  test(`${file}: credentials are referenced by placeholder name only`, () => {
    for (const n of wf.nodes.filter((x) => x.credentials)) {
      for (const cred of Object.values(n.credentials)) {
        assert.equal(cred.id, 'REPLACE_ME');
        assert.match(cred.name, /\(example\)$/);
      }
    }
  });

  test(`${file}: no value looks like a real secret`, () => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const patterns = {
      'Meta token': /EAA[A-Za-z0-9]{20,}/,
      'OpenAI/Anthropic key': /\bsk-[A-Za-z0-9_-]{16,}/,
      'Groq key': /\bgsk_[A-Za-z0-9]{16,}/,
      'OpenRouter key': /sk-or-[A-Za-z0-9-]{16,}/,
      'Telegram bot token': /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/,
      'hardcoded bearer': /Bearer\s+[A-Za-z0-9._-]{20,}/,
      'Google API key': /AIza[0-9A-Za-z_-]{30,}/,
    };
    for (const [label, re] of Object.entries(patterns)) assert.doesNotMatch(text, re, label);
    // long opaque strings (hex / base64) in plain parameter values
    const walk = (v, p) => {
      if (typeof v === 'string' && !v.startsWith('=') && /^[A-Za-z0-9+/_-]{32,}$/.test(v) && !/^[a-f0-9-]{36}$/.test(v)) {
        assert.fail(`opaque string at ${p}`);
      }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
    };
    walk(wf.nodes.map((n) => n.parameters), 'parameters');
  });
}

test('main workflow: GET and POST webhooks share the path', () => {
  const wf = loadJson(FILES[0]);
  const hooks = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  assert.deepEqual(hooks.map((h) => h.parameters.httpMethod).sort(), ['GET', 'POST']);
  assert.equal(new Set(hooks.map((h) => h.parameters.path)).size, 1);
  const post = hooks.find((h) => h.parameters.httpMethod === 'POST');
  assert.equal(post.parameters.responseMode, 'onReceived', 'POST must answer 200 right away');
  const get = hooks.find((h) => h.parameters.httpMethod === 'GET');
  assert.equal(get.parameters.responseMode, 'responseNode');
  assert.equal(new Set(hooks.map((h) => h.webhookId)).size, 2);
});

test('main workflow: verification compares the token with WA_VERIFY_TOKEN and answers 403 otherwise', () => {
  const wf = loadJson(FILES[0]);
  const check = wf.nodes.find((n) => n.name === 'Is Verify Token Valid?');
  const text = JSON.stringify(check.parameters);
  assert.match(text, /hub\.verify_token/);
  assert.match(text, /hub\.mode/);
  assert.match(text, /\$env\.WA_VERIFY_TOKEN/);
  assert.match(text, /notEmpty/, 'an empty configured token must never match');
  const ok = wf.nodes.find((n) => n.name === 'Respond Challenge');
  assert.match(ok.parameters.responseBody, /hub\.challenge/);
  const denied = wf.nodes.find((n) => n.name === 'Respond 403');
  assert.equal(denied.parameters.options.responseCode, 403);
  assert.deepEqual(wf.connections['Is Verify Token Valid?'].main.map((b) => b.map((t) => t.node)), [['Respond Challenge'], ['Respond 403']]);
});

test('main workflow: required stages exist', () => {
  const wf = loadJson(FILES[0]);
  const names = wf.nodes.map((n) => n.name);
  for (const n of ['Normalize Payload', 'Deduplicate Messages', 'Business Knowledge Base', 'System Prompt', 'Call LLM (OpenAI-compatible)',
    'Prepare Handoff Reply', 'Send WhatsApp Reply', 'Log Exchange', 'Update Memory', 'Google Sheets: Append Log']) {
    assert.ok(names.includes(n), `missing node: ${n}`);
  }
  assert.ok(wf.nodes.filter((n) => n.type === STICKY).length >= 6, 'sticky notes explain each part');
  const send = wf.nodes.find((n) => n.name === 'Send WhatsApp Reply');
  assert.match(send.parameters.url, /graph\.facebook\.com/);
  assert.match(send.parameters.url, /WA_PHONE_NUMBER_ID/);
  assert.match(JSON.stringify(send.parameters), /WA_ACCESS_TOKEN/);
  const llm = wf.nodes.find((n) => n.name === 'Call LLM (OpenAI-compatible)');
  assert.match(llm.parameters.url, /LLM_BASE_URL.*\/chat\/completions/);
  assert.match(llm.parameters.jsonBody, /LLM_MODEL/);
  assert.equal(llm.onError, 'continueErrorOutput', 'LLM failure must have its own output');
  assert.equal(wf.connections['Call LLM (OpenAI-compatible)'].main.length, 2);
});

test('main workflow: status updates stop the flow (Normalize emits nothing) and the unsupported branch exists', () => {
  const wf = loadJson(FILES[0]);
  assert.deepEqual(wf.connections['Is Text Message?'].main.map((b) => b.map((t) => t.node)), [['Detect Handoff Keywords'], ['Prepare Unsupported Reply']]);
});

test('error handler: Error Trigger feeds a formatter', () => {
  const wf = loadJson(FILES[1]);
  assert.ok(wf.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger'));
  assert.deepEqual(wf.connections['Error Trigger'].main[0].map((t) => t.node), ['Format Error Message']);
});

test('every $env variable used in the workflows is documented in .env.example', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const documented = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const used = new Set();
  for (const file of FILES) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/\$env\.([A-Z][A-Z0-9_]*)/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 8);
  for (const v of used) assert.ok(documented.has(v), `${v} is used but missing from .env.example`);
});

test('docker-compose.yml: required variables exist in .env.example and secrets are not inlined', () => {
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(compose, /^services:\n {2}n8n:/m);
  assert.match(compose, /N8N_BLOCK_ENV_ACCESS_IN_NODE: "false"/);
  assert.match(compose, /env_file:\n\s+- \.env/);
  for (const m of compose.matchAll(/\$\{([A-Z0-9_]+)[:?-]/g)) {
    assert.match(example, new RegExp(`^${m[1]}=`, 'm'), `${m[1]} not in .env.example`);
  }
  assert.doesNotMatch(compose, /\t/, 'YAML must not contain tabs');
});

test('.env.example only holds placeholders', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.doesNotMatch(example, /EAA[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/);
  for (const key of ['WA_VERIFY_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'OWNER_EMAIL', 'N8N_ENCRYPTION_KEY', 'WEBHOOK_URL']) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), key);
  }
});
