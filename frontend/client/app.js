const API_BASE = "http://localhost:8000";

// JWT expiry check
function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now();
  } catch { return true; }
}

// Auth guard
const _token = localStorage.getItem("user_token");
const _username = localStorage.getItem("user_username");
if (!_token || !_username || isTokenExpired(_token)) {
  localStorage.removeItem("user_token");
  localStorage.removeItem("user_username");
  window.location.href = "./login.html";
}

// DOM refs
const officeSelect        = document.getElementById("office-select");
const floorSelect         = document.getElementById("floor-select");
const desksContainer      = document.getElementById("desks");
const messages            = document.getElementById("messages");
const refreshButton       = document.getElementById("refresh");
const refreshBookings     = document.getElementById("refresh-bookings");
const apiStatus           = document.getElementById("api-status");
const policyList          = document.getElementById("policy-list");
const policiesCard        = document.getElementById("policies-card");
const floorPlanCard       = document.getElementById("floor-plan-card");
const floorPlanImage      = document.getElementById("floor-plan-image");
const floorPlanCaption    = document.getElementById("floor-plan-caption");
const floorPlanOverlay    = document.getElementById("floor-plan-overlay");
const userInput           = document.getElementById("user-id");
const dateInput           = document.getElementById("reservation-date");
const startInput          = document.getElementById("start-time");
const endInput            = document.getElementById("end-time");
const myBookingsContainer = document.getElementById("my-bookings");
const deskTemplate        = document.getElementById("desk-card-template");
const loggedAsEl          = document.getElementById("logged-as");
const logoutBtn           = document.getElementById("logout-btn");

const state = {
  offices: [],
  floors: [],
  desks: [],
  availability: new Map(),
  policies: [],
};

// Init user info
userInput.value = _username;
loggedAsEl.textContent = _username;
dateInput.value = new Date().toISOString().slice(0, 10);

function getToken() {
  return localStorage.getItem("user_token");
}

function addMessage(text, type = "info") {
  const item = document.createElement("div");
  item.className = `message ${type}`;
  item.textContent = text;
  messages.prepend(item);
  setTimeout(() => item.remove(), 6000);
}

function setApiStatus(ok) {
  apiStatus.textContent = ok ? "API: ✓" : "API: недоступно";
  apiStatus.style.background = ok ? "var(--success-bg)" : "var(--danger-bg)";
  apiStatus.style.color = ok ? "var(--success-text)" : "var(--danger-text)";
  apiStatus.style.border = `1px solid ${ok ? "#86efac" : "#fca5a5"}`;
}

async function apiRequest(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Ошибка ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function checkApi() {
  try {
    await apiRequest("/health");
    setApiStatus(true);
  } catch {
    setApiStatus(false);
    addMessage("API недоступно. Проверьте соединение.", "error");
  }
}

async function loadOffices() {
  officeSelect.innerHTML = '<option value="">Выберите офис</option>';
  try {
    state.offices = await apiRequest("/offices");
    for (const o of state.offices) {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.address ? `${o.name} — ${o.address}` : o.name;
      officeSelect.append(opt);
    }
  } catch (e) {
    addMessage(`Офисы: ${e.message}`, "error");
  }
}

async function loadFloors(officeId) {
  floorSelect.innerHTML = '<option value="">Выберите этаж</option>';
  floorSelect.disabled = true;
  desksContainer.innerHTML = '<p class="empty">Выберите этаж</p>';
  floorPlanCard.style.display = "none";
  if (!officeId) return;
  try {
    state.floors = await apiRequest(`/floors?office_id=${officeId}`);
    for (const f of state.floors) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.plan_url ? `${f.name} ✦` : f.name;
      floorSelect.append(opt);
    }
    floorSelect.disabled = false;
  } catch (e) {
    addMessage(`Этажи: ${e.message}`, "error");
  }
}

async function loadPolicies(officeId) {
  policiesCard.style.display = "none";
  policyList.innerHTML = "";
  if (!officeId) return;
  try {
    state.policies = await apiRequest(`/policies?office_id=${officeId}`);
    if (state.policies.length) {
      renderPolicies();
      policiesCard.style.display = "";
    }
  } catch (e) {
    addMessage(`Политики: ${e.message}`, "error");
  }
}

