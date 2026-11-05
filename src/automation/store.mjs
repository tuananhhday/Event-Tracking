import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateWorkflow } from './schema.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Không đọc được dữ liệu luồng ${path.basename(file)}: ${error.message}`);
  }
}
async function atomicJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class WorkflowStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.workflows = [];
    this.runs = [];
    this.scheduledDates = {};
    this.writes = Promise.resolve();
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    const [config, history] = await Promise.all([
      readJson(path.join(this.directory, 'workflows.json'), { workflows: [] }),
      readJson(path.join(this.directory, 'history.json'), { runs: [], scheduled_dates: {} }),
    ]);
    if (!Array.isArray(config?.workflows) || !Array.isArray(history?.runs) || !history.scheduled_dates || typeof history.scheduled_dates !== 'object' || Array.isArray(history.scheduled_dates)) throw new Error('Dữ liệu lưu luồng hoặc lịch sử không đúng cấu trúc.');
    if (!Object.entries(history.scheduled_dates).every(([id, date]) => validId(id) && validDate(date))) throw new Error('Mã luồng hoặc ngày chống chạy trùng trong lịch sử không hợp lệ.');
    const workflows = config.workflows.map(validateWorkflow);
    if (workflows.some(item => !item.id) || new Set(workflows.map(item => item.id)).size !== workflows.length) throw new Error('Mã luồng đã lưu bị thiếu hoặc trùng.');
    this.workflows = workflows;
    this.runs = history.runs;
    this.scheduledDates = history.scheduled_dates;
    return this;
  }
  list() { return structuredClone(this.workflows); }
  get(id) { const workflow = this.workflows.find(item => item.id === id); return workflow ? structuredClone(workflow) : undefined; }
  history(limit = 30) { return structuredClone(this.runs.slice(0, Math.max(0, Math.floor(Number(limit) || 0)))); }
  queued(write) {
    const task = this.writes.then(write);
    this.writes = task.catch(() => {});
    return task;
  }
  async save(workflow) {
    return (await this.saveMany([workflow]))[0];
  }
  async saveMany(workflows) {
    if (!Array.isArray(workflows) || !workflows.length || workflows.length > 10) throw new Error('Lưu từ 1 đến 10 luồng mỗi lần.');
    const saved = workflows.map(input => { const workflow = validateWorkflow(input); workflow.id ??= `WF-${randomUUID()}`; return workflow; });
    if (new Set(saved.map(workflow => workflow.id)).size !== saved.length) throw new Error('Mã luồng trong danh sách bị trùng.');
    return this.queued(async () => {
      const next = this.list();
      for (const workflow of saved) {
        const index = next.findIndex(item => item.id === workflow.id);
        if (index === -1) next.push(workflow); else next[index] = workflow;
      }
      await atomicJson(path.join(this.directory, 'workflows.json'), { schema_version: '1.0', workflows: next });
      this.workflows = next;
      return structuredClone(saved);
    });
  }
  async delete(id) {
    return this.queued(async () => {
      const next = this.workflows.filter(item => item.id !== id);
      if (next.length === this.workflows.length) return false;
      await atomicJson(path.join(this.directory, 'workflows.json'), { schema_version: '1.0', workflows: next });
      this.workflows = next;
      return true;
    });
  }
  async recordRun(summary) {
    const record = structuredClone(summary);
    return this.queued(async () => {
      const runs = [record, ...this.runs];
      await atomicJson(path.join(this.directory, 'history.json'), { schema_version: '1.0', runs, scheduled_dates: this.scheduledDates });
      this.runs = runs;
      return structuredClone(record);
    });
  }
  getLastScheduledDate(id) { return Object.hasOwn(this.scheduledDates, id) ? this.scheduledDates[id] : undefined; }
  async recordScheduledDate(id, date) {
    if (!validId(id)) throw new Error('Mã luồng chạy lịch không hợp lệ.');
    if (!validDate(date)) throw new Error('Ngày chạy lịch phải là ngày hợp lệ dạng YYYY-MM-DD.');
    return this.queued(async () => {
      const dates = { ...this.scheduledDates, [id]: date };
      await atomicJson(path.join(this.directory, 'history.json'), { schema_version: '1.0', runs: this.runs, scheduled_dates: dates });
      this.scheduledDates = dates;
    });
  }
}
