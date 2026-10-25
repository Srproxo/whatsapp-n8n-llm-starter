#!/usr/bin/env node
// Local stand-in for an OpenAI-compatible LLM API. Free, offline, deterministic.
//
//   node scripts/mock-llm.mjs            # listens on http://127.0.0.1:4010
//   LLM_BASE_URL=http://127.0.0.1:4010/v1
//
// POST /v1/chat/completions (or /chat/completions)
//   - last user message asks for a person (person, human, someone, persona,
//     humano, pessoa...)  -> "[[HANDOFF]] ..." so the workflow hands over
//   - contains "MOCK_LLM_FAIL"                -> HTTP 500 (tests the fallback)
//   - anything else                           -> "Mock answer: <question>"
// GET    /__requests   requests received so far (JSON array)
// DELETE /__requests   forget them
// GET    /health       200
//
// Env: PORT (default 4010), HOST (default 127.0.0.1),
//      MOCK_LLM_API_KEY   if set, requests must carry "Authorization: Bearer <value>",
//      MOCK_LLM_DELAY_MS  wait this long before answering, like a real model (default 0).
import http from 'node:http';

const PORT = Number(process.env.PORT || 4010);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.MOCK_LLM_API_KEY || '';
const DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS || 0);
const HANDOFF = /\b(person|human|someone|somebody|persona|humano|alguien|pessoa|algu[eé]m)\b/i;

const requests = [];

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function answerFor(messages) {
  const lastUser = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
  const question = String((lastUser && lastUser.content) || '').trim();
  if (HANDOFF.test(question)) return '[[HANDOFF]] A person from our team will contact you soon.';
  return `Mock answer: ${question.slice(0, 200)}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const path = url.pathname.replace(/\/+$/, '');

  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (path === '/__requests') {
    if (req.method === 'DELETE') requests.length = 0;
    return send(res, 200, requests);
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    }
    requests.push({ at: new Date().toISOString(), authorization: req.headers.authorization || null, body });

    if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
      return send(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
    }
    if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
      return send(res, 400, { error: { message: '"model" and a non-empty "messages" array are required', type: 'invalid_request_error' } });
    }
    const lastUser = [...body.messages].reverse().find((m) => m && m.role === 'user');
    if (lastUser && String(lastUser.content).includes('MOCK_LLM_FAIL')) {
      return send(res, 500, { error: { message: 'Mock failure requested', type: 'server_error' } });
    }

    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    const content = answerFor(body.messages);
    const promptTokens = JSON.stringify(body.messages).length >> 2;
    const completionTokens = content.length >> 2;
    return send(res, 200, {
      id: `chatcmpl-mock-${requests.length}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
  }

  return send(res, 404, { error: { message: `No route for ${req.method} ${path}` } });
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`mock-llm listening on http://${HOST}:${port}/v1`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