async function loadDesks(floorId) {
  if (!floorId) {
    desksContainer.innerHTML = '<p class="empty">Выберите этаж</p>';
    return;
  }
  desksContainer.innerHTML = '<p class="empty">Загрузка...</p>';
  try {
    state.desks = await apiRequest(`/desks?floor_id=${floorId}`);
    await refreshAvailability();
  } catch (e) {
    addMessage(`Места: ${e.message}`, "error");
    desksContainer.innerHTML = '<p class="empty">Ошибка загрузки мест</p>';
  }
}

async function refreshAvailability() {
  const rd = dateInput.value;
  const st = startInput.value;
  const et = endInput.value;
  if (!rd || !st || !et) {
    addMessage("Заполните дату и время.", "error");
    return;
  }
  state.availability.clear();
  await Promise.all(
    state.desks.map(async (desk) => {
      const qs = new URLSearchParams({
        desk_id: String(desk.id),
        reservation_date: rd,
        start_time: st,
        end_time: et,
      });
      const uid = userInput.value.trim();
      if (uid) qs.append("user_id", uid);
      try {
        const result = await apiRequest(`/availability?${qs}`);
        state.availability.set(desk.id, result);
      } catch (e) {
        state.availability.set(desk.id, { available: false, reason: e.message });
      }
    })
  );
  renderDesks();
}

async function loadMyBookings() {
  try {
    const all = await apiRequest("/reservations");
    const mine = all.filter(
      (r) => r.user_id === userInput.value && r.status === "active"
    );
    renderMyBookings(mine);
  } catch (e) {
    addMessage(`Бронирования: ${e.message}`, "error");
  }
}

async function cancelBooking(id) {
  if (!confirm("Отменить бронирование?")) return;
  try {
    await apiRequest(`/reservations/${id}/cancel`, { method: "POST" });
    addMessage("Бронирование отменено.", "success");
    await loadMyBookings();
    if (floorSelect.value) await refreshAvailability();
  } catch (e) {
    addMessage(`Ошибка: ${e.message}`, "error");
  }
}

async function reserveDesk(deskId) {
  const userId = userInput.value.trim();
  if (!userId) {
    addMessage("Войдите в систему.", "error");
    return;
  }
  try {
    await apiRequest("/reservations", {
      method: "POST",
      body: JSON.stringify({
        desk_id: deskId,
        user_id: userId,
        reservation_date: dateInput.value,
        start_time: startInput.value,
        end_time: endInput.value,
      }),
    });
    addMessage("Бронь создана!", "success");
    await refreshAvailability();
    await loadMyBookings();
  } catch (e) {
    addMessage(`Ошибка: ${e.message}`, "error");
  }
}

function renderPolicies() {
  policyList.innerHTML = "";
  for (const p of state.policies) {
    const card = document.createElement("div");
    card.className = "policy-card";
    card.innerHTML = `
      <h3>${p.name}</h3>
      <div class="policy-details">
        <div>Заранее: ${p.min_days_ahead}–${p.max_days_ahead} дней</div>
        <div>Длительность: ${p.min_duration_minutes ?? "—"}–${p.max_duration_minutes ?? "—"} мин</div>
        <div>No-show таймаут: ${p.no_show_timeout_minutes} мин</div>
      </div>`;
    policyList.append(card);
  }
}

function renderFloorPlan(floor) {
  if (!floor?.plan_url) {
    floorPlanCard.style.display = "none";
    return;
  }
  floorPlanImage.src = floor.plan_url;
  floorPlanCaption.textContent = floor.name;
  floorPlanCard.style.display = "";
  renderPlanMarkers(floorPlanOverlay, state.desks);
}

