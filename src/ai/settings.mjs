import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Called only by the token-protected local settings endpoint. Never return the
// credential to the browser, diagnostics, reports or the portable build.
export async function saveAISettings(file, { apiKey, allowPaid = true }) {
  if (typeof apiKey !== 'string' || !/^sk-or-v1-[A-Za-z0-9_-]{16,200}$/.test(apiKey.trim())) throw new Error('OpenRouter key không đúng định dạng.');
  if (typeof allowPaid !== 'boolean') throw new Error('Lựa chọn model trả phí phải là true/false.');
  const key = apiKey.trim();
  const settings = {
    AI_ENABLED: 'true', OPENROUTER_API_KEY: key,
    OPENROUTER_MODEL_SPEC: 'auto', OPENROUTER_MODEL_EXPLAIN: 'auto', OPENROUTER_ROUTING: 'free-first',
    OPENROUTER_ALLOW_PAID: String(allowPaid), OPENROUTER_MAX_FREE_ATTEMPTS: '0',
    OPENROUTER_MAX_MODEL_ATTEMPTS: '40', OPENROUTER_MAX_COMPLETION_REQUESTS: '48',
    OPENROUTER_MAX_PROMPT_USD_PER_MILLION: '0.25', OPENROUTER_MAX_COMPLETION_USD_PER_MILLION: '1',
    OPENROUTER_REQUEST_BUDGET_USD: '0.01',
  };
  let previous = '';
  try { previous = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = previous.split(/\r?\n/).filter(line => {
    const name = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    return !Object.hasOwn(settings, name);
  });
  const content = [...lines, ...Object.entries(settings).map(([name, value]) => `${name}=${value}`), ''].join('\n');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  return { enabled: true, apiKey: key, modelSpec: 'auto', modelExplain: 'auto', routing: 'free-first', allowPaid,
    maxFreeAttempts: 0, maxModelAttempts: 40, maxCompletionRequests: 48,
    maxPromptUsdPerMillion: 0.25, maxCompletionUsdPerMillion: 1, requestBudgetUsd: 0.01 };
}
