import test from "node:test";
import assert from "node:assert/strict";
import {
  AutoCallEngine,
  decideEligibility,
  decideAnsweredCallRouting,
  isWithinWorkHours,
  DEFAULT_SETTINGS,
} from "../engine.js";

test("decideEligibility: blocks closed lead or missing phone", () => {
  const settings = { ...DEFAULT_SETTINGS, enforceWorkHours: false };
  assert.equal(decideEligibility({ settings, lead: null }).ok, false);
  assert.equal(decideEligibility({ settings, lead: { closed: true, phone: "998901234567" } }).ok, false);
  assert.equal(decideEligibility({ settings, lead: { closed: false, phone: "" } }).ok, false);
});

test("decideEligibility: respects daily limits and stop-list", () => {
  const settings = { ...DEFAULT_SETTINGS, enforceWorkHours: false, maxDailyAttempts: 3 };
  const lead = { phone: "998901234567" };
  assert.equal(decideEligibility({ settings, lead, attemptsToday: 3 }).ok, false);
  assert.equal(decideEligibility({ settings, lead, attemptsToday: 2 }).ok, true);
  assert.equal(decideEligibility({ settings, lead, blacklisted: true }).ok, false);
});

test("decideAnsweredCallRouting: client answered routes strictly to assigned manager extension", () => {
  // If manager is not on shift / available, must route to duty queue, NEVER a random agent
  assert.deepEqual(decideAnsweredCallRouting({ managerAvailable: false, managerExtension: "104" }), {
    route: "duty_queue",
    reason: "manager_unavailable",
  });

  // If extension is missing, must route to duty queue
  assert.deepEqual(decideAnsweredCallRouting({ managerAvailable: true, managerExtension: "" }), {
    route: "duty_queue",
    reason: "manager_extension_missing",
  });

  // Normal flow: routes to assigned manager extension
  assert.deepEqual(decideAnsweredCallRouting({ managerAvailable: true, managerExtension: "104" }), {
    route: "bridge_manager",
  });
});

test("isWithinWorkHours: enforces window correctly", () => {
  const settings = { ...DEFAULT_SETTINGS, workHoursStart: "09:00", workHoursEnd: "21:00", enforceWorkHours: true };
  const inside = new Date("2026-10-22T10:00:00Z"); // 15:00 in Tashkent (UTC+5)
  assert.equal(isWithinWorkHours(inside, settings), true);

  const disabled = { ...settings, enforceWorkHours: false };
  assert.equal(isWithinWorkHours(new Date("2026-10-22T00:00:00Z"), disabled), true);
});

test("AutoCallEngine: manager on shift guard", async () => {
  const mockProvider = {
    info: () => ({ kind: "mock", realCalls: false }),
    start: async () => ({ externalCallId: "test-call-1" }),
    cancel: () => {},
  };

  const engine = new AutoCallEngine({
    provider: mockProvider,
    now: () => new Date("2026-10-22T10:00:00Z"),
  });
  engine.state.settings.enforceWorkHours = false;

  const mgr = engine.addManager({ name: "Muxlisa", extension: "104" });
  const lead = engine.addLead({ name: "Test Lead", phone: "998901112233", managerId: mgr.id });

  engine.enqueueLead(lead.id);
  engine.state.running = true;

  // Manager is NOT on shift -> call must NOT start
  await engine.tick();
  assert.equal(engine.state.attempts.length, 0);
  const qItem = engine.activeQueueItem(lead.id);
  assert.equal(qItem.wait, "manager_offline");

  // Manager goes ON SHIFT -> call starts immediately
  engine.setShift(mgr.id, true);
  await engine.tick();
  assert.equal(engine.state.attempts.length, 1);
  assert.equal(engine.state.attempts[0].managerId, mgr.id);
});
