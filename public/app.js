// AutoCall Frontend Client (Real-time SSE Dashboard)
let currentState = null;

// Clock in Tashkent
function updateClock() {
  const now = new Date();
  const timeStr = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Tashkent",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);
  const el = document.getElementById("clock");
  if (el) el.textContent = timeStr;
}
setInterval(updateClock, 1000);
updateClock();

// Connect SSE
function connectSSE() {
  const es = new EventSource("/api/events");

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      currentState = data;
      render(data);
    } catch (e) {
      console.error("SSE parse error", e);
    }
  };

  es.onerror = () => {
    console.warn("SSE disconnected, retrying in 3s...");
    es.close();
    setTimeout(connectSSE, 3000);
  };
}
connectSSE();

// API Helper
async function api(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`Ошибка: ${data.error || res.statusText}`);
      throw new Error(data.error);
    }
    return data;
  } catch (err) {
    console.error("API error", err);
  }
}

// Global actions
async function toggleRun() {
  if (!currentState) return;
  if (currentState.running) {
    await api("/api/run/stop", { method: "POST" });
  } else {
    await api("/api/run/start", { method: "POST" });
  }
}

async function seedSampleData() {
  if (confirm("Сбросить базу и заново загрузить демо-лиды и менеджеров?")) {
    await api("/api/demo/seed", { method: "POST" });
  }
}

async function toggleShift(managerId, currentShift) {
  await api(`/api/managers/${managerId}/shift`, {
    method: "POST",
    body: JSON.stringify({ onShift: !currentShift }),
  });
}

async function callLead(leadId) {
  await api(`/api/leads/${leadId}/call`, { method: "POST" });
}

async function saveSettings() {
  const start = document.getElementById("setStart").value;
  const end = document.getElementById("setEnd").value;
  const enforce = document.getElementById("setEnforceHours").checked;
  const concurrent = Number(document.getElementById("setMaxConcurrent").value);
  const maxDaily = Number(document.getElementById("setMaxDaily").value);
  const retryMin = Number(document.getElementById("setRetryMinutes").value);

  await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      workHoursStart: start,
      workHoursEnd: end,
      enforceWorkHours: enforce,
      maxConcurrentCalls: concurrent,
      maxDailyAttempts: maxDaily,
      retryMinutes: retryMin,
    }),
  });
  alert("Параметры безопасности успешно обновлены!");
}

// Modal handling
function openAddManagerModal() {
  document.getElementById("managerModal").classList.remove("hidden");
}
function openAddLeadModal() {
  const select = document.getElementById("leadManagerSelect");
  select.innerHTML = (currentState?.managers || [])
    .map((m) => `<option value="${m.id}">${m.name} (Ext ${m.extension})</option>`)
    .join("");
  document.getElementById("leadModal").classList.remove("hidden");
}
function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

async function submitAddManager() {
  const name = document.getElementById("mgrName").value.trim();
  const extension = document.getElementById("mgrExt").value.trim();
  if (!name || !extension) return alert("Заполните имя и номер");
  await api("/api/managers", {
    method: "POST",
    body: JSON.stringify({ name, extension }),
  });
  closeModal("managerModal");
  document.getElementById("mgrName").value = "";
  document.getElementById("mgrExt").value = "";
}

async function submitAddLead() {
  const name = document.getElementById("leadName").value.trim();
  const phone = document.getElementById("leadPhone").value.trim();
  const managerId = document.getElementById("leadManagerSelect").value;
  if (!phone) return alert("Укажите номер телефона");
  await api("/api/leads", {
    method: "POST",
    body: JSON.stringify({ name, phone, managerId }),
  });
  closeModal("leadModal");
  document.getElementById("leadName").value = "";
  document.getElementById("leadPhone").value = "";
}

// UI Status Badge Helper
function getStatusBadge(status) {
  switch (status) {
    case "connected":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Разговор состоялся</span>';
    case "calling":
      return '<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>Идет звонок...</span>';
    case "queued":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">В очереди</span>';
    case "retry_scheduled":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">Повтор через 1 мин</span>';
    case "manager_offline":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">Менеджер не на смене</span>';
    case "manager_busy":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20">Менеджер на линии</span>';
    case "exhausted":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">Лимит попыток (Telegram)</span>';
    case "no_answer":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-800 text-slate-400">Не ответил</span>';
    case "busy":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-800 text-slate-400">Занято</span>';
    case "outside_working_hours":
      return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-800 text-slate-400">Вне рабочих часов</span>';
    default:
      return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-800 text-slate-400">${status}</span>`;
  }
}

