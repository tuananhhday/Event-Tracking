import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redact } from './privacy.mjs';
import { apiCallSummary } from './api-log.mjs';

function atomicJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
}

function recoverJsonl(filePath, onRecord) {
  if (!fs.existsSync(filePath)) return;
  const bytes = fs.readFileSync(filePath);
  let position = 0;
  let needsNewline = false;
  while (position < bytes.length) {
    const end = bytes.indexOf(10, position);
    const next = end < 0 ? bytes.length : end + 1;
    const line = bytes.subarray(position, end < 0 ? bytes.length : end).toString('utf8').trim();
    if (line) {
      try { onRecord(JSON.parse(line)); }
      catch {
        // Byte offsets preserve multibyte UTF-8 and blank lines preceding a torn write.
        fs.writeFileSync(filePath.replace(/\.jsonl$/, '.torn-tail'), bytes.subarray(position));
        fs.truncateSync(filePath, position);
        return;
      }
    }
    position = next;
    needsNewline = end < 0;
  }
  if (needsNewline) fs.appendFileSync(filePath, '\n');
}

// JSONL is the durable source. SQLite is a rebuildable index.
export class EvidenceStore {
  constructor(runDir) {
    this.runDir = path.resolve(runDir);
    fs.mkdirSync(this.runDir, { recursive: true });
    this.eventPath = path.join(this.runDir, 'events.jsonl');
    this.stepPath = path.join(this.runDir, 'steps.jsonl');
    // Prices read from the website's API (api-prices.mjs); not events, kept beside them.
    this.apiPath = path.join(this.runDir, 'api.jsonl');
    // Full API request/response records (api-log.mjs). Only a summary per call stays in memory; the
    // record is read back from its byte range in the file.
    this.apiCallPath = path.join(this.runDir, 'api-calls.jsonl');
    this.db = new DatabaseSync(path.join(this.runDir, 'eventqa.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events(evidence_id TEXT PRIMARY KEY,session_id TEXT,test_case_id TEXT,step_id TEXT,captured_at TEXT,source TEXT,layer TEXT,event_name TEXT,page_url TEXT,record_json TEXT); CREATE INDEX IF NOT EXISTS event_scope ON events(test_case_id,step_id,layer,event_name);');
    this.insert = this.db.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?,?,?,?,?,?)');
    this.recover();
    this.fd = fs.openSync(this.eventPath, 'a');
    this.stepsFd = fs.openSync(this.stepPath, 'a');
    this.apiFd = fs.openSync(this.apiPath, 'a');
    this.apiCallFd = fs.openSync(this.apiCallPath, 'a');
  }
  recover() {
    // Never return an index row that is absent from the durable source.
    this.db.exec('DELETE FROM events');
    recoverJsonl(this.eventPath, event => this.index(event));
    const latest = new Map();
    recoverJsonl(this.stepPath, step => latest.set(step.id, step));
    this.recoveredSteps = [...latest.values()];
    this.apiList = [];
    recoverJsonl(this.apiPath, record => this.apiList.push(record));
    this.apiCallIndex = [];
    recoverJsonl(this.apiCallPath, () => {});
    this.apiCallBytes = 0;
    if (fs.existsSync(this.apiCallPath)) {
      const bytes = fs.readFileSync(this.apiCallPath);
      for (let position = 0; position < bytes.length;) {
        const end = bytes.indexOf(10, position), next = end < 0 ? bytes.length : end + 1;
        const length = (end < 0 ? bytes.length : end) - position;
        if (length > 0) {
          try { this.apiCallIndex.push({ ...apiCallSummary(JSON.parse(bytes.subarray(position, position + length).toString('utf8'))), offset: position, length }); } catch { /* recoverJsonl moved a torn tail aside */ }
        }
        position = next;
      }
      this.apiCallBytes = bytes.length;
    }
  }
  index(event) {
    this.eventsCache = null;
    this.insert.run(event.evidence_id, event.session_id || null, event.test_case_id || null, event.step_id || null,
      event.captured_at, event.source || 'CUSTOM', event.layer, event.event_name, event.page?.url || '', JSON.stringify(event));
  }
  append(event) {
    const safe = redact(event);
    // This is our generated run identifier, rather than a website session token.
    safe.session_id = event.session_id;
    fs.writeFileSync(this.fd, JSON.stringify(safe) + '\n');
    fs.fsyncSync(this.fd);
    this.index(safe);
    return safe;
  }
  appendApi(record) {
    const safe = redact(record);
    safe.session_id = record.session_id;
    fs.writeFileSync(this.apiFd, JSON.stringify(safe) + '\n');
    this.apiList.push(safe);
    return safe;
  }
  apiRecords() { return this.apiList.slice(); }
  appendApiCall(record) {
    // api-log.mjs already masked the record; this pass is the same boundary every other file goes through.
    const safe = redact(record);
    for (const key of ['session_id', 'step_id', 'test_case_id', 'evidence_id']) if (record[key] !== undefined) safe[key] = record[key];
    const line = Buffer.from(JSON.stringify(safe) + '\n', 'utf8');
    fs.writeSync(this.apiCallFd, line);
    this.apiCallIndex.push({ ...apiCallSummary(safe), offset: this.apiCallBytes, length: line.length - 1 });
    this.apiCallBytes += line.length;
    return safe;
  }
  apiCallSummaries() { return this.apiCallIndex.map(({ offset, length, ...summary }) => summary); }
  apiCall(id) {
    const entry = this.apiCallIndex.find(item => item.evidence_id === id);
    if (!entry) return null;
    const fd = fs.openSync(this.apiCallPath, 'r');
    try { const buffer = Buffer.alloc(entry.length); fs.readSync(fd, buffer, 0, entry.length, entry.offset); return JSON.parse(buffer.toString('utf8')); }
    finally { fs.closeSync(fd); }
  }
  apiCalls() {
    if (!fs.existsSync(this.apiCallPath)) return [];
    return fs.readFileSync(this.apiCallPath, 'utf8').split('\n').filter(line => line.trim()).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  appendStep(step) { fs.writeFileSync(this.stepsFd, JSON.stringify(redact(step)) + '\n'); fs.fsyncSync(this.stepsFd); }
  saveSession(session) {
    const safe = redact(session);
    if (/^S-/.test(session.session_id || '')) safe.session_id = session.session_id;
    atomicJson(path.join(this.runDir, 'session.json'), safe);
  }
  saveExpected(cases) { atomicJson(path.join(this.runDir, 'expected.json'), { cases }); }
  events() {
    this.eventsCache ??= this.db.prepare('SELECT record_json FROM events ORDER BY rowid').all().map(r => JSON.parse(r.record_json));
    return this.eventsCache.slice();
  }
  close() { if (this.closed) return; this.closed = true; fs.closeSync(this.fd); fs.closeSync(this.stepsFd); fs.closeSync(this.apiFd); fs.closeSync(this.apiCallFd); this.db.close(); }
}
