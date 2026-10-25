'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadJson, runCode, asWebhookItem } = require('./helpers/harness');

const wf = loadJson('workflows/whatsapp-llm-assistant.json');
const errWf = loadJson('workflows/error-handler.json');
const ENV = { MEMORY_MESSAGES: '4', WA_DRY_RUN: 'true' };

const normalize = (fixture) => runCode(wf, 'Normalize Payload', [asWebhookItem(fixture)]);

test('fixtures are valid JSON in Meta\'s webhook shape', () => {
  for (const f of ['text-message', 'human-request', 'image-message', 'status-update']) {
    const body = loadJson(`scripts/fixtures/${f}.json`);
    assert.equal(body.object, 'whatsapp_business_account');
    assert.equal(body.entry[0].changes[0].field, 'messages');
  }
  const verify = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/verify-request.txt'), 'utf8');
  assert.match(verify, /^GET \/webhook\/whatsapp\?hub\.mode=subscribe&hub\.verify_token=__WA_VERIFY_TOKEN__&hub\.challenge=\d+ HTTP\/1\.1/);
});

test('simulate.sh has valid bash syntax and is executable', () => {
  const file = path.join(ROOT, 'scripts/simulate.sh');
  require('node:child_process').execFileSync('bash', ['-n', file]);
  assert.ok(fs.statSync(file).mode & 0o111, 'not executable');
});

test('Normalize Payload: text message', async () => {
  const [m, ...rest] = await normalize('text-message');
  assert.equal(rest.length, 0);
  assert.equal(m.from, '15557654321');
  assert.equal(m.name, 'Alex Example');
  assert.equal(m.type, 'text');
  assert.match(m.text, /abren el sábado/);
  assert.equal(m.messageId, 'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQyQTdGRTAwMDEyMzQ1Njc4OUFCAA==');
  assert.equal(m.timestamp, 1761400000);
  assert.equal(m.phoneNumberId, '106540352242922');
  assert.equal(m.lang, 'es');
});

test('Normalize Payload: language guess', async () => {
  const en = await normalize('human-request');
  assert.equal(en[0].lang, 'en');
});

test('Normalize Payload: status updates produce no items', async () => {
  assert.deepEqual(await normalize('status-update'), []);
});

test('Normalize Payload: image keeps its type and has empty text', async () => {
  const [m] = await normalize('image-message');
  assert.equal(m.type, 'image');
  assert.equal(m.text, '');
});

test('Normalize Payload: interactive replies count as text, reactions are ignored', async () => {
  const body = loadJson('scripts/fixtures/text-message.json');
  const value = body.entry[0].changes[0].value;
  value.messages = [
    { from: '15557654321', id: 'wamid.A1', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Opening hours' } } },
    { from: '15557654321', id: 'wamid.A2', timestamp: '2', type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.A1' } },
    { from: '15557654321', id: 'wamid.A3', timestamp: '3', type: 'text', text: { body: '   ' } },
  ];
  const out = await runCode(wf, 'Normalize Payload', [{ body }]);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].type, out[0].text], ['text', 'Opening hours']);
  assert.equal(out[1].type, 'unsupported');
});

test('Deduplicate Messages: second delivery of the same id is dropped', async () => {
  const staticData = {};
  const items = await normalize('text-message');
  const first = await runCode(wf, 'Deduplicate Messages', items, { staticData });
  const second = await runCode(wf, 'Deduplicate Messages', items, { staticData });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(Object.keys(staticData.seen).length, 1);
});

test('Deduplicate Messages: expires old ids and caps the store', async () => {
  const staticData = { seen: { 'wamid.old': Date.now() - 25 * 3600 * 1000 } };
  for (let i = 0; i < 2000; i++) staticData.seen[`wamid.x${i}`] = Date.now() - 1000 + i % 500;
  const [item] = await normalize('text-message');
  const out = await runCode(wf, 'Deduplicate Messages', [item, { ...item, messageId: 'wamid.other' }], { staticData });
  assert.equal(out.length, 2);
  assert.ok(!('wamid.old' in staticData.seen));
  assert.ok(Object.keys(staticData.seen).length <= 2000);
});

test('Detect Handoff Keywords: person / complaint wording in es, en, pt', async () => {
  const cases = [
    ['Quiero hablar con una persona', true],
    ['Necesito hablar con el dueño', true],
    ['tengo un reclamo por mi pedido', true],
    ['I want to speak with a manager', true],
    ['This is a scam, I want a refund', true],
    ['Quero falar com um atendente', true],
    ['Preciso de um reembolso', true],
    ['¿A qué hora abren el sábado?', false],
    ['How much is a croissant?', false],
    ['Somos 6 personas, ¿hay mesa?', false],
  ];
  for (const [text, expected] of cases) {
    const [r] = await runCode(wf, 'Detect Handoff Keywords', [{ text }]);
    assert.equal(r.handoff, expected, text);
    assert.equal(r.handoffReason, expected ? 'keyword' : null, text);
  }
  const [human] = await normalize('human-request');
  const [r] = await runCode(wf, 'Detect Handoff Keywords', [human]);
  assert.equal(r.handoff, true);
});

