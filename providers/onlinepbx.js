// Real onlinePBX provider — ported from metasell/server/integrations/onlinepbx.js
//
// Flow: client-first manager bridge via the documented `/call/instantly.json`:
//   `from` = customer (called first), `to` = assigned manager extension.
// The result is read from `/mongo_history/search.json` by the exact call UUID
// (the authoritative source in MetaSell), polled until the call is terminal.
//
// Required env:
//   ONLINEPBX_DOMAIN=pbx12345.onpbx.ru
//   ONLINEPBX_API_KEY=...
// Optional:
//   ONLINEPBX_GATE_FROM=998xxxxxxxxx   (outbound line)
//   ONLINEPBX_DISPLAY_NAME=U-STUDY
//   ONLINEPBX_POLL_SECONDS=5

const ALLOWED_HOST = /^[a-z0-9-]+\.(onpbx\.ru|onlinepbx\.ru)$/i;
const API_HOST = "api2.onlinepbx.ru";

function safeHost(domain) {
  const host = String(domain || "").replace(/^https?:\/\//, "").split("/")[0].trim().toLowerCase();
  if (!ALLOWED_HOST.test(host)) throw new Error("invalid onlinePBX domain: " + host);
  if (host === "panel.onlinepbx.ru") throw new Error("use the PBX domain (pbx12345.onpbx.ru), not panel.onlinepbx.ru");
  return host;
}
const digits = (v) => String(v || "").replace(/\D/g, "");
function dialNumber(value, { extension = false } = {}) {
  const n = String(value || "").replace(extension ? /[^0-9*#+-]/g : /\D/g, "").slice(0, extension ? 32 : 15);
  if (!n) throw new Error(extension ? "manager extension is missing" : "client phone is missing");
  return n;
}

export function buildClientFirstManagerBridgePayload({ clientPhone, managerExtension, gateFrom = "", displayName = "" }) {
  const payload = { from: dialNumber(clientPhone), to: dialNumber(managerExtension, { extension: true }) };
  if (displayName) payload.from_orig_name = String(displayName).trim().slice(0, 80);
  if (gateFrom) payload.gate_from = dialNumber(gateFrom);
  return payload;
}

// Same classification rules as MetaSell.
export function classifyOnlinePbxBridgeHistory(record, { managerExtension = "" } = {}) {
  if (!record || typeof record !== "object") return { state: "pending", reason: "history_not_ready" };
  const expected = digits(managerExtension);
  const events = Array.isArray(record.events) ? record.events : [];
  const managerEvent = events.filter((e) => digits(e?.number ?? e?.destination_number ?? e?.to) === expected)
    .find((e) => Boolean(e?.answered_stamp || e?.answer_stamp || Number(e?.duration || 0) > 0));
  const talkSeconds = Number(record.user_talk_time ?? record.billsec ?? record.dialog_duration ?? 0) || 0;
  const contacted = record.contacted === true || record.contacted === 1 || record.contacted === "1" || talkSeconds > 0;
  const terminal = Boolean(record.end_stamp || record.hangup_cause || record.hangup_disposition || record.status === "completed"
    || managerEvent?.end_stamp || Number(managerEvent?.duration || 0) > 0);
  if (managerEvent && contacted) {
    if (!terminal) return { state: "pending", reason: "call_in_progress", bridged: true };
    return { state: "manager_connected", talkSeconds };
  }
  if (!terminal) return { state: "pending", reason: "call_in_progress" };
  const cause = String(record.hangup_cause || record.hangup_disposition || record.status || "").toLowerCase();
  if (/busy/.test(cause)) return { state: "busy" };
  if (/reject|declin/.test(cause)) return { state: "rejected" };
  if (!contacted) return { state: "no_answer" };
  return { state: "manager_unavailable", reason: "assigned_manager_not_confirmed" };
}

export function createOnlinePbxProvider(env = process.env) {
  const host = safeHost(env.ONLINEPBX_DOMAIN);
  const apiKey = String(env.ONLINEPBX_API_KEY || "");
  if (!apiKey) throw new Error("ONLINEPBX_API_KEY is missing");
  const pollMs = Math.max(2, Number(env.ONLINEPBX_POLL_SECONDS) || 5) * 1000;
  let session = null;
  const pollers = new Map();

  async function getSession() {
    if (session && session.exp > Date.now()) return session;
    const res = await fetch(`https://${API_HOST}/${host}/auth.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ auth_key: apiKey }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error("onlinePBX auth " + res.status);
    const j = await res.json();
    const data = j.data || j;
    session = { keyId: data.key_id || data.keyId, key: data.key, exp: Date.now() + 60 * 60 * 1000 };
    if (!session.key || !session.keyId) { session = null; throw new Error("onlinePBX auth: no session key"); }
    return session;
  }

  async function api(pathname, body = {}) {
    for (let i = 0; i < 2; i += 1) {
      const s = await getSession();
      const res = await fetch(`https://${API_HOST}/${host}${pathname}`, {
        method: "POST",
        headers: { "x-pbx-authentication": `${s.keyId}:${s.key}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`onlinePBX ${pathname} -> ${res.status}`);
      const result = await res.json();
      if (result?.isNotAuth !== true) return result;
      session = null;
    }
    throw new Error(`onlinePBX ${pathname}: authentication expired`);
  }

  async function fetchHistory(uuid) {
    const result = await api("/mongo_history/search.json", { uuid: String(uuid) });
    const data = result?.data;
    if (Array.isArray(data)) return data[0] || null;
    if (Array.isArray(data?.items)) return data.items[0] || null;
    if (Array.isArray(data?.records)) return data.records[0] || null;
    return data && typeof data === "object" ? data : null;
  }

  return {
    info: () => ({ kind: "onlinepbx", realCalls: true, domain: host }),

    async start({ clientPhone, managerExtension, onUpdate }) {
      const payload = buildClientFirstManagerBridgePayload({
        clientPhone, managerExtension,
        gateFrom: env.ONLINEPBX_GATE_FROM || "",
        displayName: env.ONLINEPBX_DISPLAY_NAME || "",
      });
      const result = await api("/call/instantly.json", payload);
      if (String(result?.status ?? "") !== "1") throw new Error("onlinepbx_call_start_rejected");
      const uuid = String(result?.data?.uuid || result?.data?.call_uuid || result?.data?.id || result?.uuid || "").slice(0, 160);
      if (!uuid) throw new Error("onlinepbx_call_start_missing_uuid");

      let bridgedSent = false;
      const timer = setInterval(async () => {
        try {
          const verdict = classifyOnlinePbxBridgeHistory(await fetchHistory(uuid), { managerExtension });
          if (verdict.state === "pending") {
            if (verdict.bridged && !bridgedSent) { bridgedSent = true; onUpdate({ stage: "client_answered" }); onUpdate({ stage: "manager_connected" }); }
            return;
          }
          clearInterval(timer); pollers.delete(uuid);
          if (verdict.state === "manager_connected" && !bridgedSent) { onUpdate({ stage: "client_answered" }); onUpdate({ stage: "manager_connected" }); }
          onUpdate({ status: verdict.state, talkSeconds: verdict.talkSeconds ?? null, error: verdict.reason || null });
        } catch (e) {
          console.error("[onlinepbx] history poll failed:", e.message);
        }
      }, pollMs);
      pollers.set(uuid, timer);
      return { externalCallId: uuid };
    },

    cancel(uuid) { clearInterval(pollers.get(uuid)); pollers.delete(uuid); },
  };
}