function renderPlanMarkers(container, desks) {
  if (!container) return;
  container.innerHTML = "";
  desks
    .filter(
      (d) =>
        typeof d.position_x === "number" && typeof d.position_y === "number"
    )
    .forEach((d) => {
      const m = document.createElement("div");
      m.className = "plan-marker";
      m.style.left = `${d.position_x * 100}%`;
      m.style.top = `${d.position_y * 100}%`;
      m.title = d.label;
      m.textContent = d.label.slice(0, 2).toUpperCase();
      container.append(m);
    });
}

function renderDesks() {
  desksContainer.innerHTML = "";
  if (!state.desks.length) {
    desksContainer.innerHTML =
      '<p class="empty">На этом этаже нет мест</p>';
    return;
  }
  for (const desk of state.desks) {
    const el = deskTemplate.content.cloneNode(true);
    const avail = state.availability.get(desk.id);
    const article = el.querySelector("article");
    article.classList.add(avail?.available ? "available" : "busy");
    el.querySelector(".desk-card-title").textContent = desk.label;
    el.querySelector(".desk-type").textContent =
      desk.type === "fixed" ? "Закреплённое" : "Гибкое";
    el.querySelector(".desk-zone").textContent = desk.zone
      ? `Зона: ${desk.zone}`
      : "";
    el.querySelector(".desk-assigned").textContent = desk.assigned_to
      ? `За: ${desk.assigned_to}`
      : "";
    const badge = el.querySelector(".badge");
    badge.textContent = avail?.available ? "Доступно" : "Занято";
    badge.classList.add(avail?.available ? "available" : "busy");
    const btn = el.querySelector(".reserve");
    btn.disabled = !avail?.available;
    if (!avail?.available) {
      btn.classList.remove("btn-primary");
      btn.classList.add("btn-secondary");
    }
    btn.addEventListener("click", () => reserveDesk(desk.id));
    desksContainer.append(el);
  }
  renderPlanMarkers(floorPlanOverlay, state.desks);
}

function renderMyBookings(bookings) {
  myBookingsContainer.innerHTML = "";
  if (!bookings.length) {
    myBookingsContainer.innerHTML =
      '<p class="empty">Нет активных бронирований</p>';
    return;
  }
  const list = document.createElement("div");
  list.className = "booking-list";
  for (const b of bookings) {
    const item = document.createElement("div");
    item.className = "booking-item";

    const info = document.createElement("div");
    info.className = "booking-info";

    const deskName =
      state.desks.find((d) => d.id === b.desk_id)?.label ?? `#${b.desk_id}`;

    const title = document.createElement("strong");
    title.textContent = `Место ${deskName}`;

    const meta = document.createElement("span");
    meta.textContent = `${b.reservation_date} · ${b.start_time?.slice(0, 5) ?? "весь день"} – ${b.end_time?.slice(0, 5) ?? ""}`;

    const checkinBadge = document.createElement("span");
    if (b.checked_in_at) {
      checkinBadge.className = "badge checked-in";
      checkinBadge.textContent = `✓ Отмечен в ${b.checked_in_at.slice(11, 16)}`;
    } else {
      checkinBadge.className = "badge not-checked-in";
      checkinBadge.textContent = "Нет отметки";
    }

    info.append(title, meta, checkinBadge);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-danger btn-sm";
    cancelBtn.textContent = "Отменить";
    cancelBtn.addEventListener("click", () => cancelBooking(b.id));

    item.append(info, cancelBtn);
    list.append(item);
  }
  myBookingsContainer.append(list);
}

// Events
officeSelect.addEventListener("change", (e) => {
  loadFloors(e.target.value);
  loadPolicies(e.target.value);
});

floorSelect.addEventListener("change", (e) => {
  const floorId = e.target.value;
  loadDesks(floorId);
  const floor = state.floors.find((f) => String(f.id) === String(floorId));
  renderFloorPlan(floor);
});

refreshButton.addEventListener("click", () => refreshAvailability());
refreshBookings.addEventListener("click", () => loadMyBookings());

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem("user_token");
  localStorage.removeItem("user_username");
  window.location.href = "./login.html";
});

// Init
async function init() {
  await checkApi();
  await loadOffices();
  await loadMyBookings();
}

init();