const base = { from: '15557654321', name: 'Alex Example', text: 'Opening hours?', messageId: 'wamid.T1', lang: 'en' };

test('Build LLM Messages: system prompt, knowledge, capped history and new question', async () => {
  const now = Date.now();
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, ts: now - 1000 }));
  history.unshift({ role: 'user', content: 'too old', ts: now - 30 * 3600 * 1000 });
  const staticData = { memory: { '15557654321': history, '15550000000': [{ role: 'user', content: 'other number', ts: now }] } };
  const [r] = await runCode(wf, 'Build LLM Messages', [{ ...base, systemPrompt: 'RULES', knowledge: 'FACTS' }], { env: ENV, staticData });
  assert.equal(r.messages[0].role, 'system');
  assert.match(r.messages[0].content, /^RULES\n\n=== BUSINESS INFORMATION ===\nFACTS/);
  assert.match(r.messages[0].content, /Alex Example/);
  assert.equal(r.chatMessages.length, 5, 'MEMORY_MESSAGES=4 plus the new message');
  assert.deepEqual(r.chatMessages.map((m) => m.content), ['m6', 'm7', 'm8', 'm9', 'Opening hours?']);
  assert.ok(!JSON.stringify(r).includes('other number'));
  assert.equal(r.knowledge, undefined);
});

test('Build LLM Messages: MEMORY_MESSAGES=0 disables memory', async () => {
  const staticData = { memory: { '15557654321': [{ role: 'user', content: 'old', ts: Date.now() }] } };
  const [r] = await runCode(wf, 'Build LLM Messages', [{ ...base, systemPrompt: 'R', knowledge: 'K' }], { env: { MEMORY_MESSAGES: '0' }, staticData });
  assert.equal(r.chatMessages.length, 1);
});

test('Business Knowledge Base and System Prompt are ordinary Set nodes with the marker defined', () => {
  const kb = wf.nodes.find((n) => n.name === 'Business Knowledge Base');
  const sp = wf.nodes.find((n) => n.name === 'System Prompt');
  assert.equal(kb.type, 'n8n-nodes-base.set');
  assert.equal(sp.type, 'n8n-nodes-base.set');
  assert.match(kb.parameters.assignments.assignments[0].value, /FICTIONAL/);
  assert.match(sp.parameters.assignments.assignments[0].value, /\[\[HANDOFF\]\]/);
  assert.equal(kb.parameters.includeOtherFields, true);
});

const llmCtx = { ...base, systemMessage: 's', chatMessages: [], messages: [] };
const parse = (response) => runCode(wf, 'Parse LLM Reply', [response], { refs: { 'Build LLM Messages': [llmCtx] } });

test('Parse LLM Reply: OpenAI-compatible response', async () => {
  const [r] = await parse({ model: 'm', choices: [{ message: { role: 'assistant', content: 'We open at 7:00.' } }], usage: { total_tokens: 321 } });
  assert.equal(r.reply, 'We open at 7:00.');
  assert.equal(r.handoff, false);
  assert.equal(r.kind, 'bot');
  assert.equal(r.tokens, 321);
  assert.equal(r.messages, undefined, 'heavy fields are dropped');
});

test('Parse LLM Reply: Anthropic Messages response', async () => {
  const [r] = await parse({ model: 'm', content: [{ type: 'text', text: 'Hola, abrimos a las 7.' }], usage: { input_tokens: 10, output_tokens: 5 } });
  assert.equal(r.reply, 'Hola, abrimos a las 7.');
  assert.equal(r.tokens, 15);
});

test('Parse LLM Reply: [[HANDOFF]] marker triggers handoff and keeps the sentence', async () => {
  const [r] = await parse({ choices: [{ message: { content: '[[HANDOFF]] Una persona te contactará pronto.' } }] });
  assert.equal(r.handoff, true);
  assert.equal(r.handoffReason, 'llm_marker');
  assert.equal(r.kind, 'handoff');
  assert.equal(r.reply, 'Una persona te contactará pronto.');
});

test('Parse LLM Reply: empty answers and <think> blocks', async () => {
  const [e] = await parse({ choices: [{ message: { content: '' } }] });
  assert.equal(e.handoff, true);
  assert.equal(e.handoffReason, 'empty_llm_reply');
  const [t] = await parse({ choices: [{ message: { content: '<think>hmm</think>Open 7-19.' } }] });
  assert.equal(t.reply, 'Open 7-19.');
});

test('LLM Error Fallback: hands over to a person with the error recorded', async () => {
  const [r] = await runCode(wf, 'LLM Error Fallback', [{ error: { message: 'Request failed with status code 429' } }], { refs: { 'Build LLM Messages': [llmCtx] } });
  assert.equal(r.handoff, true);
  assert.equal(r.handoffReason, 'llm_error');
  assert.equal(r.error, 'Request failed with status code 429');
  assert.equal(r.from, base.from);
});

