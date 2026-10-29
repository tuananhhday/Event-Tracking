import fs from 'node:fs/promises';
import { importSpec } from './spec/import.mjs';
import { SessionManager } from './core/session.mjs';
import { decodeRequest } from './core/decoder.mjs';
import { exportReports } from './report/export.mjs';
import { fileURLToPath } from 'node:url';

export async function loadDemoCases() { return (await importSpec(fileURLToPath(new URL('../examples/cases.json', import.meta.url)))).cases; }
export async function runDemo({ runsDir = 'runs', failure = false } = {}) {
  const cases = await loadDemoCases();
  const contexts = JSON.parse(await fs.readFile(new URL('../examples/contexts.json', import.meta.url), 'utf8'));
  const manager = new SessionManager({ runsDir, mode: 'demo', cases }); manager.start({ environment: 'SYNTHETIC_DEMO', browser: 'Fixture only' });
  const payloads = [
    { event: 'search_submit', service: 'hotel', destination: 'Phú Quốc', destination_id: '285dd301-f562-4969-a6b8-b5dd2383a1cb', quantity_adult: 2, service_duration: 1 },
    { event: 'search_submit', service: 'merchandise', search_term: 'snack', search_source: 'listing_searchbox' },
    { event: 'product_detail_page_view', product: { id: 'SKU-001', price: 120000 } }
  ];
  for (let i = 0; i < cases.length; i++) {
    manager.startStep(cases[i].id, contexts[cases[i].id]); const payload = { ...payloads[i] };
    if (failure && i === 0) delete payload.destination_id;
    manager.emit({ source: cases[i].source, layer: 'JS_QUEUE', queue_name: i === 2 ? 'InsiderQueue' : 'dataLayer', event_name: payload.event,
      page: { url: 'http://127.0.0.1/demo' }, payload });
    for (const event of decodeRequest({ url: i === 2 ? 'http://127.0.0.1/demo/insider/events' : 'http://127.0.0.1/demo/g/collect', body: JSON.stringify(payload), contentType: 'application/json', source: cases[i].source, requestId: `demo-${i}` })) manager.emit(event);
    manager.completeStep();
  }
  const snapshot = manager.finish(); const files = await exportReports(snapshot, manager.runDir);
  return { manager, snapshot, files };
}