// Log formatter
function formatLogEntry(l) {
  let color = "text-slate-400";
  let icon = "•";
  if (l.level === "success") { color = "text-emerald-400"; icon = "✓"; }
  if (l.level === "warn") { color = "text-amber-400"; icon = "⚠"; }
  if (l.level === "error") { color = "text-rose-400"; icon = "✕"; }

  const time = l.at ? l.at.slice(11, 19) : "";
  let text = l.key;
  if (l.key === "call_started") text = `Набор клиента: ${l.params.lead} (${l.params.phone}) → Менеджер: ${l.params.manager} (Попытка ${l.params.attempt}/${l.params.max})`;
  else if (l.key === "client_answered") text = `⚡ Клиент ${l.params.lead} ответил! Идет моментальный мост на менеджера ${l.params.manager}...`;
  else if (l.key === "bridged") text = `🎧 СОЕДИНЕНО! Менеджер ${l.params.manager} говорит с ${l.params.lead}`;
  else if (l.key === "call_success") text = `🎉 Звонок завершен успешно: ${l.params.lead} (${l.params.seconds} сек)`;
  else if (l.key === "call_failed_retry") text = `Недозвон (${l.params.status}): запланирован повторный звонок ${l.params.lead}`;
  else if (l.key === "attempts_exhausted") text = `⚠️ Лимит исчерпан: задача по ${l.params.lead} передана в Telegram`;
  else if (l.key === "manager_offline_wait") text = `Ожидание: менеджер ${l.params.manager} не на смене — клиент ${l.params.lead} не набирается!`;
  else if (l.key === "shift_started") text = `Менеджер ${l.params.manager} вышел на смену`;
  else if (l.key === "shift_ended") text = `Менеджер ${l.params.manager} завершил смену`;
  else if (l.key === "run_started") text = `Автообзвон запущен: в очереди ${l.params.queued} лидов`;
  else if (l.key === "run_stopped") text = `Автообзвон приостановлен`;

  return `<div class="flex items-start gap-2 ${color}"><span class="text-slate-600 select-none">${time}</span><span class="font-bold select-none">${icon}</span><span>${text}</span></div>`;
}