test('Prepare Handoff Reply: fixed text per language, LLM sentence preferred, owner note', async () => {
  const run = (o) => runCode(wf, 'Prepare Handoff Reply', [{ ...base, handoff: true, handoffReason: 'keyword', reply: '', ...o }]).then((x) => x[0]);
  assert.match((await run({ lang: 'es' })).reply, /Una persona de nuestro equipo/);
  assert.match((await run({ lang: 'pt' })).reply, /Obrigado/);
  assert.match((await run({ lang: 'xx' })).reply, /A member of our team/);
  const custom = await run({ reply: 'Hold on, someone will write to you.' });
  assert.equal(custom.reply, 'Hold on, someone will write to you.');
  assert.match(custom.ownerMessage, /Alex Example \(15557654321\)/);
  assert.match(custom.ownerMessage, /Reason: keyword/);
  assert.match(custom.ownerMessage, /https:\/\/wa\.me\/15557654321/);
  assert.equal(custom.kind, 'handoff');
});

test('Prepare Unsupported Reply: polite bilingual notice', async () => {
  const [item] = await normalize('image-message');
  const [r] = await runCode(wf, 'Prepare Unsupported Reply', [item]);
  assert.equal(r.kind, 'unsupported');
  assert.match(r.reply, /only read text messages/);
  assert.match(r.reply, /solo puedo leer mensajes de texto/);
});

test('Finalize Reply: WhatsApp formatting, length limit and fallback text', async () => {
  const [a] = await runCode(wf, 'Finalize Reply', [{ ...base, reply: '# Hours\n**Mon-Fri** 7-19', kind: 'bot' }]);
  assert.equal(a.to, base.from);
  assert.equal(a.reply, 'Hours\n*Mon-Fri* 7-19');
  const [b] = await runCode(wf, 'Finalize Reply', [{ ...base, reply: 'x'.repeat(5000) }]);
  assert.equal(b.reply.length, 4000);
  const [c] = await runCode(wf, 'Finalize Reply', [{ ...base, reply: '  ' }]);
  assert.match(c.reply, /Sorry/);
});

test('Update Memory + Log Exchange: store the exchange and cap the log', async () => {
  const staticData = {};
  const ctx = { to: base.from, from: base.from, name: base.name, text: 'Hi', reply: 'Hello!', kind: 'bot', handoffReason: null, messageId: 'wamid.T1', model: 'm', tokens: 7 };
  await runCode(wf, 'Update Memory', [{}], { staticData, refs: { 'Finalize Reply': [ctx] } });
  assert.deepEqual(staticData.memory[base.from].map((m) => [m.role, m.content]), [['user', 'Hi'], ['assistant', 'Hello!']]);

  await runCode(wf, 'Update Memory', [{}], { staticData, refs: { 'Finalize Reply': [{ ...ctx, kind: 'unsupported' }] } });
  assert.equal(staticData.memory[base.from].length, 2, 'unsupported notices are not remembered');

  for (let i = 0; i < 25; i++) await runCode(wf, 'Update Memory', [{}], { staticData, refs: { 'Finalize Reply': [ctx] } });
  assert.equal(staticData.memory[base.from].length, 40);

  for (let i = 0; i < 205; i++) await runCode(wf, 'Log Exchange', [{}], { staticData, env: { WA_DRY_RUN: 'true' }, refs: { 'Finalize Reply': [ctx] } });
  assert.equal(staticData.log.length, 200);
  const last = staticData.log.at(-1);
  assert.deepEqual([last.inbound, last.reply, last.kind, last.tokens, last.dryRun], ['Hi', 'Hello!', 'bot', 7, true]);
  assert.match(last.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('end to end on fixtures: text message -> normalized -> not handoff -> messages ready for the LLM', async () => {
  const staticData = {};
  const norm = await normalize('text-message');
  const fresh = await runCode(wf, 'Deduplicate Messages', norm, { staticData });
  const kw = await runCode(wf, 'Detect Handoff Keywords', fresh);
  assert.equal(kw[0].handoff, false);
  const kb = wf.nodes.find((n) => n.name === 'Business Knowledge Base').parameters.assignments.assignments[0].value;
  const sp = wf.nodes.find((n) => n.name === 'System Prompt').parameters.assignments.assignments[0].value;
  const [built] = await runCode(wf, 'Build LLM Messages', [{ ...kw[0], knowledge: kb, systemPrompt: sp }], { env: ENV, staticData });
  assert.equal(built.messages.length, 2);
  assert.match(built.messages[0].content, /Sunrise Bakery/);
  assert.equal(built.messages[1].content, kw[0].text);
});

test('error handler: Format Error Message', async () => {
  const [r] = await runCode(errWf, 'Format Error Message', [{
    execution: { id: '42', url: 'http://localhost:5678/workflow/1/executions/42', lastNodeExecuted: 'Send WhatsApp Reply', error: { message: 'Bad token' } },
    workflow: { id: '1', name: 'WhatsApp LLM Assistant' },
  }]);
  assert.match(r.message, /Workflow failed: WhatsApp LLM Assistant/);
  assert.match(r.message, /Node: Send WhatsApp Reply/);
  assert.match(r.message, /Error: Bad token/);
  assert.equal(r.executionId, '42');
});
