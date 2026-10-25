// Minimal stand-in for the n8n Code node runtime, enough to run the workflow's
// Code nodes offline: $input, $json, $env, $getWorkflowStaticData, $('Node'),
// require('crypto') and this.helpers.getBinaryDataBuffer.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function getNode(workflow, name) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`Node not found: ${name}`);
  return node;
}

/**
 * Run a Code node.
 * @param {object} workflow parsed workflow JSON
 * @param {string} name node name
 * @param {object[]} items input items, plain json objects
 * @param {{env?: object, staticData?: object, refs?: Record<string, object[]>, binary?: object[]}} ctx
 *   refs: output of other nodes, for $('Other node').item / .first() / .all()
 *   binary: binary part of each input item, e.g. [{ data: { data: '<base64>' } }]
 * @returns {Promise<object[]>} output json objects
 */
async function runCode(workflow, name, items, ctx = {}) {
  const node = getNode(workflow, name);
  if (node.type !== 'n8n-nodes-base.code') throw new Error(`${name} is not a Code node`);
  const env = ctx.env || {};
  const staticData = ctx.staticData || {};
  const refs = ctx.refs || {};
  const wrapped = items.map((json, i) => {
    const item = { json: structuredClone(json) };
    if (ctx.binary && ctx.binary[i]) item.binary = structuredClone(ctx.binary[i]);
    return item;
  });
  const all = () => wrapped;
  const first = () => wrapped[0];
  const fn = new AsyncFunction('$input', '$json', '$env', '$getWorkflowStaticData', '$', 'require', node.parameters.jsCode);
  // Like n8n with NODE_FUNCTION_ALLOW_BUILTIN=crypto: only crypto may be required.
  const sandboxRequire = (mod) => {
    if (mod === 'crypto' || mod === 'node:crypto') return require('node:crypto');
    throw new Error(`Cannot find module '${mod}' (not allowed in the harness)`);
  };
  const self = {
    helpers: {
      async getBinaryDataBuffer(i, property) {
        const bin = wrapped[i] && wrapped[i].binary && wrapped[i].binary[property];
        if (!bin) throw new Error(`No binary property "${property}" on item ${i}`);
        return Buffer.from(bin.data, 'base64');
      },
    },
  };
  const refFn = (nodeName, i) => {
    const list = (refs[nodeName] || []).map((json) => ({ json }));
    return { item: list[i] || list[0], first: () => list[0], all: () => list };
  };

  if (node.parameters.mode === 'runOnceForAllItems') {
    const out = await fn.call(self, { all, first, item: wrapped[0] }, undefined, env, () => staticData, (n) => refFn(n, 0), sandboxRequire);
    return out.map((o) => o.json);
  }
  const results = [];
  for (let i = 0; i < wrapped.length; i++) {
    const out = await fn.call(self, { all, first, item: wrapped[i] }, wrapped[i].json, env, () => staticData, (n) => refFn(n, i), sandboxRequire);
    if (out && out.json) results.push(out.json);
  }
  return results;
}

/** Wrap a fixture the way the n8n Webhook node delivers it: {headers, query, body}. */
function asWebhookItem(fixtureName) {
  return { headers: {}, query: {}, body: loadJson(`scripts/fixtures/${fixtureName}.json`) };
}

module.exports = { ROOT, loadJson, getNode, runCode, asWebhookItem };
