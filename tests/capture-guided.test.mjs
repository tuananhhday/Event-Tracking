import test from 'node:test';
import assert from 'node:assert/strict';
import { queueEvents } from '../src/collectors/cdp.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { activityEvent } from '../src/core/activity.mjs';

test('SDK batches retain the original index when unrelated entries precede a business event', () => {
  const payload = { events: [{ ignored: true }, { event_name: 'golf_checkout', event_params: { c_total: 3150000 } }] };
  const [event] = queueEvents({ queue: 'InsiderDispatch', item: { name: 'Ucd:event:beforeSend', data: payload } });
  assert.equal(event.event_name, 'golf_checkout');
  assert.equal(event.original_event_index, 1);
  assert.equal(activityEvent(event).parameter_origins['custom_parameters.total'], 'original_payload.events[1].event_params.c_total');
  assert.equal(payload.events[event.original_event_index].event_params.c_total, 3150000);
});

test('one InsiderQueue push with several events retains a shared raw envelope and correct parameter origins', () => {
  const payload = { type: 'custom_event', value: [
    { event_name: 'search_golf', event_parameters: { custom: { quantity: 2 } } },
    { event_name: 'golf_checkout', event_parameters: { custom: { total: 3150000 } } },
  ] };
  const events = queueEvents({ queue: 'InsiderQueue', item: payload });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].original_payload, payload);
  assert.equal(events[1].payload.value.length, 1, 'comparison sees the selected event, not the first sibling');
  assert.equal(activityEvent(events[1]).json.custom_parameters.total, 3150000);
  assert.equal(activityEvent(events[1]).parameter_origins['custom_parameters.total'], 'original_payload.value[1].event_parameters.custom.total');
});

test('outgoing Insider batches retain raw request envelopes and do not mix sibling parameters', () => {
  const envelope = { partner: 'demo', insider_id: 'private-id', events: [
    { event_name: 'search_golf', event_params: { c_quantity: 2 } },
    { event_name: 'golf_checkout', event_params: { c_total: 3150000 } },
  ] };
  const events = decodeRequest({ url: 'https://unification.useinsider.com/api/event/', contentType: 'application/json', body: JSON.stringify(envelope), requestId: 'batch' });
  assert.equal(events.length, 2);
  assert.equal(events[1].network.request_id, events[0].network.request_id, 'one HTTP request contains two business events');
  assert.equal(events[1].original_event_index, 1);
  const view = activityEvent(events[1]);
  assert.equal(view.json.custom_parameters.total, 3150000);
  assert.equal(view.json.custom_parameters.quantity, undefined, 'a sibling event must not supply missing params');
  assert.equal(view.parameter_origins['custom_parameters.total'], 'original_payload.events[1].event_params.c_total');
  assert.equal(events[1].original_payload.insider_id, '[REDACTED]');
});

test('GA4 ep and epn wire fields keep exact raw names while normalized values remain comparable', () => {
  const [event] = decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&en=begin_checkout&ep.currency=VND&epn.value=3150000&epn.quantity=1' });
  assert.equal(event.event_name, 'begin_checkout');
  assert.equal(event.payload.quantity, 1);
  assert.equal(event.original_payload['epn.quantity'], '1');
  assert.equal(event.original_payload['ep.currency'], 'VND');
  const view = activityEvent(event);
  assert.equal(view.json.default_parameters.value, 3150000);
  assert.equal(view.parameter_origins['default_parameters.quantity'], 'original_payload["epn.quantity"]');
  assert.equal(view.parameter_origins['default_parameters.currency'], 'original_payload["ep.currency"]');
});

test('an unreadable request body remains incomplete evidence rather than empty actual parameters', () => {
  const [event] = decodeRequest({ url: 'https://www.google-analytics.com/g/collect?en=begin_checkout', bodyUnavailable: true });
  assert.equal(event.event_name, 'begin_checkout');
  assert.equal(event.capture.incomplete, true);
  assert.deepEqual(event.capture.reasons, ['request_body_unavailable']);
  assert.equal(event.network.decode_status, 'UNAVAILABLE');
  assert.equal(activityEvent(event).capture.incomplete, true);
});
