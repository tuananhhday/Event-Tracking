const timezone = 'Asia/Ho_Chi_Minh';
const clock = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function calendar(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('Thời điểm kiểm tra lịch không hợp lệ.');
  const parts = Object.fromEntries(clock.formatToParts(date).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { day, time: `${parts.hour}:${parts.minute}`, weekday: new Date(`${day}T00:00:00Z`).getUTCDay() };
}

export class DailyScheduler {
  constructor({ getWorkflows, enqueue, now = () => new Date(), intervalMs = 30000, getLastScheduledDate, recordScheduledDate, onError = () => {} }) {
    if (typeof getWorkflows !== 'function' || typeof enqueue !== 'function') throw new Error('Bộ lập lịch cần hàm lấy luồng và đưa vào hàng đợi.');
    this.getWorkflows = getWorkflows;
    this.enqueue = enqueue;
    this.now = now;
    this.intervalMs = intervalMs;
    this.getLastScheduledDate = getLastScheduledDate;
    this.recordScheduledDate = recordScheduledDate;
    this.onError = onError;
    this.lastScheduled = new Map();
    this.timer = null;
    this.pending = null;
    this.generation = 0;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(error => this.onError(error)); }, this.intervalMs);
    this.timer.unref?.();
    this.tick().catch(error => this.onError(error));
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.generation++; }
  async tick(date = this.now()) {
    if (this.pending) return this.pending;
    const task = this.check(date, this.generation);
    this.pending = task;
    try { return await task; }
    finally { if (this.pending === task) this.pending = null; }
  }
  async check(date, generation) {
    const current = calendar(date), groups = new Map();
    for (const workflow of await this.getWorkflows()) {
      const schedule = workflow.schedule;
      if (!workflow.id || schedule?.enabled !== true || schedule.timezone !== timezone || !Array.isArray(schedule.days) || !schedule.days.includes(current.weekday) || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(schedule.time) || current.time < schedule.time) continue;
      const last = this.lastScheduled.get(workflow.id) ?? await this.getLastScheduledDate?.(workflow.id);
      if (last === current.day) continue;
      const browser = workflow.browser ?? 'chrome', ids = groups.get(browser) ?? [];
      ids.push(workflow.id); groups.set(browser, ids);
    }
    const accepted = [];
    // Each browser uses its own session. Declined groups retry on the next tick.
    for (const [browser, workflowIds] of groups) {
      // The controller accepts at most 50 workflows in one browser session.
      for (let offset = 0; offset < workflowIds.length; offset += 50) {
        if (generation !== this.generation) return accepted;
        const ids = workflowIds.slice(offset, offset + 50);
        const response = await this.enqueue(ids, { trigger: 'schedule', scheduled_date: current.day, timezone, browser });
        if (response?.accepted === false) continue;
        for (const id of ids) this.lastScheduled.set(id, current.day);
        for (const id of ids) await this.recordScheduledDate?.(id, current.day);
        accepted.push(...ids);
      }
    }
    return accepted;
  }
}
