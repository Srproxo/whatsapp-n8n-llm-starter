#!/usr/bin/env node
// Local stand-in for the WhatsApp Cloud API send endpoint. Nothing leaves your machine.
//
//   node scripts/mock-whatsapp.mjs       # listens on http://127.0.0.1:4020
//   WA_GRAPH_BASE_URL=http://127.0.0.1:4020/v21.0
//
// POST /<version>/<phone-number-id>/messages
//   Checks the bearer token and the body like the Cloud API does, stores the
//   message and answers with Meta's success shape ({ messages: [{ id }] }).
// GET    /__messages   messages received so far (JSON array)
// DELETE /__messages   forget them
// GET    /health       200
//
// Env: PORT (default 4020), HOST (default 127.0.0.1),
//      MOCK_WA_TOKEN  if set, the bearer token must equal it,
//      MOCK_WA_LOG    if set, every message is also appended to this file (JSON lines),
//      MOCK_WA_FAIL_TO  sends to this number get HTTP 500 (tests retries and the error workflow).
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 4020);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.MOCK_WA_TOKEN || '';
const LOG = process.env.MOCK_WA_LOG || '';
const FAIL_TO = process.env.MOCK_WA_FAIL_TO || '';

const messages = [];

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

// Same envelope as Graph API errors, so n8n sees a realistic failure.
const graphError = (res, status, code, message) =>
  send(res, status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'mock' } });

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const path = url.pathname.replace(/\/+$/, '');

  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (path === '/__messages') {
    if (req.method === 'DELETE') messages.length = 0;
    return send(res, 200, messages);
  }

  const match = req.method === 'POST' && path.match(/^\/(v\d+\.\d+)\/([^/]+)\/messages$/);
  if (!match) return graphError(res, 404, 100, `Unknown path ${req.method} ${path}`);

  const auth = req.headers.authorization || '';
  if (!/^Bearer \S+/.test(auth) || (TOKEN && auth !== `Bearer ${TOKEN}`)) {
    return graphError(res, 401, 190, 'Invalid OAuth access token.');
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return graphError(res, 400, 100, 'Invalid JSON body');
  }
  if (body.messaging_product !== 'whatsapp' || !body.to || body.type !== 'text' || !body.text || !body.text.body) {
    return graphError(res, 400, 100, 'Expected messaging_product=whatsapp, to, type=text and text.body');
  }

  if (FAIL_TO && body.to === FAIL_TO) {
    return send(res, 500, { error: { message: 'Mock failure requested (MOCK_WA_FAIL_TO)', type: 'OAuthException', code: 131000, fbtrace_id: 'mock' } });
  }

  const id = `wamid.MOCK${String(messages.length + 1).padStart(6, '0')}`;
  const record = { id, at: new Date().toISOString(), version: match[1], phoneNumberId: match[2], to: body.to, text: body.text.body, body };
  messages.push(record);
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(record) + '\n');
  console.log(`-> ${body.to}: ${body.text.body.replace(/\n/g, ' ').slice(0, 120)}`);

  return send(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id }] });
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`mock-whatsapp listening on http://${HOST}:${port}/v21.0`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
