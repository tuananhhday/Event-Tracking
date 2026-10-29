import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redact } from './privacy.mjs';

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
    this.db = new DatabaseSync(path.join(this.runDir, 'eventqa.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events(evidence_id TEXT PRIMARY KEY,session_id TEXT,test_case_id TEXT,step_id TEXT,captured_at TEXT,source TEXT,layer TEXT,event_name TEXT,page_url TEXT,record_json TEXT); CREATE INDEX IF NOT EXISTS event_scope ON events(test_case_id,step_id,layer,event_name);');
    this.insert = this.db.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?,?,?,?,?,?)');
    this.recover();
    this.fd = fs.openSync(this.eventPath, 'a');
    this.stepsFd = fs.openSync(this.stepPath, 'a');
  }
  recover() {
    // Never return an index row that is absent from the durable source.
    this.db.exec('DELETE FROM events');
    recoverJsonl(this.eventPath, event => this.index(event));
    const latest = new Map();
    recoverJsonl(this.stepPath, step => latest.set(step.id, step));
    this.recoveredSteps = [...latest.values()];
  }
  index(event) {
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
  appendStep(step) { fs.writeFileSync(this.stepsFd, JSON.stringify(redact(step)) + '\n'); fs.fsyncSync(this.stepsFd); }
  saveSession(session) {
    const safe = redact(session);
    if (/^S-/.test(session.session_id || '')) safe.session_id = session.session_id;
    atomicJson(path.join(this.runDir, 'session.json'), safe);
  }
  saveExpected(cases) { atomicJson(path.join(this.runDir, 'expected.json'), { cases }); }
  events() { return this.db.prepare('SELECT record_json FROM events ORDER BY rowid').all().map(r => JSON.parse(r.record_json)); }
  close() { if (this.closed) return; this.closed = true; fs.closeSync(this.fd); fs.closeSync(this.stepsFd); this.db.close(); }
}
