// Only synthetic inputs. Three bounded operations reserve <= $0.009 in total.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';
import { redact } from '../src/core/privacy.mjs';

if (!(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEYS)) throw new Error('Điền key vào .env và chạy node --env-file=.env scripts/ai-smoke.mjs.');
const output = path.resolve('runs/ai-smoke'); await fs.mkdir(output, { recursive: true });
const routingOnly = process.argv.includes('--routing-only');
const options = { enabled: true, modelSpec: 'auto', modelExplain: 'auto', maxRetries: 0, maxModelAttempts: 40, maxFreeAttempts: 0, maxCompletionRequests: 48, maxOutputTokens: 1800, requestBudgetUsd: 0.003, timeoutMs: 20000 };
const input = { test_case_id: 'TC-AI-DEMO', verdict: 'FAIL', issues: [{ code: 'MISSING_FIELD', path: 'destination_id', expected: 'UUID exists', actual: null, evidence_id: 'DEMO-EV-001' }] };
const before = structuredClone(input);
const observations = { tested_at: new Date().toISOString(), inputs: 'Synthetic demo only', maximum_reserved_usd: routingOnly ? 0.006 : 0.009, operations: [] };
try {
  const freeClient = new OpenRouterClient({ ...options, allowPaid: routingOnly });
  const freeCandidates = await freeClient.listRoutingCandidates({ task: 'explain', inputTokens: 4000, outputTokens: 800 });
  const freeResult = await freeClient.explain(input);
  observations.operations.push({ name: routingOnly ? 'auto-explain' : 'free-only-explain', candidates: freeCandidates.candidates?.slice(0, 8), ...freeResult });
  assert.deepEqual(input, before, 'AI cannot mutate deterministic verdict');
  console.log(JSON.stringify({ operation: routingOnly ? 'auto-explain' : 'free-only-explain', available: freeResult.available, reason: freeResult.reason, routing: freeResult.routing }, null, 2));

  if (!routingOnly) {
  const catalogClient = new OpenRouterClient({ ...options, allowPaid: true });
  const candidates = await catalogClient.listRoutingCandidates({ task: 'explain', inputTokens: 4000, outputTokens: 800 });
  const cheapest = candidates.candidates?.find(candidate => !candidate.free);
  if (cheapest) {
    const paidClient = new OpenRouterClient({ ...options, allowPaid: true, modelExplain: cheapest.id });
    const paidResult = await paidClient.explain(input);
    observations.operations.push({ name: 'cheapest-paid-explain', candidate: cheapest, ...paidResult });
    console.log(JSON.stringify({ operation: 'cheapest-paid-explain', candidate: cheapest.id, available: paidResult.available, reason: paidResult.reason, routing: paidResult.routing }, null, 2));
  } else observations.operations.push({ name: 'cheapest-paid-explain', available: false, reason: candidates.reason || 'NO_PAID_CANDIDATE_WITHIN_PRICE_CAP' });
  }

  const draftClient = new OpenRouterClient({ ...options, allowPaid: true });
  const draftResult = await draftClient.draftCase({ source: 'GA4', flow: 'Merchandise', event_name: 'search_submit', description: 'Khi tìm kiếm sản phẩm, service cố định merchandise. search_term lấy từ context.search.term; không so exact sample.', sample: { event: 'search_submit', service: 'merchandise', search_term: 'keychain' }, provenance: { file: 'synthetic-demo', sheet: 'Demo', row: 1 } });
  if (draftResult.available) { assert.equal(draftResult.case.needs_review, true); assert.ok(draftResult.case.rules.every(rule => rule.needs_review)); }
  observations.operations.push({ name: 'auto-draft-case', ...draftResult });
  console.log(JSON.stringify({ operation: 'auto-draft-case', available: draftResult.available, reason: draftResult.reason, routing: draftResult.routing }, null, 2));
  observations.status = observations.operations.every(operation => operation.available) ? 'PASS' : 'PARTIAL';
} catch (error) {
  observations.status = 'ERROR'; observations.reason = redact(error.message); process.exitCode = 1;
} finally {
  observations.completed_at = new Date().toISOString();
  const serialized = JSON.stringify(redact(observations), null, 2);
  for (const secret of [process.env.OPENROUTER_API_KEY, ...(process.env.OPENROUTER_API_KEYS || '').split(/[\s,]+/)].filter(Boolean)) assert.ok(!serialized.includes(secret), 'API keys must not appear in persisted evidence');
  await fs.writeFile(path.join(output, 'observations.json'), serialized);
  console.log(JSON.stringify({ status: observations.status, observations: path.join(output, 'observations.json') }));
}
