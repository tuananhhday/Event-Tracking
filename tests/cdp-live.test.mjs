import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser } from '../src/browser/launcher.mjs';
import { CDPCollector } from '../src/collectors/cdp.mjs';
import { redact } from '../src/core/privacy.mjs';
import { DEFAULT_ENDPOINT_PATTERNS } from '../src/core/decoder.mjs';

test('optional read-only live Trip CDP smoke', { skip: !process.env.EVENTQA_LIVE_CDP, timeout: 60000 }, async () => {
  const output = resolve('runs/live-trip-cdp');
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'events.jsonl'), '', 'utf8');
  const statuses = [], events = [], hosts = {}, errors = [];
  const launched = await launchBrowser({ browser: 'chrome', port: 19322, headless: true, profileDir: resolve('.profiles/live-trip-cdp'), url: 'about:blank' });
  const endpointPatterns = ['^ubt-sin\\.tripcdn\\.com/', ...DEFAULT_ENDPOINT_PATTERNS];
  const collector = new CDPCollector({ port: launched.port, endpointPatterns, onStatus: message => statuses.push(message), onEvent: event => {
    const safe = redact(event); events.push(safe); appendFileSync(resolve(output, 'events.jsonl'), JSON.stringify(safe) + '\n', 'utf8');
  } });
  let connection, navigation, document, failure;
  try {
    await collector.start({ id: 'live-trip-cdp' });
    connection = [...collector.connections.values()][0].connection;
    connection.on('event', event => {
      if (event.method === 'Network.requestWillBeSent') {
        try { const host = new URL(event.params.request.url).hostname; hosts[host] = (hosts[host] || 0) + 1; } catch {}
      } else if (event.method === 'Network.loadingFailed') errors.push({ error: event.params.errorText, type: event.params.type });
    });
    navigation = await connection.send('Page.navigate', { url: 'https://www.trip.com/' });
    await delay(20000);
    const read = await connection.send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,queueTypes:{dataLayer:Array.isArray(window.dataLayer),InsiderQueue:Array.isArray(window.InsiderQueue)},hookInstalled:Boolean(window[Symbol.for("eventqa.collector.v1")])})', returnByValue: true });
    document = JSON.parse(read.result?.value || '{}');
    assert.equal(document.hookInstalled, true);
  } catch (error) { failure = error.message; }
  finally {
    const observation = { captured_at: new Date().toISOString(), site: 'https://www.trip.com/', mode: 'CDP_NO_AI',
      scope: 'Read-only homepage navigation; no login, no search/order, no synthetic analytics sends.',
      status: failure || navigation?.errorText ? 'LIMITED' : 'COLLECTOR_CONNECTED', navigation, document,
      event_count: events.length, queue_events: events.filter(event => event.layer === 'JS_QUEUE').length,
      tracking_requests: events.filter(event => event.network?.phase === 'request').length,
      tracking_responses: events.filter(event => event.network?.phase === 'response').length,
      tracking_failures: events.filter(event => event.network?.phase === 'failed').length,
      endpoint_patterns: endpointPatterns,
      network_scope: 'Default filters capture GA4/Insider only. Added observed Trip telemetry host ubt-sin.tripcdn.com to prove network capture; these CUSTOM records have no Trip expected-event specification.',
      network_hosts: hosts, network_errors: errors, statuses,
      expected_event_verdict: 'NOT_EVALUATED: no Trip tracking specification was supplied', vendor_ingestion: 'NOT_VERIFIED',
      ...(failure ? { failure } : {}) };
    writeFileSync(resolve(output, 'observations.json'), JSON.stringify(redact(observation), null, 2), 'utf8');
    console.log(JSON.stringify({ output, status: observation.status, events: events.length, title: document?.title, failure }));
    await collector.stop();
    try {
      // A separate owned connection is unnecessary: Browser.close is available on the page endpoint too.
      if (connection && !connection.closed) await connection.send('Browser.close');
      else {
        const { CDPConnection, listTargets } = await import('../src/collectors/cdp.mjs');
        const targets = await listTargets(launched.port);
        if (targets[0]) { const closer = new CDPConnection(targets[0].webSocketDebuggerUrl); await closer.connect(); await closer.send('Browser.close').catch(() => {}); closer.close(); }
      }
    } catch { launched.process?.kill(); }
  }
  assert.equal(failure, undefined);
});
