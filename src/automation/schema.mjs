import Ajv from 'ajv';

const timezone = 'Asia/Ho_Chi_Minh';
const locator = {
  type: 'object', additionalProperties: false, required: ['by', 'value'],
  properties: {
    // visible_text: the visible element showing this text, preferring an open popup or
    // suggestion list (how an autocomplete entry is picked right after typing).
    by: { enum: ['role', 'label', 'placeholder', 'text', 'testId', 'css', 'visible_text'] },
    value: { type: 'string', minLength: 1 }, role: { type: 'string', minLength: 1 },
    exact: { type: 'boolean' }, nth: { type: 'integer', minimum: 0 },
    // Narrows the match to the smallest card/row containing this text, e.g. the
    // "Đặt ngay" button inside the card of one rate plan.
    within: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 300 } } },
  },
  allOf: [{ if: { properties: { by: { const: 'role' } } }, then: { required: ['role'] } }],
};
const url = { type: 'string', minLength: 1, pattern: '^(https?://|\\{\\{[^{}]+\\}\\}$)' };
const action = (type, properties = {}, required = []) => ({
  type: 'object', additionalProperties: false, required: ['type', ...required],
  properties: { type: { const: type }, timeout_ms: { type: 'integer', minimum: 1, maximum: 60000 },
    // optional: skipped when absent (intermittent popups). irreversible: submits a
    // booking/payment; AI repair never repeats it once it has been attempted.
    optional: { type: 'boolean' }, irreversible: { type: 'boolean' }, note: { type: 'string', maxLength: 300 }, ...properties },
});
const observedEvent = { type: 'object', additionalProperties: false, required: ['event_name'],
  properties: { event_name: { type: 'string', minLength: 1, maxLength: 200 }, source: { type: 'string', maxLength: 40 }, count: { type: 'integer', minimum: 0 } } };

export const WORKFLOW_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object', additionalProperties: false, required: ['schema_version', 'name', 'url', 'steps'],
  properties: {
    schema_version: { const: '1.0' }, id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' },
    name: { type: 'string', minLength: 1, maxLength: 200 }, url,
    browser: { enum: ['chrome', 'edge'] }, variables: { type: 'object' },
    export_report: { type: 'boolean' },
    // Original scenario text and whether AI may repair a step whose recorded
    // actions no longer match the website during a later run.
    instructions: { type: 'string', maxLength: 30000 }, ai_heal: { type: 'boolean' },
    recorded_at: { type: 'string', maxLength: 40 },
    steps: {
      type: 'array', minItems: 1, maxItems: 100,
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'actions'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 }, name: { type: 'string', minLength: 1, maxLength: 200 },
          case_id: { type: 'string', minLength: 1 }, context: { type: 'object' },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 120000 },
          instructions: { type: 'string', maxLength: 4000 }, note: { type: 'string', maxLength: 600 },
          // Not (fully) recorded yet: AI performs the rest of the step at run time.
          pending: { type: 'boolean' },
          observed_events: { type: 'array', maxItems: 100, items: observedEvent },
          expected_events: { type: 'array', maxItems: 100, items: {
            type: 'object', additionalProperties: false, required: ['event_name'],
            properties: { event_name: { type: 'string', minLength: 1 }, source: { enum: ['GA4', 'INSIDER', 'TP2'] }, layer: { enum: ['JS_QUEUE', 'TRACKING_REQUEST'] } },
          } },
          actions: { type: 'array', maxItems: 200, items: { oneOf: [
            action('goto', { url }, ['url']),
            action('click', { locator: { $ref: '#/$defs/locator' } }, ['locator']),
            action('fill', { locator: { $ref: '#/$defs/locator' }, value: { type: ['string', 'number', 'boolean'] } }, ['locator', 'value']),
            // Key-by-key typing for search boxes whose suggestions react to keystrokes.
            action('type', { locator: { $ref: '#/$defs/locator' }, value: { type: ['string', 'number', 'boolean'] } }, ['locator', 'value']),
            action('hover', { locator: { $ref: '#/$defs/locator' } }, ['locator']),
            action('back'),
            action('scroll', { direction: { enum: ['down', 'up'] }, amount: { type: 'integer', minimum: 50, maximum: 5000 } }),
            action('wait_ms', { ms: { type: 'integer', minimum: 0, maximum: 30000 } }, ['ms']),
            action('select', { locator: { $ref: '#/$defs/locator' }, value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, ['locator', 'value']),
            action('check', { locator: { $ref: '#/$defs/locator' }, checked: { type: 'boolean' } }, ['locator', 'checked']),
            action('press', { locator: { $ref: '#/$defs/locator' }, key: { type: 'string', minLength: 1 } }, ['locator', 'key']),
            action('wait_for', { locator: { $ref: '#/$defs/locator' }, state: { enum: ['visible', 'hidden'] } }, ['locator']),
            action('assert_text', { locator: { $ref: '#/$defs/locator' }, text: { type: 'string' } }, ['locator', 'text']),
            action('assert_url', { url }, ['url']),
            // The address contains this text (a path, or "checkIn={{checkin}}"): the end-of-step check.
            action('wait_url', { contains: { type: 'string', minLength: 1, maxLength: 500 } }, ['contains']),
          ] } },
        },
      },
    },
    schedule: {
      type: 'object', additionalProperties: false, required: ['enabled', 'time', 'timezone', 'days'],
      properties: {
        enabled: { type: 'boolean' }, time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' },
        timezone: { const: timezone }, days: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 6 } },
      },
    },
  },
  $defs: { locator },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(WORKFLOW_SCHEMA);
