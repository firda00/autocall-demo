// ============================================================
//  AutoCall engine — standalone port of metasell/server/autodialer.js
//
//  Same business rules as MetaSell:
//   • call only inside working hours (Asia/Tashkent by default);
//   • client is called first, only after answer the ASSIGNED manager is bridged;
//   • one manager never gets two customers at the same time;
//   • global concurrency limit (maxConcurrentCalls);
//   • no answer / busy → retry after an interval, max N attempts per day;
//   • after N failed attempts → task for the manager ("write in Telegram");
//   • stop-list (blacklist) numbers are never called;
//   • manager must be "on shift", otherwise the client is not called.
//
//  Storage is a JSON file instead of Postgres, CRM is replaced by a local list.
// ============================================================

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TZ = process.env.AUTOCALL_TZ || "Asia/Tashkent";
export const UNSUCCESSFUL = new Set(["no_answer", "busy", "rejected", "failed", "timeout"]);
export const SUCCESS = "manager_connected";

export const DEFAULT_SETTINGS = Object.freeze({
  workHoursStart: "09:00",
  workHoursEnd: "21:00",
  enforceWorkHours: true,
  maxDailyAttempts: 3,
  retryMinutes: 1,          // MetaSell uses hours; minutes make the demo watchable
  maxConcurrentCalls: 2,
  answerRate: 0.6,          // demo provider only
  busyRate: 0.15,           // demo provider only
  attemptTimeoutMinutes: 15,
});

const uid = (p) => `${p}_${crypto.randomBytes(5).toString("hex")}`;
export const normalizePhone = (v) => String(v || "").replace(/\D/g, "").slice(-15);

