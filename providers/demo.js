// Demo telephony provider — simulates a real client-first call so the
// AutoCall feature can be shown without a PBX and without calling anyone.
//
//   dialing_client → client_answered → manager_ringing → manager_connected → hang-up
//                  ↘ no_answer / busy
//
// Deterministic test numbers (handy for a live demo):
//   ...00  → always "no answer"
//   ...99  → always "busy"
//   ...77  → always answers

import crypto from "node:crypto";

const rand = (min, max) => min + Math.random() * (max - min);

export function createDemoProvider() {
  const calls = new Map(); // externalCallId -> timers[]

  function schedule(id, ms, fn) {
    const t = setTimeout(() => { if (calls.has(id)) fn(); }, ms);
    calls.get(id).push(t);
  }

  return {
    info: () => ({ kind: "demo", realCalls: false }),

    async start({ clientPhone, settings, onUpdate }) {
      const id = "demo-" + crypto.randomBytes(6).toString("hex");
      calls.set(id, []);
      const tail = String(clientPhone).slice(-2);
      const roll = Math.random();
      let outcome;
      if (tail === "00") outcome = "no_answer";
      else if (tail === "99") outcome = "busy";
      else if (tail === "77") outcome = "answer";
      else if (roll < settings.answerRate) outcome = "answer";
      else if (roll < settings.answerRate + settings.busyRate) outcome = "busy";
      else outcome = "no_answer";

      const ring = rand(2500, 4500);
      const finish = (payload) => { calls.delete(id); onUpdate(payload); };

      if (outcome === "busy") {
        schedule(id, rand(1500, 2500), () => finish({ status: "busy" }));
      } else if (outcome === "no_answer") {
        schedule(id, ring + rand(3000, 5000), () => finish({ status: "no_answer" }));
      } else {
        const talk = Math.round(rand(6, 14));
        schedule(id, ring, () => onUpdate({ stage: "client_answered" }));
        schedule(id, ring + 900, () => onUpdate({ stage: "manager_ringing" }));
        schedule(id, ring + 2400, () => onUpdate({ stage: "manager_connected" }));
        schedule(id, ring + 2400 + talk * 1000, () => finish({ status: "manager_connected", talkSeconds: talk }));
      }
      return { externalCallId: id };
    },

    cancel(id) {
      for (const t of calls.get(id) || []) clearTimeout(t);
      calls.delete(id);
    },
  };
}
