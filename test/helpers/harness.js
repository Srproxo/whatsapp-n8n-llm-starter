// Minimal stand-in for the n8n Code node runtime, enough to run the workflow's
// Code nodes offline: $input, $json, $env, $getWorkflowStaticData and $('Node').
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
 * @param {{env?: object, staticData?: object, refs?: Record<string, object[]>}} ctx
 *   refs: output of other nodes, for $('Other node').item / .first() / .all()
 * @returns {Promise<object[]>} output json objects
 */
async function runCode(workflow, name, items, ctx = {}) {
  const node = getNode(workflow, name);
  if (node.type !== 'n8n-nodes-base.code') throw new Error(`${name} is not a Code node`);
  const env = ctx.env || {};
  const staticData = ctx.staticData || {};
  const refs = ctx.refs || {};
  const wrapped = items.map((json) => ({ json: structuredClone(json) }));
  const all = () => wrapped;
  const first = () => wrapped[0];
  const fn = new AsyncFunction('$input', '$json', '$env', '$getWorkflowStaticData', '$', node.parameters.jsCode);
  const refFn = (nodeName, i) => {
    const list = (refs[nodeName] || []).map((json) => ({ json }));
    return { item: list[i] || list[0], first: () => list[0], all: () => list };
  };

  if (node.parameters.mode === 'runOnceForAllItems') {
    const out = await fn({ all, first, item: wrapped[0] }, undefined, env, () => staticData, (n) => refFn(n, 0));
    return out.map((o) => o.json);
  }
  const results = [];
  for (let i = 0; i < wrapped.length; i++) {
    const out = await fn({ all, first, item: wrapped[i] }, wrapped[i].json, env, () => staticData, (n) => refFn(n, i));
    if (out && out.json) results.push(out.json);
  }
  return results;
}

/** Wrap a fixture the way the n8n Webhook node delivers it: {headers, query, body}. */
function asWebhookItem(fixtureName) {
  return { headers: {}, query: {}, body: loadJson(`scripts/fixtures/${fixtureName}.json`) };
}

module.exports = { ROOT, loadJson, getNode, runCode, asWebhookItem };