const actionValidators = new Map(WORKFLOW_SCHEMA.properties.steps.items.properties.actions.items.oneOf.map(schema => [schema.properties.type.const, ajv.compile({ ...schema, $defs: { locator } })]));
function assertJson(value, seen = new Set(), depth = 0) {
  if (depth > 40) throw new Error('Dữ liệu luồng lồng quá nhiều cấp.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value) || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Luồng chỉ nhận dữ liệu JSON; không nhận mã thực thi hoặc tham chiếu vòng.');
  seen.add(value);
  for (const child of Object.values(value)) assertJson(child, seen, depth + 1);
  seen.delete(value);
}
function schemaError(errors) {
  // Individual actions are checked against their selected variant before the full schema.
  const error = errors.find(item => item.keyword !== 'const' && item.keyword !== 'oneOf' && item.keyword !== 'additionalProperties') ?? errors[0];
  const field = (error.instancePath || 'luồng').replaceAll('/', '.').replace(/^\./, '');
  if (error.keyword === 'required') return `Thiếu trường bắt buộc: ${field}.${error.params.missingProperty}.`;
  if (error.keyword === 'additionalProperties') return `Trường không được hỗ trợ: ${field}.${error.params.additionalProperty}.`;
  if (error.keyword === 'enum') return `${field} chỉ nhận: ${error.params.allowedValues.join(', ')}.`;
  if (error.keyword === 'const') return `${field} phải có giá trị ${JSON.stringify(error.params.allowedValue)}.`;
  if (error.keyword === 'type') return `${field} phải có kiểu ${[].concat(error.params.type).map(type => ({ object: 'đối tượng', array: 'mảng', string: 'chuỗi', number: 'số', integer: 'số nguyên', boolean: 'đúng/sai' })[type] ?? type).join(' hoặc ')}.`;
  if (error.keyword === 'maximum' || error.keyword === 'maxLength' || error.keyword === 'maxItems') return `${field} vượt quá giới hạn ${error.params.limit}.`;
  if (error.keyword === 'minimum' || error.keyword === 'minLength' || error.keyword === 'minItems') return `${field} phải có tối thiểu ${error.params.limit}.`;
  if (error.keyword === 'uniqueItems') return `${field} không được có giá trị trùng.`;
  return `Dữ liệu không đúng định dạng tại ${field}.`;
}
function validateUrl(value, label, allowTemplate) {
  if (allowTemplate && /^\{\{[^{}]+\}\}$/.test(value)) return;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch { throw new Error(`${label} phải là URL http hoặc https hợp lệ.`); }
}