// Master Render Function
function render(data) {
  // Provider Badge
  const pBadge = document.getElementById("providerBadge");
  if (pBadge && data.provider) {
    if (data.provider.realCalls) {
      pBadge.textContent = `OnlinePBX (${data.provider.domain}) — ЖИВЫЕ ЗВОНКИ`;
      pBadge.className = "text-[11px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/30 font-bold";
    } else {
      pBadge.textContent = "Demo Simulation (Без реальных звонков)";
      pBadge.className = "text-[11px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
    }
  }

  // Run Toggle Button
  const runBtn = document.getElementById("runToggleBtn");
  const runText = document.getElementById("runBtnText");
  const runIcon = document.getElementById("runBtnIcon");
  if (data.running) {
    runBtn.className = "text-xs font-bold px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/30 transition flex items-center gap-2";
    runText.textContent = "Остановить обзвон";
    runIcon.textContent = "⏹";
  } else {
    runBtn.className = "text-xs font-bold px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition flex items-center gap-2";
    runText.textContent = "Запустить обзвон";
    runIcon.textContent = "▶";
  }

  // Key Stats
  document.getElementById("statTotal").textContent = data.stats.total;
  document.getElementById("statQueued").textContent = data.stats.queued;
  document.getElementById("statCalling").textContent = data.stats.calling;
  document.getElementById("statConnected").textContent = data.stats.connected;
  document.getElementById("statFailed").textContent = data.stats.failed;
  document.getElementById("statExhausted").textContent = data.stats.exhausted;

  // Live Calls Section
  const liveSec = document.getElementById("liveCallsSection");
  const liveGrid = document.getElementById("liveCallsGrid");
  if (data.active && data.active.length > 0) {
    liveSec.classList.remove("hidden");
    liveGrid.innerHTML = data.active.map((a) => {
      const isClientAnswered = a.stage === "client_answered" || a.stage === "manager_ringing" || a.stage === "manager_connected";
      const isManagerConnected = a.stage === "manager_connected";

      return `
        <div class="bg-gradient-to-br from-slate-900 to-indigo-950/40 border border-indigo-500/30 rounded-2xl p-5 shadow-xl relative overflow-hidden">
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
              <span class="font-bold text-sm text-white">Активная линия</span>
            </div>
            <span class="font-mono text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              ${a.stage}
            </span>
          </div>

          <!-- Animated Bridge Track -->
          <div class="relative py-2">
            <div class="flex items-center justify-between relative z-10">
              <!-- Client Side -->
              <div class="flex flex-col items-center">
                <div class="w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg ${isClientAnswered ? 'bg-emerald-600 text-white shadow-emerald-500/30' : 'bg-amber-600 text-white animate-pulse shadow-amber-500/30'}">
                  📱
                </div>
                <span class="font-bold text-xs text-white mt-2">${a.lead?.name || 'Клиент'}</span>
                <span class="font-mono text-[11px] text-slate-400">+${a.phone}</span>
                <span class="text-[10px] ${isClientAnswered ? 'text-emerald-400 font-semibold' : 'text-amber-400 animate-pulse'} mt-0.5">
                  ${isClientAnswered ? 'Трубка поднята' : 'Идет гудок...'}
                </span>
              </div>

              <!-- Bridge Pipe Animation -->
              <div class="flex-1 mx-4 flex flex-col items-center">
                <span class="text-[10px] uppercase tracking-wider font-bold mb-1 ${isManagerConnected ? 'text-emerald-400' : 'text-indigo-400'}">
                  ${isManagerConnected ? 'Мост активен (Разговор)' : 'Client-First Bridge'}
                </span>
                <div class="w-full h-1.5 bg-slate-800 rounded-full relative overflow-hidden">
                  <div class="absolute inset-y-0 bg-gradient-to-r from-emerald-500 to-indigo-500 rounded-full ${isManagerConnected ? 'w-full' : 'w-1/2 animate-pulse'}"></div>
                </div>
                ${isManagerConnected ? `
                  <div class="flex items-center gap-1 mt-2">
                    <span class="audio-bar w-1 bg-emerald-400 rounded-full"></span>
                    <span class="audio-bar w-1 bg-emerald-400 rounded-full"></span>
                    <span class="audio-bar w-1 bg-emerald-400 rounded-full"></span>
                    <span class="audio-bar w-1 bg-emerald-400 rounded-full"></span>
                    <span class="audio-bar w-1 bg-emerald-400 rounded-full"></span>
                  </div>
                ` : ''}
              </div>

              <!-- Manager Side -->
              <div class="flex flex-col items-center">
                <div class="w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg ${isManagerConnected ? 'bg-emerald-600 text-white shadow-emerald-500/30' : isClientAnswered ? 'bg-indigo-600 text-white animate-pulse shadow-indigo-500/30' : 'bg-slate-800 text-slate-500'}">
                  🎧
                </div>
                <span class="font-bold text-xs text-white mt-2">${a.manager?.name || 'Менеджер'}</span>
                <span class="font-mono text-[11px] text-slate-400">Ext ${a.manager?.extension || ''}</span>
                <span class="text-[10px] ${isManagerConnected ? 'text-emerald-400 font-semibold' : isClientAnswered ? 'text-indigo-400 animate-pulse' : 'text-slate-500'} mt-0.5">
                  ${isManagerConnected ? 'На связи с клиентом' : isClientAnswered ? 'Звонок на ATS...' : 'Ожидает клиента'}
                </span>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");
  } else {
    liveSec.classList.add("hidden");
  }

  // Managers List
  const mgrList = document.getElementById("managersList");
  mgrList.innerHTML = (data.managers || []).map((m) => `
    <div class="p-3.5 rounded-xl border ${m.onShift ? 'bg-slate-800/80 border-emerald-500/30' : 'bg-slate-900/60 border-slate-800 opacity-75'} flex items-center justify-between transition">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center text-lg ${m.onShift ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-800 text-slate-500'}">
          👤
        </div>
        <div>
          <div class="flex items-center gap-2">
            <span class="font-bold text-xs text-white">${m.name}</span>
            <span class="font-mono text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">Ext ${m.extension}</span>
          </div>
          <div class="text-[11px] mt-0.5 flex items-center gap-2">
            <span class="${m.onShift ? 'text-emerald-400 font-medium' : 'text-slate-500'}">
              ${m.onShift ? '● На смене' : '○ Не на смене'}
            </span>
            ${m.busy ? '<span class="text-amber-400 font-semibold">(На линии)</span>' : ''}
            <span class="text-slate-500">| Успешно: ${m.connectedToday || 0}</span>
          </div>
        </div>
      </div>
      <button onclick="toggleShift('${m.id}', ${m.onShift})" class="text-xs px-2.5 py-1.5 rounded-lg font-semibold transition ${m.onShift ? 'bg-slate-800 hover:bg-slate-700 text-rose-400 border border-slate-700' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}">
        ${m.onShift ? 'Снять' : 'На смену'}
      </button>
    </div>
  `).join("");

  // Leads Table
  const leadsBody = document.getElementById("leadsTableBody");
  leadsBody.innerHTML = (data.leads || []).map((l) => {
    const mgr = data.managers.find((m) => m.id === l.managerId);
    return `
      <tr class="hover:bg-slate-900/40 transition">
        <td class="py-2.5 px-3 font-semibold text-white">${l.name}</td>
        <td class="py-2.5 px-3 font-mono text-slate-300">+${l.phone}</td>
        <td class="py-2.5 px-3 text-slate-400">
          ${mgr ? `<span class="inline-flex items-center gap-1">${mgr.name} <span class="text-[10px] font-mono text-slate-500">(${mgr.extension})</span></span>` : '<span class="text-rose-400">Не назначен</span>'}
        </td>
        <td class="py-2.5 px-3">${getStatusBadge(l.status)}</td>
        <td class="py-2.5 px-3 font-mono text-slate-400">${l.attemptsToday || 0}</td>
        <td class="py-2.5 px-3 text-right">
          <button onclick="callLead('${l.id}')" class="text-[11px] px-2.5 py-1 rounded bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 font-semibold border border-indigo-500/30 transition">
            📞 Набрать
          </button>
        </td>
      </tr>
    `;
  }).join("");

  // Tasks (Telegram hand-off)
  const taskCountBadge = document.getElementById("taskCountBadge");
  const tasksList = document.getElementById("tasksList");
  if (taskCountBadge) taskCountBadge.textContent = (data.tasks || []).length;
  if (tasksList) {
    if (!data.tasks || data.tasks.length === 0) {
      tasksList.innerHTML = '<div class="text-xs text-slate-500 italic text-center py-2">Нет лидов, исчерпавших попытки</div>';
    } else {
      tasksList.innerHTML = data.tasks.map((t) => `
        <div class="p-2.5 rounded-xl bg-purple-950/20 border border-purple-500/20 flex items-center justify-between text-xs">
          <div>
            <div class="font-bold text-purple-200">${t.lead?.name || 'Клиент'} (+${t.lead?.phone})</div>
            <div class="text-[11px] text-purple-400 mt-0.5">3 звонка без ответа ➔ Задача: Написать в Telegram</div>
          </div>
          <span class="text-[10px] text-slate-500 font-mono">${t.at ? t.at.slice(11, 16) : ''}</span>
        </div>
      `).join("");
    }
  }

  // Logs Console
  const logConsole = document.getElementById("logConsole");
  if (logConsole && data.log) {
    logConsole.innerHTML = data.log.map(formatLogEntry).join("");
  }

  // Populate settings form initially if not touched
  if (!window._settingsLoaded && data.settings) {
    window._settingsLoaded = true;
    document.getElementById("setStart").value = data.settings.workHoursStart;
    document.getElementById("setEnd").value = data.settings.workHoursEnd;
    document.getElementById("setEnforceHours").checked = data.settings.enforceWorkHours;
    document.getElementById("setMaxConcurrent").value = data.settings.maxConcurrentCalls;
    document.getElementById("setMaxDaily").value = data.settings.maxDailyAttempts;
    document.getElementById("setRetryMinutes").value = data.settings.retryMinutes;
  }
}
