import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRequest, matchesEndpoint, looksLikeTracking, VENDOR_ENDPOINTS } from '../src/core/decoder.mjs';
import { CDPCollector } from '../src/collectors/cdp.mjs';

test('vendor allowlists match real endpoints by host + path, including GA4 /g/s/collect and server-side tagging', () => {
  for (const pattern of Object.values(VENDOR_ENDPOINTS).flatMap(vendor => vendor.patterns)) new RegExp(pattern, 'i');
  const ga4 = [...VENDOR_ENDPOINTS.ga4.patterns, ...VENDOR_ENDPOINTS.ga4_server.patterns];
  for (const url of ['https://analytics.google.com/g/s/collect?v=2', 'https://region1.google-analytics.com/g/collect', 'https://sst.shop.vn/g/collect']) assert.ok(matchesEndpoint(url, ga4), url);
  assert.ok(!matchesEndpoint('https://www.example.vn/search?q=g/collect', ga4), 'query strings never match');
  assert.ok(matchesEndpoint('https://www.facebook.com/tr?id=1&ev=PageView', VENDOR_ENDPOINTS.meta.patterns));
  assert.ok(!matchesEndpoint('https://www.facebook.com/tracking/page', VENDOR_ENDPOINTS.meta.patterns));
});

test('Meta Pixel and GA4 /g/s/collect requests decode to their event names', () => {
  const [meta] = decodeRequest({ url: 'https://www.facebook.com/tr?id=1&ev=AddToCart', method: 'GET' });
  assert.equal(meta.source, 'META'); assert.equal(meta.event_name, 'AddToCart');
  const [ga] = decodeRequest({ url: 'https://analytics.google.com/g/s/collect?v=2&tid=G-X&en=view_item&ep.item_id=SKU1' });
  assert.equal(ga.source, 'GA4'); assert.equal(ga.event_name, 'view_item'); assert.equal(ga.payload.item_id, 'SKU1');
});

test('endpoint suggestions flag beacon-like requests only', () => {
  assert.ok(looksLikeTracking({ url: 'https://ubt-sin.tripcdn.com/bee/collect', method: 'POST' }));
  assert.ok(looksLikeTracking({ url: 'https://api.shop.vn/v1/x', method: 'POST', resourceType: 'Ping' }));
  assert.ok(!looksLikeTracking({ url: 'https://cdn.shop.vn/analytics.js', method: 'GET' }), 'scripts are not beacons');
  assert.ok(!looksLikeTracking({ url: 'https://api.shop.vn/v1/login', method: 'POST' }));
  assert.ok(!looksLikeTracking({ url: 'https://t.shop.vn/collect', method: 'OPTIONS' }));
});

test('collector allowlist can change while running and drops suggestions it now covers', () => {
  const collector = new CDPCollector({ onEvent() {} });
  collector.discovered.set('ubt-sin.tripcdn.com/bee/collect', { endpoint: 'ubt-sin.tripcdn.com/bee/collect', count: 3 });
  assert.throws(() => collector.setPatterns(['(bad']));
  collector.setPatterns(['^ubt-sin\\.tripcdn\\.com/bee/collect$']);
  assert.equal(collector.discovered.size, 0);
  assert.deepEqual(collector.patterns, ['^ubt-sin\\.tripcdn\\.com/bee/collect$']);
});

