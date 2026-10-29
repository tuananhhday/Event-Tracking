import fs from 'node:fs/promises';
import path from 'node:path';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';
import { redact } from '../src/core/privacy.mjs';
const models = process.argv.slice(2).filter(value => !value.startsWith('--')).slice(0, 3);
if (!models.length) throw new Error('Cung cấp tối đa ba model ID; dùng node --env-file=.env scripts/ai-probe.mjs model-id.');
const records = [];
for (const id of models) {
  const client = new OpenRouterClient({ enabled: true, modelExplain: id, allowPaid: true, maxRetries: 0, maxModelAttempts: 1, maxOutputTokens: 1000, requestBudgetUsd: 0.001, timeoutMs: 25000 });
  const result = await client.explain({ verdict: 'FAIL', test_case_id: 'DEMO-PROBE', issues: [{ code: 'MISSING_FIELD', path: 'destination_id', evidence_id: 'DEMO-1' }] });
  const record = redact({ tested_at: new Date().toISOString(), model_requested: id, ...result });
  records.push(record); console.log(JSON.stringify(record, null, 2));
}
const out = path.resolve('runs/ai-smoke'); await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'targeted-probes.json'), JSON.stringify(records, null, 2));