export function localHour(date = new Date(), tz = TZ) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false })
    .formatToParts(date).find((x) => x.type === "hour")?.value ?? -1) % 24;
}
export function localMinutes(date = new Date(), tz = TZ) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const h = Number(parts.find((x) => x.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((x) => x.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
export function localDay(date = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function hhmm(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!m) return fallback;
  return Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2]));
}
export function isWithinWorkHours(date, settings) {
  if (!settings.enforceWorkHours) return true;
  const now = localMinutes(date);
  const start = hhmm(settings.workHoursStart, 9 * 60);
  const end = hhmm(settings.workHoursEnd, 21 * 60);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
export function nextWorkingTime(date, settings) {
  const candidate = new Date(date);
  candidate.setSeconds(0, 0);
  for (let i = 0; i < 4 * 48; i += 1) { // 48h in 15-minute steps, same as MetaSell
    if (isWithinWorkHours(candidate, settings)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 15);
  }
  return candidate;
}

// Pure eligibility check — mirrors decideAutodialEligibility() in MetaSell.
export function decideEligibility({ settings, lead, attemptsToday = 0, lastAttemptAt = null, blacklisted = false, now = new Date() }) {
  if (!lead) return { ok: false, reason: "closed_or_missing" };
  if (lead.closed) return { ok: false, reason: "closed_or_missing" };
  if (!normalizePhone(lead.phone)) return { ok: false, reason: "no_phone" };
  if (!isWithinWorkHours(now, settings)) return { ok: false, reason: "outside_working_hours" };
  if (blacklisted) return { ok: false, reason: "blacklisted" };
  if (attemptsToday >= settings.maxDailyAttempts) return { ok: false, reason: "daily_limit" };
  if (lastAttemptAt && now - new Date(lastAttemptAt) < settings.retryMinutes * 60000) return { ok: false, reason: "retry_interval" };
  return { ok: true };
}

// Mirrors decideAnsweredCallRouting(): an answered client is bridged ONLY to the
// assigned manager; otherwise the lead goes to the duty queue for the ROP.
export function decideAnsweredCallRouting({ managerAvailable, managerExtension }) {
  if (!managerAvailable) return { route: "duty_queue", reason: "manager_unavailable" };
  if (!String(managerExtension || "").trim()) return { route: "duty_queue", reason: "manager_extension_missing" };
  return { route: "bridge_manager" };
}

function emptyState() {
  return { settings: { ...DEFAULT_SETTINGS }, running: false, managers: [], leads: [], blacklist: [], queue: [], attempts: [], duty: [], tasks: [], log: [] };
}

export class AutoCallEngine extends EventEmitter {
  constructor({ provider, dataFile = null, now = () => new Date() } = {}) {
    super();
    this.provider = provider;
    this.dataFile = dataFile;
    this.now = now;
    this.state = this.#load();
    this.timer = null;
    this.ticking = false;
    // Calls that were "running" when the server stopped can't be resumed.
    for (const q of this.state.queue) if (q.state === "running") { q.state = "cancelled"; q.reason = "server_restarted"; }
    for (const a of this.state.attempts) if (!a.endedAt) { a.status = "failed"; a.stage = "ended"; a.endedAt = this.now().toISOString(); }
  }

  // ---------- persistence ----------
  #load() {
    if (!this.dataFile || !fs.existsSync(this.dataFile)) return emptyState();
    try {
      const raw = JSON.parse(fs.readFileSync(this.dataFile, "utf8"));
      return { ...emptyState(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
    } catch { return emptyState(); }
  }
  #save() {
    if (!this.dataFile) return;
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    const tmp = this.dataFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.dataFile);
  }
  #changed() { this.#save(); this.emit("change"); }
  log(level, key, params = {}) {
    this.state.log.unshift({ id: uid("log"), at: this.now().toISOString(), level, key, params });
    this.state.log.length = Math.min(this.state.log.length, 300);
  }

  // ---------- lifecycle ----------
  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => console.error("tick", e)), intervalMs);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  // ---------- helpers ----------
  manager(id) { return this.state.managers.find((m) => m.id === id) || null; }
  lead(id) { return this.state.leads.find((l) => l.id === id) || null; }
  attemptsForLead(leadId) { return this.state.attempts.filter((a) => a.leadId === leadId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  attemptsToday(leadId, now = this.now()) {
    const today = localDay(now);
    return this.attemptsForLead(leadId).filter((a) => localDay(new Date(a.startedAt)) === today);
  }
  activeQueueItem(leadId) { return this.state.queue.find((q) => q.leadId === leadId && (q.state === "queued" || q.state === "running")) || null; }
  isBlacklisted(phone) { return this.state.blacklist.includes(normalizePhone(phone)); }
  leadConnected(leadId) { return this.state.attempts.some((a) => a.leadId === leadId && a.status === SUCCESS); }

  // ---------- managers / leads / settings ----------
  addManager({ name, extension }) {
    const m = { id: uid("mgr"), name: String(name || "").trim().slice(0, 80) || "Manager", extension: String(extension || "").replace(/[^0-9*#]/g, "").slice(0, 10), onShift: false };
    this.state.managers.push(m);
    this.log("info", "manager_added", { manager: m.name });
    this.#changed();
    return m;
  }
  removeManager(id) {
    this.state.managers = this.state.managers.filter((m) => m.id !== id);
    for (const l of this.state.leads) if (l.managerId === id) l.managerId = null;
    this.#changed();
  }
  setShift(id, onShift) {
    const m = this.manager(id);
    if (!m) throw httpError(404, "manager_not_found");
    m.onShift = Boolean(onShift);
    this.log("info", m.onShift ? "shift_started" : "shift_ended", { manager: m.name });
    this.#changed();
    return m;
  }
  addLead({ name, phone, managerId }) {
    const number = normalizePhone(phone);
    if (number.length < 7) throw httpError(400, "invalid_phone");
    if (this.state.leads.some((l) => normalizePhone(l.phone) === number)) throw httpError(409, "duplicate_phone");
    const l = { id: uid("lead"), name: String(name || "").trim().slice(0, 80) || `+${number}`, phone: number, managerId: managerId && this.manager(managerId) ? managerId : (this.state.managers[0]?.id || null), closed: false, createdAt: this.now().toISOString() };
    this.state.leads.push(l);
    this.#changed();
    return l;
  }
  addLeadsBulk(text, managerId) {
    const added = [], skipped = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const phoneMatch = line.match(/\+?\d[\d\s()-]{6,}\d/);
      if (!phoneMatch) { skipped.push(line); continue; }
      const name = line.replace(phoneMatch[0], "").replace(/[,;\t|]+/g, " ").trim();
      try { added.push(this.addLead({ name, phone: phoneMatch[0], managerId })); } catch { skipped.push(line); }
    }
    return { added: added.length, skipped: skipped.length };
  }
  updateLead(id, patch) {
    const l = this.lead(id);
    if (!l) throw httpError(404, "lead_not_found");
    if ("managerId" in patch) l.managerId = patch.managerId && this.manager(patch.managerId) ? patch.managerId : null;
    if ("closed" in patch) l.closed = Boolean(patch.closed);
    if ("name" in patch) l.name = String(patch.name || "").slice(0, 80);
    this.#changed();
    return l;
  }
  removeLead(id) {
    this.state.leads = this.state.leads.filter((l) => l.id !== id);
    for (const q of this.state.queue) if (q.leadId === id && q.state === "queued") { q.state = "cancelled"; q.reason = "lead_removed"; }
    this.#changed();
  }
  updateSettings(patch = {}) {
    const s = this.state.settings;
    const int = (v, min, max, d) => Math.max(min, Math.min(max, Number.isFinite(Number(v)) ? Math.round(Number(v)) : d));
    if ("workHoursStart" in patch && /^\d{1,2}:\d{2}$/.test(patch.workHoursStart)) s.workHoursStart = patch.workHoursStart;
    if ("workHoursEnd" in patch && /^\d{1,2}:\d{2}$/.test(patch.workHoursEnd)) s.workHoursEnd = patch.workHoursEnd;
    if ("enforceWorkHours" in patch) s.enforceWorkHours = Boolean(patch.enforceWorkHours);
    if ("maxDailyAttempts" in patch) s.maxDailyAttempts = int(patch.maxDailyAttempts, 1, 10, 3);
    if ("retryMinutes" in patch) s.retryMinutes = int(patch.retryMinutes, 0, 24 * 60, 1);
    if ("maxConcurrentCalls" in patch) s.maxConcurrentCalls = int(patch.maxConcurrentCalls, 1, 20, 2);
    if ("answerRate" in patch) s.answerRate = Math.max(0, Math.min(1, Number(patch.answerRate) || 0));
    if ("busyRate" in patch) s.busyRate = Math.max(0, Math.min(1, Number(patch.busyRate) || 0));
    this.#changed();
    return s;
  }
  addBlacklist(phone) {
    const n = normalizePhone(phone);
    if (n.length < 7) throw httpError(400, "invalid_phone");
    if (!this.state.blacklist.includes(n)) this.state.blacklist.push(n);
    for (const q of this.state.queue) if (q.phone === n && q.state === "queued") { q.state = "cancelled"; q.reason = "blacklisted"; }
    this.#changed();
  }
  removeBlacklist(phone) { const n = normalizePhone(phone); this.state.blacklist = this.state.blacklist.filter((p) => p !== n); this.#changed(); }

  // ---------- queue ----------
  enqueueLead(leadId, { reason = "scheduled", dueAt = null, now = this.now() } = {}) {
    const lead = this.lead(leadId);
    const attemptsToday = this.attemptsToday(leadId, now);
    const decision = decideEligibility({
      settings: this.state.settings, lead, now,
      attemptsToday: attemptsToday.length,
      lastAttemptAt: dueAt ? null : attemptsToday[0]?.startedAt,
      blacklisted: lead ? this.isBlacklisted(lead.phone) : false,
    });
    if (!decision.ok) return { queued: false, ...decision };
    if (this.leadConnected(leadId)) return { queued: false, reason: "already_connected" };
    const existing = this.activeQueueItem(leadId);
    if (existing) return { queued: false, reason: "duplicate", queueId: existing.id };
    const item = { id: uid("q"), leadId, managerId: lead.managerId, phone: normalizePhone(lead.phone), state: "queued", dueAt: (dueAt || now).toISOString(), reason, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    this.state.queue.push(item);
    return { queued: true, queueId: item.id };
  }

  // "Start calling everyone today" — mirrors startManagerTodayAutodialer().
  startRun() {
    const now = this.now();
    const summary = { total: 0, queued: 0, alreadyQueued: 0, blocked: 0, reasons: {} };
    this.state.running = true;
    for (const lead of this.state.leads) {
      if (lead.closed || this.leadConnected(lead.id)) continue;
      summary.total += 1;
      const r = this.enqueueLead(lead.id, { reason: "run_started", now });
      if (r.queued) summary.queued += 1;
      else if (r.reason === "duplicate") summary.alreadyQueued += 1;
      else { summary.blocked += 1; summary.reasons[r.reason] = (summary.reasons[r.reason] || 0) + 1; }
    }
    this.log("success", "run_started", summary);
    this.#changed();
    setImmediate(() => this.tick().catch(() => {}));
    return summary;
  }
  stopRun() {
    this.state.running = false;
    this.log("warn", "run_stopped");
    this.#changed();
  }
  callNow(leadId) {
    const r = this.enqueueLead(leadId, { reason: "manual" });
    if (!r.queued && r.reason !== "duplicate") throw httpError(409, r.reason);
    const was = this.state.running;
    this.state.running = true;
    if (!was) this.log("info", "run_started_manual");
    this.#changed();
    setImmediate(() => this.tick().catch(() => {}));
    return r;
  }
  reset() {
    const managers = this.state.managers, leads = this.state.leads, settings = this.state.settings, blacklist = this.state.blacklist;
    for (const a of this.state.attempts) if (!a.endedAt) this.provider.cancel?.(a.externalCallId);
    this.state = { ...emptyState(), managers, leads: leads.map((l) => ({ ...l, closed: false })), settings, blacklist };
    this.log("info", "reset");
    this.#changed();
  }
  wipe() {
    for (const a of this.state.attempts) if (!a.endedAt) this.provider.cancel?.(a.externalCallId);
    this.state = emptyState();
    this.#changed();
  }

  // Dispatcher — mirrors processAutodialerQueue().
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const s = this.state.settings;
      let dirty = this.#timeoutStaleAttempts(now);
      if (!this.state.running) { if (dirty) this.#changed(); return; }
      const running = this.state.queue.filter((q) => q.state === "running").length;
      let slots = Math.max(0, s.maxConcurrentCalls - running);
      const due = this.state.queue.filter((q) => q.state === "queued" && new Date(q.dueAt) <= now)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.createdAt.localeCompare(b.createdAt));
      const plans = [];
      for (const item of due) {
        if (slots <= 0) break;
        const lead = this.lead(item.leadId);
        // Re-validate right before dialing (settings, stop-list, hours may have changed).
        const decision = decideEligibility({ settings: s, lead, now, attemptsToday: this.attemptsToday(item.leadId, now).length, blacklisted: lead ? this.isBlacklisted(lead.phone) : true });
        if (!decision.ok) {
          if (decision.reason === "outside_working_hours") {
            const next = nextWorkingTime(now, s);
            if (item.dueAt !== next.toISOString()) { item.dueAt = next.toISOString(); item.wait = "outside_working_hours"; dirty = true; }
            continue;
          }
          item.state = "cancelled"; item.reason = decision.reason; item.updatedAt = now.toISOString(); dirty = true;
          this.log("warn", "queue_cancelled", { lead: lead?.name, reason: decision.reason });
          continue;
        }
        item.managerId = lead.managerId;
        const mgr = this.manager(item.managerId);
        if (!mgr) {
          item.state = "cancelled"; item.reason = "manager_missing"; dirty = true;
          this.#toDuty(item, "manager_missing", now);
          continue;
        }
        // Manager must be on shift, otherwise the customer is NOT called.
        if (!mgr.onShift) {
          if (item.wait !== "manager_offline") { item.wait = "manager_offline"; dirty = true; this.log("warn", "manager_offline_wait", { lead: lead.name, manager: mgr.name }); }
          continue;
        }
        // One manager never gets two customers at once.
        const busy = this.state.queue.some((q) => q.state === "running" && q.managerId === mgr.id) || plans.some((p) => p.mgr.id === mgr.id);
        if (busy) { if (item.wait !== "manager_busy") { item.wait = "manager_busy"; dirty = true; } continue; }
        item.state = "running"; item.wait = null; item.updatedAt = now.toISOString();
        const attempt = { id: uid("att"), queueId: item.id, leadId: item.leadId, managerId: mgr.id, phone: item.phone, externalCallId: null, status: "started", stage: "dialing_client", startedAt: now.toISOString(), endedAt: null, talkSeconds: 0, stages: [{ stage: "dialing_client", at: now.toISOString() }] };
        this.state.attempts.push(attempt);
        plans.push({ item, attempt, mgr, lead });
        slots -= 1; dirty = true;
      }
      if (dirty) this.#changed();
      // Provider requests are sent only after all safety checks / claims.
      await Promise.allSettled(plans.map((p) => this.#startCall(p)));
    } finally { this.ticking = false; }
  }

  async #startCall({ item, attempt, mgr, lead }) {
    const attemptNo = this.attemptsToday(item.leadId).length;
    this.log("info", "call_started", { lead: lead.name, phone: maskPhone(item.phone), manager: mgr.name, attempt: attemptNo, max: this.state.settings.maxDailyAttempts });
    try {
      const started = await this.provider.start({
        attemptId: attempt.id,
        clientPhone: item.phone,
        managerExtension: mgr.extension,
        managerName: mgr.name,
        settings: this.state.settings,
        onUpdate: (u) => this.applyProviderUpdate(attempt.id, u),
      });
      attempt.externalCallId = started.externalCallId;
      this.#changed();
    } catch (e) {
      this.applyProviderUpdate(attempt.id, { status: "failed", error: String(e?.message || e).slice(0, 200) });
    }
  }

  // Called by providers. `stage` = progress, `status` = terminal result.
  applyProviderUpdate(attemptId, { stage = null, status = null, talkSeconds = null, error = null } = {}) {
    const attempt = this.state.attempts.find((a) => a.id === attemptId);
    if (!attempt || attempt.endedAt) return;
    const now = this.now();
    const lead = this.lead(attempt.leadId);
    const mgr = this.manager(attempt.managerId);
    if (stage && stage !== attempt.stage) {
      // Client answered → route only to the assigned manager (MetaSell rule).
      if (stage === "client_answered") {
        const routing = decideAnsweredCallRouting({ managerAvailable: Boolean(mgr?.onShift), managerExtension: mgr?.extension });
        if (routing.route !== "bridge_manager") {
          this.provider.cancel?.(attempt.externalCallId);
          return this.applyProviderUpdate(attemptId, { status: "manager_unavailable", error: routing.reason });
        }
      }
      attempt.stage = stage;
      attempt.stages.push({ stage, at: now.toISOString() });
      if (stage === "client_answered") this.log("info", "client_answered", { lead: lead?.name, manager: mgr?.name });
      if (stage === "manager_connected") this.log("success", "bridged", { lead: lead?.name, manager: mgr?.name });
    }
    if (!status) { this.#changed(); return; }

    attempt.status = status;
    attempt.stage = "ended";
    attempt.endedAt = now.toISOString();
    if (talkSeconds != null) attempt.talkSeconds = talkSeconds;
    if (error) attempt.error = error;
    attempt.stages.push({ stage: status, at: now.toISOString() });
    const item = this.state.queue.find((q) => q.id === attempt.queueId);
    if (item) { item.state = "completed"; item.result = status; item.updatedAt = now.toISOString(); }

    if (status === SUCCESS) {
      this.log("success", "call_success", { lead: lead?.name, manager: mgr?.name, seconds: attempt.talkSeconds });
    } else if (UNSUCCESSFUL.has(status)) {
      const failures = this.attemptsToday(attempt.leadId, now).filter((a) => UNSUCCESSFUL.has(a.status)).length;
      const max = this.state.settings.maxDailyAttempts;
      if (failures >= max) {
        this.log("warn", "attempts_exhausted", { lead: lead?.name, max });
        this.state.tasks.unshift({ id: uid("task"), leadId: attempt.leadId, managerId: attempt.managerId, at: now.toISOString(), key: "task_write_telegram", params: { max } });
      } else {
        const retryAt = nextWorkingTime(new Date(now.getTime() + this.state.settings.retryMinutes * 60000), this.state.settings);
        const r = this.enqueueLead(attempt.leadId, { reason: "retry_after_unsuccessful", dueAt: retryAt, now });
        this.log("warn", "call_failed_retry", { lead: lead?.name, status, retryAt: retryAt.toISOString(), attempt: failures, max, queued: r.queued });
      }
    } else {
      // manager_unavailable / provider_completed without bridge → duty queue for ROP.
      this.#toDuty(item || attempt, status, now);
    }
    this.#changed();
    setImmediate(() => this.tick().catch(() => {}));
  }

  #toDuty(item, reason, now) {
    const lead = this.lead(item.leadId);
    this.state.duty = this.state.duty.filter((d) => d.leadId !== item.leadId);
    this.state.duty.unshift({ id: uid("duty"), leadId: item.leadId, reason, at: now.toISOString() });
    this.log("error", "duty_queue", { lead: lead?.name, reason });
  }

  #timeoutStaleAttempts(now) {
    const limit = this.state.settings.attemptTimeoutMinutes * 60000;
    let changed = false;
    for (const a of this.state.attempts) {
      if (!a.endedAt && now - new Date(a.startedAt) > limit) {
        this.provider.cancel?.(a.externalCallId);
        setImmediate(() => this.applyProviderUpdate(a.id, { status: "timeout" }));
        changed = true;
      }
    }
    return changed;
  }

  // ---------- read model for the UI ----------
  snapshot() {
    const now = this.now();
    const s = this.state.settings;
    const leads = this.state.leads.map((l) => {
      const attempts = this.attemptsForLead(l.id);
      const today = attempts.filter((a) => localDay(new Date(a.startedAt)) === localDay(now));
      const q = this.activeQueueItem(l.id);
      const last = attempts[0] || null;
      let status = "new";
      if (l.closed) status = "closed";
      else if (attempts.some((a) => a.status === SUCCESS)) status = "connected";
      else if (q?.state === "running") status = "calling";
      else if (q?.state === "queued") status = q.wait || (q.reason === "retry_after_unsuccessful" ? "retry_scheduled" : "queued");
      else if (this.isBlacklisted(l.phone)) status = "blacklisted";
      else if (today.filter((a) => UNSUCCESSFUL.has(a.status)).length >= s.maxDailyAttempts) status = "exhausted";
      else if (this.state.duty.some((d) => d.leadId === l.id)) status = "duty_queue";
      else if (last) status = last.status;
      return { ...l, status, attemptsToday: today.length, lastResult: last?.status || null, nextCallAt: q?.state === "queued" ? q.dueAt : null, talkSeconds: attempts.find((a) => a.status === SUCCESS)?.talkSeconds || 0 };
    });
    const active = this.state.attempts.filter((a) => !a.endedAt).map((a) => ({ ...a, lead: this.lead(a.leadId), manager: this.manager(a.managerId) }));
    const recent = this.state.attempts.filter((a) => a.endedAt).sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, 12)
      .map((a) => ({ ...a, lead: this.lead(a.leadId), manager: this.manager(a.managerId) }));
    const count = (st) => leads.filter((l) => st.includes(l.status)).length;
    return {
      provider: this.provider.info(),
      tz: TZ,
      serverTime: now.toISOString(),
      withinWorkHours: isWithinWorkHours(now, s),
      settings: s,
      running: this.state.running,
      managers: this.state.managers.map((m) => ({ ...m, busy: active.some((a) => a.managerId === m.id), connectedToday: this.state.attempts.filter((a) => a.managerId === m.id && a.status === SUCCESS).length })),
      leads,
      active,
      recent,
      blacklist: this.state.blacklist,
      duty: this.state.duty.map((d) => ({ ...d, lead: this.lead(d.leadId) })),
      tasks: this.state.tasks.map((t) => ({ ...t, lead: this.lead(t.leadId), manager: this.manager(t.managerId) })),
      log: this.state.log.slice(0, 80),
      stats: {
        total: leads.length,
        queued: count(["queued", "retry_scheduled", "manager_offline", "manager_busy", "outside_working_hours"]),
        calling: active.length,
        connected: count(["connected"]),
        failed: this.state.attempts.filter((a) => UNSUCCESSFUL.has(a.status)).length,
        exhausted: count(["exhausted"]),
        attempts: this.state.attempts.length,
      },
    };
  }
}

export function maskPhone(phone) {
  const d = normalizePhone(phone);
  return d.length < 7 ? d : `+${d.slice(0, d.length - 7)} ${d.slice(-7, -4)}-**-${d.slice(-2)}`;
}
export function httpError(code, message) { const e = new Error(message); e.code = code; return e; }