export function validateWorkflow(input) {
  assertJson(input);
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Luồng phải là một đối tượng JSON.');
  const data = structuredClone(input);
  if (data.schema_version === undefined) data.schema_version = '1.0';
  if (data.browser === undefined) data.browser = 'chrome';
  if (data.variables === undefined) data.variables = {};
  if (data.schedule === undefined) data.schedule = {};
  if (data.schedule && typeof data.schedule === 'object' && !Array.isArray(data.schedule)) data.schedule = {
    enabled: false, time: '07:00', timezone, days: [0, 1, 2, 3, 4, 5, 6], ...data.schedule,
  };
  if (Array.isArray(data.steps)) data.steps = data.steps.map((step, index) => step && typeof step === 'object' && !Array.isArray(step)
    ? { id: `step-${index + 1}`, context: {}, expected_events: [], ...step } : step);
  for (const step of Array.isArray(data.steps) ? data.steps : []) for (const item of Array.isArray(step?.actions) ? step.actions : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Thao tác của bước ${step.name ?? ''} phải là đối tượng JSON.`);
    const check = actionValidators.get(item.type);
    if (!check) throw new Error(`Thao tác không được hỗ trợ: ${String(item.type ?? '(thiếu type)')}.`);
    if (!check(item)) throw new Error(`Bước ${step.name ?? ''}: ${schemaError(check.errors)}`);
  }
  if (!validate(data)) throw new Error(schemaError(validate.errors));
  if (!data.name.trim() || data.steps.some(step => !step.name.trim())) throw new Error('Tên luồng và tên bước không được để trống.');
  const ids = new Set();
  for (const step of data.steps) {
    if (ids.has(step.id)) throw new Error(`Mã bước bị trùng: ${step.id}.`);
    ids.add(step.id);
    for (const item of step.actions) if (item.type === 'goto' || item.type === 'assert_url') validateUrl(item.url, `URL của bước ${step.name}`, true);
  }
  validateUrl(data.url, 'URL của luồng', true);
  return data;
}

const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD of the Vietnam calendar day `offset` days after `now`. */
export function calendarDate(now = new Date(), offset = 0) { return dateValue(now instanceof Date ? now : new Date(now), offset); }
function dateValue(now, offset) {
  const parts = Object.fromEntries(calendar.formatToParts(now).map(part => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offset));
  return day.toISOString().slice(0, 10);
}

/** Formats an ISO calendar date (YYYY-MM-DD) with the tokens YYYY, MM, DD, M and D,
 * e.g. {{checkin|DD/MM/YYYY}} or {{date:+14|D}} for the day cell of a date picker. */
export function formatDate(value, format) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Chỉ định dạng được giá trị ngày YYYY-MM-DD, nhận: ${String(value).slice(0, 40)}.`);
  if (typeof format !== 'string' || !format.trim() || format.length > 40) throw new Error('Định dạng ngày không hợp lệ.');
  const [, year, month, day] = match;
  // dddd: Vietnamese weekday as date pickers write it ("Chủ Nhật", "Thứ Hai"…).
  const weekday = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'][new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  return format.trim().replace(/dddd|YYYY|MM|DD|M|D/g, token => ({ dddd: weekday, YYYY: year, MM: month, DD: day, M: String(Number(month)), D: String(Number(day)) })[token]);
}

const PROSE_FIELDS = new Set(['instructions', 'note', 'observed_events']);
function templateResolver(values, instant) {
  const resolving = new Set();
  const tokenValue = token => {
    const [expression, ...formats] = token.split('|');
    const key = expression.trim(), date = key.match(/^date(?::([+-]?\d+))?$/);
    let value;
    if (date) {
      const offset = Number(date[1] ?? 0);
      if (!Number.isSafeInteger(offset) || Math.abs(offset) > 36600) throw new Error(`Độ lệch ngày không hợp lệ: ${key}.`);
      value = dateValue(instant, offset);
    } else {
      const path = key.replace(/^variables\./, '').split('.');
      value = values;
      for (const part of path) {
        if (!part || !value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error(`Chưa có giá trị cho biến: ${key}.`);
        value = value[part];
      }
      if (resolving.has(key)) throw new Error(`Biến tham chiếu vòng: ${key}.`);
      resolving.add(key);
      try { value = substitute(value); }
      finally { resolving.delete(key); }
    }
    return formats.length ? formatDate(value, formats.join('|')) : value;
  };
  const substitute = value => {
    if (typeof value === 'string') {
      const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
      if (exact) return tokenValue(exact[1]);
      return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
        const replacement = tokenValue(key);
        return typeof replacement === 'object' ? JSON.stringify(replacement) : String(replacement);
      });
    }
    if (Array.isArray(value)) return value.map(substitute);
    // Scenario text and notes are documentation: "{{ten_bien}}" written there as an
    // example must not be treated as a variable.
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, PROSE_FIELDS.has(key) ? child : substitute(child)]));
    return value;
  };
  return substitute;
}

function runInstant(now) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Thời điểm chạy luồng không hợp lệ.');
  return instant;
}

/** Resolves a variables object on its own (dates, nested references), as used by
 * the AI exploration before any workflow exists. */
export function resolveVariables(variables = {}, { now = new Date() } = {}) {
  assertJson(variables);
  if (!variables || Array.isArray(variables) || typeof variables !== 'object') throw new Error('Biến đầu vào phải là một đối tượng JSON.');
  const values = structuredClone(variables);
  return templateResolver(values, runInstant(now))(values);
}

export function resolveWorkflow(workflow, { now = new Date(), variables = {} } = {}) {
  const result = validateWorkflow(workflow), instant = runInstant(now);
  assertJson(variables);
  if (!variables || Array.isArray(variables) || typeof variables !== 'object') throw new Error('Biến đầu vào phải là một đối tượng JSON.');
  const values = { ...result.variables, ...structuredClone(variables) };
  const substitute = templateResolver(values, instant);
  const resolved = substitute({ ...result, variables: values });
  validateUrl(resolved.url, 'URL của luồng', false);
  for (const step of resolved.steps) for (const item of step.actions) if (item.type === 'goto' || item.type === 'assert_url') validateUrl(item.url, `URL của bước ${step.name}`, false);
  return validateWorkflow(resolved);
}
