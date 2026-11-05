import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTarget, groundInitialActions } from '../src/automation/targets.mjs';
const control = extra => ({ tag: 'input', name: 'location', label: 'Destination', editable: true, locator: { by: 'label', value: 'Destination', exact: true }, ...extra });
const action = { type: 'fill', locator: { by: 'label', value: 'location' }, value: 'Nha Trang' };

test('binds an HTML name to the real accessible field instead of treating a variable name as a label', () => {
  assert.deepEqual(bindTarget(action, { controls: [control()] }), { by: 'label', value: 'Destination', exact: true });
  assert.equal(bindTarget(action, { controls: [control(), control({ label: 'Another destination' })] }), null);
  assert.equal(bindTarget(action, { controls: [control({ sensitive: true })] }), null);
  assert.equal(bindTarget(action, { controls: [control({ editable: false })] }), null);
});

test('rejects invented initial fields and fill on readonly pickers, but allows clicking a real picker first', () => {
  const flow = { url: 'https://example.test/en', steps: [{ actions: [action] }] };
  assert.throws(() => groundInitialActions(flow, { controls: [control({ name: 'destination', label: 'Destination' })] }), { code: 'INVALID_AI_GROUNDED_LOCATOR' });
  assert.equal(groundInitialActions(flow, { controls: [control()] }).steps[0].actions[0].locator.value, 'Destination');
  const picker = control({ editable: false, readonly: true });
  assert.throws(() => groundInitialActions(flow, { controls: [picker] }), { code: 'INVALID_AI_GROUNDED_LOCATOR' });
  const afterClick = { ...flow, steps: [{ actions: [{ ...action, type: 'click' }, action] }] };
  assert.equal(groundInitialActions(afterClick, { controls: [picker] }).steps[0].actions[0].locator.value, 'Destination');
});
