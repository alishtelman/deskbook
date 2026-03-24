const API_BASE = "/api";

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
const messages            = document.getElementById("messages");
const refreshBookings     = document.getElementById("refresh-bookings");
const policyList          = document.getElementById("policy-list");
const policiesAccordion   = document.getElementById("policies-accordion");
const floorPlanCard       = document.getElementById("floor-plan-card");
const floorPlanImage      = document.getElementById("floor-plan-image");
const deskSvgOverlay      = document.getElementById("desk-svg-overlay");
const mapZoomWrapper      = document.getElementById("map-zoom-wrapper");
const mapZoomContent      = document.getElementById("map-zoom-content");
const mapSidePanel        = document.getElementById("desk-detail-content");
const deskDetailCard      = document.getElementById("desk-detail-card");
const mapControls         = document.getElementById("map-controls");
const fitResetBtn         = document.getElementById("fit-reset-btn");
const fitHeightBtn        = document.getElementById("fit-height-btn");
const userInput           = document.getElementById("user-id");
const dateInput           = document.getElementById("reservation-date");
const startInput          = document.getElementById("start-time");
const endInput            = document.getElementById("end-time");
const quickDateTodayBtn   = document.getElementById("quick-date-today");
const quickDateTomorrowBtn = document.getElementById("quick-date-tomorrow");
const quickDateCustomBtn  = document.getElementById("quick-date-custom");
const timeWindowIndicator = document.getElementById("time-window-indicator");
const myBookingsContainer = document.getElementById("my-bookings");
const loggedAsEl          = document.getElementById("logged-as");
const logoutBtn           = document.getElementById("logout-btn");
const paramsEditBtn       = document.getElementById("params-edit-btn");
const paramsApplyBtn      = document.getElementById("params-apply-btn");
const paramsCancelBtn     = document.getElementById("params-cancel-btn");
const paramsBackdrop      = document.getElementById("params-mobile-backdrop");
const paramsSummaryText   = document.getElementById("params-summary-text");
const appLayoutEl         = document.querySelector(".app-layout");
const panelColumnEl       = document.getElementById("panel-column");
const sheetToggleBtn      = document.getElementById("sheet-toggle-btn");
const sheetHandleEl       = document.querySelector("#panel-column .sheet-handle");
const sheetMiniSummaryEl  = document.getElementById("sheet-mini-summary");

const UI_PALETTE = {
  wall: "#2f343b",
  partition: "#4b5563",
  door: "#1f2937",
  status: {
    available: "#16a34a",
    mine: "#2563eb",
    occupied: "#dc2626",
    blocked: "#d97706",
  },
};

const SPACE_COLORS_CLIENT = {
  desk: "#2563eb",
  meeting_room: "#7c3aed",
  call_room: "#0891b2",
  open_space: "#16a34a",
  lounge: "#d97706",
};

const state = {
  offices: [],
  floors: [],
  desks: [],
  availability: new Map(),
  policies: [],
  floorReservations: [],
  favorites: new Set(),
  team: new Set(),        // usernames of teammates (same department)
  myDepartment: null,     // current user's department
};

let _datePreset = "today"; // today | tomorrow | custom
const LS_KEYS = {
  fitMode: "dk_fit_mode",
  statusFilter: "dk_status_filter",
  spaceFilters: "dk_space_filters",
  favFilter: "dk_fav_filter",
  teamFilter: "dk_team_filter",
  sheetState: "dk_sheet_state",
};
const DESK_STATUS_FILTERS = ["all", "available", "mine", "occupied", "blocked"];
const DESK_STATUS_LABELS = {
  all: "Все",
  available: "Свободно",
  mine: "Моё",
  occupied: "Занято",
  blocked: "Недоступно",
};
const SHEET_STATES = ["collapsed", "half", "full"];

let _statusFilter = DESK_STATUS_FILTERS.includes(localStorage.getItem(LS_KEYS.statusFilter))
  ? localStorage.getItem(LS_KEYS.statusFilter)
  : "all";
let _favFilterActive = localStorage.getItem(LS_KEYS.favFilter) === "1";
let _teamFilterActive = localStorage.getItem(LS_KEYS.teamFilter) === "1";
let _activeSpaceFilters = new Set();
let _sheetState = SHEET_STATES.includes(localStorage.getItem(LS_KEYS.sheetState))
  ? localStorage.getItem(LS_KEYS.sheetState)
  : "collapsed";
let _activePanelTab = "floor";
let _sheetInteractionsBound = false;
let _paramsSheetBound = false;
let _myBookingsCount = 0;

try {
  const rawSpaceFilters = JSON.parse(localStorage.getItem(LS_KEYS.spaceFilters) || "[]");
  if (Array.isArray(rawSpaceFilters)) {
    _activeSpaceFilters = new Set(rawSpaceFilters.map((x) => String(x || "").trim()).filter(Boolean));
  }
} catch {
  _activeSpaceFilters = new Set();
}

function _isMobileViewport() {
  return window.matchMedia("(max-width: 767px)").matches;
}

function _nextSheetStateUp(stateName) {
  if (stateName === "collapsed") return "half";
  if (stateName === "half") return "full";
  return "full";
}

function _nextSheetStateDown(stateName) {
  if (stateName === "full") return "half";
  if (stateName === "half") return "collapsed";
  return "collapsed";
}

function _deskEntriesMatchingFilters() {
  const teamDeskIds = _teamDeskIdsForCurrentWindow();
  return (state.desks || [])
    .map((desk) => ({ desk, visual: _deskAvailabilityState(desk) }))
    .filter(({ desk, visual }) => _deskPassesFilters(desk, visual.kind, teamDeskIds));
}

function _reservationsMatchingFilters() {
  const teamDeskIds = _teamDeskIdsForCurrentWindow();
  return (state.floorReservations || [])
    .filter(_reservationMatchesCurrentWindow)
    .filter((r) => {
      const desk = state.desks.find((d) => d.id === r.desk_id);
      if (!desk) return false;
      const visual = _deskAvailabilityState(desk);
      return _deskPassesFilters(desk, visual.kind, teamDeskIds);
    });
}

function updateSheetMiniSummary() {
  if (!sheetMiniSummaryEl) return;
  if (_activePanelTab === "bookings") {
    sheetMiniSummaryEl.textContent = `Мои брони: ${_myBookingsCount}`;
    return;
  }

  const label = _statusFilter === "all" ? "На этаже" : "Мест по фильтру";
  const count = _statusFilter === "all"
    ? _reservationsMatchingFilters().length
    : _deskEntriesMatchingFilters().length;
  sheetMiniSummaryEl.textContent = `${label}: ${count}`;
}

function setSheetState(nextState, opts = {}) {
  const { persist = true } = opts;
  const normalized = SHEET_STATES.includes(nextState) ? nextState : "collapsed";
  _sheetState = normalized;
  if (persist) localStorage.setItem(LS_KEYS.sheetState, normalized);

  if (!panelColumnEl) return;
  const renderedState = _isMobileViewport() ? normalized : "full";
  panelColumnEl.dataset.sheetState = normalized;
  panelColumnEl.classList.remove("sheet-collapsed", "sheet-half", "sheet-full");
  panelColumnEl.classList.add(`sheet-${renderedState}`);

  if (sheetToggleBtn) {
    const expanded = renderedState !== "collapsed";
    sheetToggleBtn.classList.toggle("sheet-open", expanded);
    sheetToggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    sheetToggleBtn.setAttribute("aria-label", expanded ? "Свернуть панель" : "Открыть панель");
  }
  updateSheetMiniSummary();
}

function cycleSheetState() {
  if (!_isMobileViewport()) return;
  if (_sheetState === "collapsed") setSheetState("half");
  else if (_sheetState === "half") setSheetState("full");
  else setSheetState("collapsed");
}

function setParamsSheetOpen(isOpen) {
  if (!appLayoutEl) return;
  const shouldOpen = Boolean(isOpen) && _isMobileViewport();
  appLayoutEl.classList.toggle("params-sheet-open", shouldOpen);
  paramsBackdrop?.setAttribute("aria-hidden", shouldOpen ? "false" : "true");
}

function setActivePanelTab(tabName, opts = {}) {
  const { promoteMobile = false } = opts;
  const nextTab = tabName === "bookings" ? "bookings" : "floor";
  _activePanelTab = nextTab;

  document.querySelectorAll(".panel-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === nextTab);
  });
  const floorEl = document.getElementById("colleagues-section");
  const bookingsEl = document.getElementById("panel-bookings-tab");
  if (floorEl) floorEl.style.display = nextTab === "floor" ? "" : "none";
  if (bookingsEl) bookingsEl.style.display = nextTab === "bookings" ? "" : "none";

  if (promoteMobile && _isMobileViewport()) {
    if (nextTab === "bookings") setSheetState("full");
    else if (_sheetState === "collapsed") setSheetState("half");
  }

  updateSheetMiniSummary();
}

function initParamsSheetInteractions() {
  if (_paramsSheetBound) return;
  _paramsSheetBound = true;

  paramsEditBtn?.addEventListener("click", () => {
    setParamsSheetOpen(true);
  });
  paramsCancelBtn?.addEventListener("click", () => {
    setParamsSheetOpen(false);
  });
  paramsBackdrop?.addEventListener("click", () => {
    setParamsSheetOpen(false);
  });
  paramsApplyBtn?.addEventListener("click", () => {
    setParamsSheetOpen(false);
    syncDatePresetFromInput();
    updateTimeWindowIndicator();
    debouncedRefresh();
  });
}

function initMobileSheetInteractions() {
  if (_sheetInteractionsBound) return;
  _sheetInteractionsBound = true;

  sheetToggleBtn?.addEventListener("click", () => {
    cycleSheetState();
  });

  sheetMiniSummaryEl?.addEventListener("click", () => {
    if (!_isMobileViewport()) return;
    setSheetState(_sheetState === "collapsed" ? "half" : "full");
  });

  if (sheetHandleEl) {
    let dragStartY = null;
    let dragLastY = null;
    let moved = false;

    const onPointerMove = (event) => {
      if (dragStartY == null) return;
      dragLastY = event.clientY;
      if (Math.abs(dragLastY - dragStartY) > 6) moved = true;
    };

    const onPointerUp = (event) => {
      if (dragStartY == null) return;
      const endY = dragLastY ?? event.clientY;
      const delta = endY - dragStartY;
      if (!moved || Math.abs(delta) < 24) {
        setSheetState(_sheetState === "collapsed" ? "half" : _sheetState);
      } else if (delta < 0) {
        setSheetState(_nextSheetStateUp(_sheetState));
      } else {
        setSheetState(_nextSheetStateDown(_sheetState));
      }
      dragStartY = null;
      dragLastY = null;
      moved = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    sheetHandleEl.addEventListener("pointerdown", (event) => {
      if (!_isMobileViewport()) return;
      dragStartY = event.clientY;
      dragLastY = event.clientY;
      moved = false;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    });
  }
}

function _isoLocalDate(d) {
  const dt = d instanceof Date ? d : new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function _presetLabelByDate(isoDate) {
  const today = _isoLocalDate(new Date());
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = _isoLocalDate(tomorrowDate);
  if (isoDate === today) return "Сегодня";
  if (isoDate === tomorrow) return "Завтра";
  return "Дата";
}

function _humanDate(isoDate) {
  if (!isoDate) return "—";
  const dt = new Date(`${isoDate}T00:00:00`);
  if (!Number.isFinite(dt.getTime())) return isoDate;
  return dt.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function _timeWindowText() {
  const isoDate = String(dateInput?.value || "").trim();
  const st = String(startInput?.value || "").trim() || "—";
  const et = String(endInput?.value || "").trim() || "—";
  const preset = _presetLabelByDate(isoDate);
  const dateLabel = preset === "Дата" ? _humanDate(isoDate) : preset;
  return `${dateLabel}, ${st}–${et}`;
}

function updateTimeWindowIndicator() {
  if (!timeWindowIndicator) return;
  timeWindowIndicator.textContent = `Просмотр: ${_timeWindowText()}`;
  if (paramsSummaryText) {
    paramsSummaryText.textContent = `Интервал брони: ${_timeWindowText()}`;
  }
}

function _applyDatePresetButtons() {
  quickDateTodayBtn?.classList.toggle("active", _datePreset === "today");
  quickDateTomorrowBtn?.classList.toggle("active", _datePreset === "tomorrow");
  quickDateCustomBtn?.classList.toggle("active", _datePreset === "custom");
}

function setDatePreset(mode, opts = {}) {
  const next = mode === "tomorrow" ? "tomorrow" : mode === "custom" ? "custom" : "today";
  _datePreset = next;
  if (next === "today") {
    dateInput.value = _isoLocalDate(new Date());
  } else if (next === "tomorrow") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    dateInput.value = _isoLocalDate(d);
  }
  _applyDatePresetButtons();
  updateTimeWindowIndicator();
  if (opts.refresh !== false) debouncedRefresh();
}

function syncDatePresetFromInput() {
  const label = _presetLabelByDate(String(dateInput?.value || "").trim());
  _datePreset = label === "Сегодня" ? "today" : label === "Завтра" ? "tomorrow" : "custom";
  _applyDatePresetButtons();
  updateTimeWindowIndicator();
}

// Init user info
userInput.value = _username;
loggedAsEl.textContent = _username;
dateInput.value = _isoLocalDate(new Date());
const userAvatarEl = document.getElementById("user-avatar");
if (userAvatarEl) userAvatarEl.textContent = _username.slice(0, 2).toUpperCase();
_applyDatePresetButtons();
updateTimeWindowIndicator();

function getToken() {
  return localStorage.getItem("user_token");
}

// ── Notification system ───────────────────────────────────────────────────────

const NOTIF_DURATIONS  = { info: 4500, success: 4500, error: 8000 };
const NOTIF_MAX        = 60;
const NOTIF_STORAGE    = "dk_notif_history";

let _notifHistory  = [];
let _notifUnread   = 0;
let _isDrawerOpen  = false;

function _notifLoad() {
  try {
    const raw = localStorage.getItem(NOTIF_STORAGE);
    if (raw) _notifHistory = JSON.parse(raw).slice(-NOTIF_MAX);
  } catch { _notifHistory = []; }
  _notifUnread = _notifHistory.filter(n => !n.read).length;
  _notifUpdateBadge();
}

function _notifSave() {
  try { localStorage.setItem(NOTIF_STORAGE, JSON.stringify(_notifHistory.slice(-NOTIF_MAX))); } catch {}
}

function _notifUpdateBadge() {
  const badge = document.getElementById("notif-badge");
  const bell  = document.getElementById("notif-bell");
  if (!badge) return;
  if (_notifUnread > 0) {
    badge.textContent  = _notifUnread > 9 ? "9+" : String(_notifUnread);
    badge.style.display = "";
    bell?.classList.add("has-unread");
  } else {
    badge.style.display = "none";
    bell?.classList.remove("has-unread");
  }
}

function _relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000)       return "только что";
  if (diff < 3_600_000)    return `${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000)   return `${Math.floor(diff / 3_600_000)} ч назад`;
  return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function _notifRenderDrawer() {
  const body = document.getElementById("notif-drawer-body");
  if (!body) return;
  if (!_notifHistory.length) {
    body.innerHTML = '<p class="empty" style="padding:40px 16px">Нет уведомлений</p>';
    return;
  }
  body.innerHTML = "";
  for (let i = _notifHistory.length - 1; i >= 0; i--) {
    const n   = _notifHistory[i];
    const el  = document.createElement("div");
    el.className = `notif-item notif-item-${n.type}${n.read ? " is-read" : ""}`;
    el.innerHTML = `
      <span class="notif-item-dot"></span>
      <span class="notif-item-text">${n.text}</span>
      <span class="notif-item-time">${_relTime(n.ts)}</span>`;
    body.append(el);
  }
}

function openNotifDrawer() {
  _isDrawerOpen = true;
  _notifHistory.forEach(n => n.read = true);
  _notifUnread = 0;
  _notifSave();
  _notifUpdateBadge();
  _notifRenderDrawer();
  document.getElementById("notif-drawer")?.classList.add("open");
  document.getElementById("notif-backdrop")?.classList.add("open");
}

function closeNotifDrawer() {
  _isDrawerOpen = false;
  document.getElementById("notif-drawer")?.classList.remove("open");
  document.getElementById("notif-backdrop")?.classList.remove("open");
}

function addMessage(text, type = "info") {
  // Save to history
  const entry = { text, type, ts: Date.now(), read: _isDrawerOpen };
  _notifHistory.push(entry);
  if (_notifHistory.length > NOTIF_MAX) _notifHistory.shift();
  if (!_isDrawerOpen) _notifUnread++;
  _notifSave();
  _notifUpdateBadge();
  if (_isDrawerOpen) _notifRenderDrawer();

  // Show toast
  const container = messages;
  if (!container) return;

  // Cap visible toasts at 4
  const existing = container.querySelectorAll(".message");
  if (existing.length >= 4) existing[existing.length - 1].remove();

  const duration = NOTIF_DURATIONS[type] ?? 4500;
  const item = document.createElement("div");
  item.className = `message ${type}`;

  const textNode = document.createElement("span");
  textNode.className = "toast-text";
  textNode.textContent = text;

  const closeBtn = document.createElement("button");
  closeBtn.className = "toast-close";
  closeBtn.innerHTML = "✕";

  const bar = document.createElement("div");
  bar.className = "toast-bar";
  bar.style.animationDuration = `${duration}ms`;

  item.append(textNode, closeBtn, bar);
  container.prepend(item);

  const dismiss = () => {
    item.style.opacity = "0";
    item.style.transform = "translateX(10px)";
    setTimeout(() => item.remove(), 220);
  };

  let timer = setTimeout(dismiss, duration);
  item.addEventListener("mouseenter", () => { clearTimeout(timer); bar.style.animationPlayState = "paused"; });
  item.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, 1800); bar.style.animationPlayState = "running"; });
  closeBtn.addEventListener("click",   () => { clearTimeout(timer); dismiss(); });
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

async function loadFavorites() {
  try {
    const desks = await apiRequest("/users/me/favorites");
    state.favorites = new Set(desks.map(d => d.id));
  } catch {
    state.favorites = new Set();
  }
}

async function loadTeam() {
  try {
    const members = await apiRequest("/users/team");
    state.team = new Set(members.map(m => m.username));
    // derive my department from my own profile
    const me = await apiRequest(`/users/${encodeURIComponent(_username)}`);
    state.myDepartment = me.department || null;
  } catch {
    state.team = new Set();
    state.myDepartment = null;
  }
}

async function checkApi() {
  try {
    await apiRequest("/health");
  } catch {
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
  renderFloorPlan(null);
  hideColleagues();
  if (!officeId) return;
  try {
    state.floors = await apiRequest(`/floors?office_id=${officeId}`);
    for (const f of state.floors) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = (f.plan_url || f.has_published_map || f.has_draft_map) ? `${f.name} ✦` : f.name;
      floorSelect.append(opt);
    }
    floorSelect.disabled = false;
  } catch (e) {
    addMessage(`Этажи: ${e.message}`, "error");
  }
}

async function loadPolicies(officeId) {
  policiesAccordion?.classList.remove("open");
  const toggleBtn = document.getElementById("policies-toggle");
  if (toggleBtn) toggleBtn.textContent = "Правила ▾";
  policyList.innerHTML = "";
  if (!officeId) return;
  try {
    state.policies = await apiRequest(`/policies?office_id=${officeId}`);
    if (state.policies.length) {
      renderPolicies();
    }
  } catch (e) {
    addMessage(`Политики: ${e.message}`, "error");
  }
}

async function loadDesks(floorId) {
  if (!floorId) return;
  try {
    state.desks = await apiRequest(`/desks?floor_id=${floorId}`);
    await refreshAvailability();
    // Save and restore pending navigation state so an intermediate re-render
    // (with the old floor's layout) does not prematurely consume it.
    const _savedPendingId     = _pendingFocusDeskId;
    const _savedPendingArrow  = _pendingFocusWithArrow;
    const _savedPendingPlumbob = _pendingPlumbobUsername;
    _pendingFocusDeskId = null;
    _pendingFocusWithArrow = false;
    _pendingPlumbobUsername = null;
    if (_currentLayout) {
      const imageFrame = document.getElementById("map-image-frame");
      _renderInlineLayoutFloor(_currentLayout, imageFrame);
    } else if (_currentRevision) {
      const imageFrame = document.getElementById("map-image-frame");
      _renderInlineSVGFloor(_currentRevision, imageFrame);
    }
    _pendingFocusDeskId     = _savedPendingId;
    _pendingFocusWithArrow  = _savedPendingArrow;
    _pendingPlumbobUsername = _savedPendingPlumbob;
  } catch (e) {
    addMessage(`Места: ${e.message}`, "error");
  }
}

async function refreshAvailability() {
  updateTimeWindowIndicator();
  const rd = dateInput.value;
  const st = startInput.value;
  const et = endInput.value;
  if (!rd || !st || !et) {
    addMessage("Заполните дату и время.", "error");
    return;
  }
  state.availability.clear();

  const availFetch = (async () => {
    const deskIds = (state.desks || []).map((desk) => desk.id).filter((id) => Number.isFinite(Number(id)));
    if (!deskIds.length) return;
    const uid = userInput.value.trim();

    try {
      const payload = {
        desk_ids: deskIds,
        reservation_date: rd,
        start_time: st,
        end_time: et,
      };
      if (uid) payload.user_id = uid;
      const batch = await apiRequest("/availability/batch", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      for (const item of (batch?.items || [])) {
        state.availability.set(item.desk_id, {
          available: Boolean(item.available),
          reason: item.reason || null,
        });
      }
      for (const deskId of deskIds) {
        if (!state.availability.has(deskId)) {
          state.availability.set(deskId, { available: false, reason: "No availability response" });
        }
      }
      return;
    } catch {
      // Fallback to per-desk mode for backward compatibility.
    }

    await Promise.all(
      state.desks.map(async (desk) => {
        const qs = new URLSearchParams({
          desk_id: String(desk.id),
          reservation_date: rd,
          start_time: st,
          end_time: et,
        });
        if (uid) qs.append("user_id", uid);
        try {
          const result = await apiRequest(`/availability?${qs}`);
          state.availability.set(desk.id, result);
        } catch (e) {
          state.availability.set(desk.id, { available: false, reason: e.message });
        }
      })
    );
  })();

  const floorId = floorSelect.value;
  const resvFetch = (floorId
    ? apiRequest(`/floors/${floorId}/reservations?date=${rd}`)
    : Promise.resolve([])
  ).then((all) => {
    state.floorReservations = all;
  }).catch(() => { state.floorReservations = []; });

  await Promise.all([availFetch, resvFetch]);
  renderFilterChips(state.desks || []);
  if (_currentLayout) {
    const imageFrame = document.getElementById("map-image-frame");
    _renderInlineLayoutFloor(_currentLayout, imageFrame);
  } else if (_currentRevision) {
    const imageFrame = document.getElementById("map-image-frame");
    _renderInlineSVGFloor(_currentRevision, imageFrame);
  } else {
    renderPlanMarkersFiltered();
  }
  renderColleagues();
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

async function reserveBatch(deskId, dates, startTime, endTime) {
  if (!dates.length) {
    addMessage("Выберите хотя бы один день и диапазон дат.", "error");
    return;
  }
  try {
    const result = await apiRequest("/reservations/batch", {
      method: "POST",
      body: JSON.stringify({ desk_id: deskId, dates, start_time: startTime, end_time: endTime }),
    });
    const created = result.created?.length ?? 0;
    const skippedDates = result.skipped ?? [];
    if (skippedDates.length > 0) {
      const dateList = skippedDates.map(d => {
        const dt = new Date(d + "T00:00:00");
        return dt.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
      }).join(", ");
      addMessage(`Создано ${created} броней. Пропущено ${skippedDates.length}: ${dateList} — место занято.`, "info");
    } else {
      addMessage(`Серия создана: ${created} бронирований.`, "success");
    }
    await refreshAvailability();
    await loadMyBookings();
  } catch (e) {
    addMessage(`Ошибка серии: ${e.message}`, "error");
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

// ── Zoom / Pan ────────────────────────────────────────────────────────────────

let _zoom = 1, _tx = 0, _ty = 0, _isPanning = false, _panStart = null, _panOffset = null, _minZoom = 1;
let _zoomInitialized = false;
// Explicit image bounds (set by fitFloorPlan, used by centerOnMarker)
let _imgX = 0, _imgY = 0, _imgW = 0, _imgH = 0;
// Fit mode: 'contain' fits whole image without upscaling (default), 'height' fills container height
let _fitMode = localStorage.getItem(LS_KEYS.fitMode) === "height" ? "height" : "contain";
// Pending desk to focus after floor plan loads (used by navigateToDesk)
let _pendingFocusDeskId = null;
let _pendingFocusWithArrow = false;
let _pendingPlumbobUsername = null; // show plumbob for this user after navigation
// Active controller for inline SVG zoom (layout/published SVG modes)
let _inlineZoomController = null;

function _isMapControlsEvent(e) {
  return !!(e?.target && typeof e.target.closest === "function" && e.target.closest("#map-controls"));
}

function _applyTransform() {
  if (mapZoomContent) {
    mapZoomContent.style.transform = `translate(${_tx}px, ${_ty}px)`;
  }
  // Resize frame instead of CSS scale → browser re-rasterizes image at zoom size (no blur)
  const frame = document.getElementById("map-image-frame");
  if (frame && _imgW) {
    frame.style.width  = Math.round(_imgW * _zoom) + "px";
    frame.style.height = Math.round(_imgH * _zoom) + "px";
  }
  const ind = document.getElementById("zoom-indicator");
  if (ind) ind.textContent = Math.round(_zoom * 100) + "%";
  if (_plumbobReposition) requestAnimationFrame(_plumbobReposition);
}

function updateFitButtonsUI() {
  fitResetBtn?.classList.toggle("active", _fitMode === "contain");
  fitHeightBtn?.classList.toggle("active", _fitMode === "height");
}

function setGlobalFitMode(nextMode) {
  _fitMode = nextMode === "height" ? "height" : "contain";
  localStorage.setItem(LS_KEYS.fitMode, _fitMode);
  updateFitButtonsUI();
}

function _myReservationForCurrentWindow() {
  return (state.floorReservations || []).find(
    (r) => r.user_id === _username && r.status === "active" && _reservationMatchesCurrentWindow(r),
  ) || null;
}

function updateMyDeskFocusButton() {
  const btn = document.getElementById("focus-my-desk-btn");
  if (!btn) return;
  const hasMine = !!_myReservationForCurrentWindow();
  btn.disabled = !hasMine;
  btn.title = hasMine ? "Моё место" : "Нет активной брони на выбранный интервал";
  btn.setAttribute("aria-disabled", hasMine ? "false" : "true");
}

function mapZoomIn() {
  if (_inlineZoomController) {
    _inlineZoomController.zoomBy(1.16);
    return;
  }
  if (!mapZoomWrapper) return;
  const cx = mapZoomWrapper.clientWidth / 2;
  const cy = mapZoomWrapper.clientHeight / 2;
  const prevZoom = _zoom;
  _zoom = Math.min(4, Math.max(_minZoom, _zoom * 1.16));
  _tx = cx - (cx - _tx) / prevZoom * _zoom;
  _ty = cy - (cy - _ty) / prevZoom * _zoom;
  _applyTransform();
  mapZoomContent.style.cursor = _zoom > _minZoom ? "grab" : "default";
}

function mapZoomOut() {
  if (_inlineZoomController) {
    _inlineZoomController.zoomBy(1 / 1.16);
    return;
  }
  if (!mapZoomWrapper) return;
  const cx = mapZoomWrapper.clientWidth / 2;
  const cy = mapZoomWrapper.clientHeight / 2;
  const prevZoom = _zoom;
  _zoom = Math.min(4, Math.max(_minZoom, _zoom / 1.16));
  _tx = cx - (cx - _tx) / prevZoom * _zoom;
  _ty = cy - (cy - _ty) / prevZoom * _zoom;
  _applyTransform();
  mapZoomContent.style.cursor = _zoom > _minZoom ? "grab" : "default";
}

function focusMyDeskOnMap() {
  const myResv = _myReservationForCurrentWindow();
  if (!myResv) {
    addMessage("Нет активной брони на выбранный интервал", "info");
    return;
  }
  highlightDesk(myResv.desk_id);
  centerOnMarker(myResv.desk_id);
  const markerEl = _findMarkerElByDeskId(myResv.desk_id);
  const deskObj = state.desks.find((d) => d.id === myResv.desk_id);
  if (markerEl && deskObj) showSidePanel(markerEl, deskObj);
}

let _mapControlsBound = false;
function bindMapControlsOnce() {
  if (_mapControlsBound) return;
  _mapControlsBound = true;
  mapControls?.addEventListener("pointerdown", (e) => e.stopPropagation());
  mapControls?.addEventListener("mousedown", (e) => e.stopPropagation());
  mapControls?.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  mapControls?.addEventListener("click", (e) => e.stopPropagation());
  document.getElementById("zoom-in-btn")?.addEventListener("click", mapZoomIn);
  document.getElementById("zoom-out-btn")?.addEventListener("click", mapZoomOut);
  document.getElementById("focus-my-desk-btn")?.addEventListener("click", focusMyDeskOnMap);
  fitResetBtn?.addEventListener("click", () => {
    setGlobalFitMode("contain");
    if (_inlineZoomController) _inlineZoomController.setFitMode("contain");
    else fitFloorPlan();
  });
  fitHeightBtn?.addEventListener("click", () => {
    setGlobalFitMode("height");
    if (_inlineZoomController) _inlineZoomController.setFitMode("height");
    else fitFloorPlan();
  });
  updateFitButtonsUI();
}

function initZoomPan() {
  if (!mapZoomWrapper || !mapZoomContent) return;
  _zoom = 1; _tx = 0; _ty = 0; _minZoom = 1;
  _applyTransform();

  if (_zoomInitialized) return; // attach listeners only once
  _zoomInitialized = true;

  const zoomAround = (cx, cy, nextZoom) => {
    const prevZoom = _zoom;
    _zoom = Math.min(4, Math.max(_minZoom, nextZoom));
    if (!Number.isFinite(prevZoom) || prevZoom <= 0) return;
    _tx = cx - (cx - _tx) / prevZoom * _zoom;
    _ty = cy - (cy - _ty) / prevZoom * _zoom;
    _applyTransform();
    mapZoomContent.style.cursor = _zoom > _minZoom ? "grab" : "default";
  };

  // Smooth wheel scaling to avoid abrupt jumps on desktop trackpads/mice.
  const wheelZoomFactor = (deltaY) => {
    const f = Math.exp(-deltaY * 0.0011);
    return Math.max(0.92, Math.min(1.08, f));
  };

  mapZoomWrapper.addEventListener("wheel", (e) => {
    if (_inlineZoomController) return;
    if (_isMapControlsEvent(e)) return;
    e.preventDefault();
    const rect = mapZoomWrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    zoomAround(cx, cy, _zoom * wheelZoomFactor(e.deltaY));
  }, { passive: false });

  mapZoomWrapper.addEventListener("mousedown", (e) => {
    if (_inlineZoomController) return;
    if (_isMapControlsEvent(e)) return;
    if (_zoom <= _minZoom) return;
    _isPanning = true;
    _panStart  = { x: e.clientX, y: e.clientY };
    _panOffset = { x: _tx, y: _ty };
    mapZoomContent.style.cursor = "grabbing";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (_inlineZoomController) return;
    if (!_isPanning) return;
    _tx = _panOffset.x + (e.clientX - _panStart.x);
    _ty = _panOffset.y + (e.clientY - _panStart.y);
    _applyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (_inlineZoomController) return;
    if (!_isPanning) return;
    _isPanning = false;
    mapZoomContent.style.cursor = _zoom > _minZoom ? "grab" : "default";
  });

  let touchMode = null; // null | pan | pinch
  let touchPanStart = null;
  let touchPanOffset = null;
  let touchPinchStart = null;

  const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const initPanFromTouch = (touch) => {
    touchMode = "pan";
    touchPanStart = { x: touch.clientX, y: touch.clientY };
    touchPanOffset = { x: _tx, y: _ty };
  };
  const initPinchFromTouches = (t1, t2) => {
    const rect = mapZoomWrapper.getBoundingClientRect();
    const dist = Math.max(1, touchDist(t1, t2));
    const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
    const midY = (t1.clientY + t2.clientY) / 2 - rect.top;
    touchMode = "pinch";
    touchPinchStart = {
      dist,
      zoom: _zoom,
      worldX: (midX - _tx) / Math.max(_zoom, 1e-6),
      worldY: (midY - _ty) / Math.max(_zoom, 1e-6),
    };
  };

  mapZoomWrapper.addEventListener("touchstart", (e) => {
    if (_inlineZoomController) return;
    if (_isMapControlsEvent(e)) return;
    if (e.touches.length >= 2) {
      initPinchFromTouches(e.touches[0], e.touches[1]);
      e.preventDefault();
      return;
    }
    if (e.touches.length === 1 && _zoom > _minZoom) {
      initPanFromTouch(e.touches[0]);
      e.preventDefault();
    }
  }, { passive: false });

  mapZoomWrapper.addEventListener("touchmove", (e) => {
    if (_inlineZoomController) return;
    if (_isMapControlsEvent(e)) return;
    if (touchMode === "pinch" && e.touches.length >= 2 && touchPinchStart) {
      const rect = mapZoomWrapper.getBoundingClientRect();
      const dist = Math.max(1, touchDist(e.touches[0], e.touches[1]));
      const ratio = dist / touchPinchStart.dist;
      const nextZoom = Math.min(4, Math.max(_minZoom, touchPinchStart.zoom * ratio));
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      _zoom = nextZoom;
      _tx = midX - touchPinchStart.worldX * _zoom;
      _ty = midY - touchPinchStart.worldY * _zoom;
      _applyTransform();
      mapZoomContent.style.cursor = _zoom > _minZoom ? "grab" : "default";
      e.preventDefault();
      return;
    }
    if (touchMode === "pan" && e.touches.length === 1 && touchPanStart && touchPanOffset) {
      _tx = touchPanOffset.x + (e.touches[0].clientX - touchPanStart.x);
      _ty = touchPanOffset.y + (e.touches[0].clientY - touchPanStart.y);
      _applyTransform();
      e.preventDefault();
    }
  }, { passive: false });

  const handleTouchEnd = (e) => {
    if (_inlineZoomController) return;
    if (e.touches.length >= 2) {
      initPinchFromTouches(e.touches[0], e.touches[1]);
      return;
    }
    if (e.touches.length === 1 && _zoom > _minZoom) {
      initPanFromTouch(e.touches[0]);
      return;
    }
    touchMode = null;
    touchPanStart = null;
    touchPanOffset = null;
    touchPinchStart = null;
  };

  mapZoomWrapper.addEventListener("touchend", handleTouchEnd, { passive: true });
  mapZoomWrapper.addEventListener("touchcancel", handleTouchEnd, { passive: true });

  // Re-fit when wrapper resizes (window resize)
  let _fitRO;
  new ResizeObserver(() => {
    clearTimeout(_fitRO);
    _fitRO = setTimeout(() => { if (floorPlanImage.naturalWidth) fitFloorPlan(); }, 80);
  }).observe(mapZoomWrapper);
}

// ── Fit image to wrapper ──────────────────────────────────────────────────────

function fitFloorPlan() {
  if (!floorPlanImage.naturalWidth || !mapZoomWrapper.clientWidth || !mapZoomWrapper.clientHeight) return;
  const frame = document.getElementById("map-image-frame");
  if (!frame) return;

  const wW = mapZoomWrapper.clientWidth;
  const wH = mapZoomWrapper.clientHeight;
  const nW = floorPlanImage.naturalWidth;
  const nH = floorPlanImage.naturalHeight;

  if (_fitMode === 'height') {
    // Fill container height exactly; frame may be wider than wrapper → pan
    _imgH = wH;
    _imgW = Math.round(nW * wH / nH);
  } else {
    // Contain: fit entire image, cap scale at 1.0 (no upscale = no blur)
    if (wW / nW < wH / nH) {
      _imgW = Math.min(nW, wW);
      _imgH = Math.round(_imgW * nH / nW);
    } else {
      _imgH = Math.min(nH, wH);
      _imgW = Math.round(_imgH * nW / nH);
    }
  }

  // Frame always at (0,0) in content space; centering done via _tx/_ty translate
  _imgX = 0; _imgY = 0;
  frame.style.left   = "0px";
  frame.style.top    = "0px";
  frame.style.width  = _imgW + "px";
  frame.style.height = _imgH + "px";
  frame.style.display = "block";

  // minZoom: allow zoom-out to see full frame when it overflows the wrapper
  _minZoom = Math.min(1.0, wW / Math.max(_imgW, 1), wH / Math.max(_imgH, 1));
  _zoom = 1.0;
  // Center image in wrapper via translate (no CSS scale)
  _tx = Math.round((wW - _imgW) / 2);
  _ty = Math.round((wH - _imgH) / 2);
  _applyTransform();

  if (mapZoomContent) mapZoomContent.style.cursor = _zoom > _minZoom ? "grab" : "default";

  updateFitButtonsUI();

  // Focus pending desk after navigation (navigateToDesk sets this)
  if (_pendingFocusDeskId) {
    const deskId = _pendingFocusDeskId;
    const withArrow = _pendingFocusWithArrow;
    const plumbobUser = _pendingPlumbobUsername;
    _pendingFocusDeskId = null;
    _pendingFocusWithArrow = false;
    _pendingPlumbobUsername = null;
    setTimeout(() => {
      focusDeskOnMap(deskId, { withArrow });
      if (plumbobUser) showColleaguePlumbob(deskId, plumbobUser);
    }, 50);
  }
}

// ── Floor plan ───────────────────────────────────────────────────────────────

// State for the currently shown map revision (SVG-based)
let _currentRevision = null;
let _currentLayout = null;

function _clearInlineSvgWrap() {
  document.getElementById("inline-svg-wrap")?.remove();
  _inlineZoomController = null;
}

function _normDeskLabel(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^0-9A-ZА-ЯЁ]/g, "");
}

function _normHexColor(value, fallback = "#1d4ed8") {
  const raw = String(value || "").trim();
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
}

function _centerOfPts(pts) {
  if (!Array.isArray(pts) || !pts.length) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += Number(p?.[0] || 0);
    sy += Number(p?.[1] || 0);
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

function _normalizeLabelPos(value) {
  const v = String(value || "").trim().toLowerCase();
  return ["center", "top", "bottom", "left", "right"].includes(v) ? v : "center";
}

function _boundsOfPts(pts) {
  if (!Array.isArray(pts) || !pts.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    const x = Number(p?.[0]);
    const y = Number(p?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

function _boundaryLabelPoint(pts, pos, fontSize) {
  const b = _boundsOfPts(pts);
  if (!b) return _centerOfPts(pts);
  const position = _normalizeLabelPos(pos);
  const margin = Math.max(4, Number(fontSize || 12) * 0.65, Math.min(b.w, b.h) * 0.08);
  if (position === "top") return { x: b.cx, y: b.minY + margin };
  if (position === "bottom") return { x: b.cx, y: b.maxY - margin };
  if (position === "left") return { x: b.minX + margin, y: b.cy };
  if (position === "right") return { x: b.maxX - margin, y: b.cy };
  return { x: b.cx, y: b.cy };
}

function _layoutStrokeScale(vbWidth) {
  const w = Number(vbWidth);
  if (!Number.isFinite(w) || w <= 0) return 1;
  return Math.max(0.2, Math.min(8, w * 0.001));
}

function _layoutStrokeWidth(kind, thick, vbWidth) {
  const base = Number.isFinite(Number(thick)) ? Number(thick) : (
    kind === "wall" ? 4 :
    kind === "partition" ? 3 :
    kind === "door" ? 2.2 :
    2
  );
  const scale = _layoutStrokeScale(vbWidth);
  if (kind === "boundary") return Math.max(1, base * scale * 0.4);
  return Math.max(1, base * scale);
}

function _timeToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function _rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return true;
  return aStart < bEnd && bStart < aEnd;
}

function _reservationMatchesCurrentWindow(r) {
  if (!r || r.status !== "active") return false;
  const selectedDate = String(dateInput?.value || "").trim();
  const reservationDate = String(r.reservation_date || "").trim();
  if (selectedDate && reservationDate && selectedDate !== reservationDate) return false;

  const qStart = _timeToMinutes(startInput?.value);
  const qEnd = _timeToMinutes(endInput?.value);
  const rStart = _timeToMinutes(r.start_time);
  const rEnd = _timeToMinutes(r.end_time);
  return _rangesOverlap(qStart, qEnd, rStart, rEnd);
}

function _deskReservationsAtCurrentWindow(deskId) {
  const hits = (state.floorReservations || []).filter(
    (r) => r.desk_id === deskId && _reservationMatchesCurrentWindow(r),
  );
  const mine = hits.find((r) => r.user_id === _username) || null;
  const occupied = hits.find((r) => r.user_id !== _username) || null;
  return { mine, occupied };
}

function _reasonLooksOccupied(reason) {
  const s = String(reason || "").toLowerCase();
  return (
    s.includes("занят") ||
    s.includes("занято") ||
    s.includes("уже забронир") ||
    s.includes("already booked") ||
    s.includes("reserved") ||
    s.includes("conflict")
  );
}

function _deskAvailabilityState(desk) {
  if (!desk) return { desk: null, kind: "unknown", mine: null, occupied: null, avail: null, reason: "" };
  const { mine, occupied } = _deskReservationsAtCurrentWindow(desk.id);
  const avail = state.availability.get(desk.id);
  const reason = String(avail?.reason || "");

  let kind = "unknown";
  if (mine) kind = "mine";
  else if (occupied) kind = "occupied";
  else if (avail?.available === true) kind = "available";
  else if (avail?.available === false) kind = _reasonLooksOccupied(reason) ? "occupied" : "blocked";

  return { desk, kind, mine, occupied, avail, reason };
}

function _findDeskByMarkerData(deskId, deskLabel) {
  const byId = state.desks.find(d => String(d.id) === String(deskId));
  if (byId) return byId;

  const byLabel = state.desks.find(d => String(d.label) === String(deskLabel));
  if (byLabel) return byLabel;

  const normLabel = _normDeskLabel(deskLabel);
  if (!normLabel) return null;
  return state.desks.find(d => _normDeskLabel(d.label) === normLabel) || null;
}

function _deskVisualState(deskId, deskLabel) {
  const desk = _findDeskByMarkerData(deskId, deskLabel);
  return _deskAvailabilityState(desk);
}

function _findMarkerElByDeskId(deskId) {
  const key = String(deskId);
  return (
    deskSvgOverlay?.querySelector(`[data-desk-id="${key}"]`) ||
    document.querySelector(`#inline-floor-svg [data-desk-id="${key}"]`)
  );
}

async function _resolveDeskForMarker(marker) {
  const deskId = marker?.dataset?.deskId || "";
  const deskLabel = marker?.dataset?.deskLabel || "";

  let desk = _findDeskByMarkerData(deskId, deskLabel);
  if (desk) return desk;

  const floorId = floorSelect?.value;
  if (!floorId) return null;

  try {
    state.desks = await apiRequest(`/desks?floor_id=${floorId}`);
  } catch {
    return null;
  }

  return _findDeskByMarkerData(deskId, deskLabel);
}

async function renderFloorPlan(floor) {
  document.getElementById("floor-plan-placeholder")?.remove();
  closeSidePanel();
  clearDeskSearchArrow();
  _currentRevision = null;
  _currentLayout = null;
  _inlineZoomController = null;
  _clearInlineSvgWrap();

  const imageFrame = document.getElementById("map-image-frame");

  // Prefer canonical published layout first (keeps client/editor visuals in sync).
  if (floor?.id) {
    try {
      const layoutResp = await fetch(`${API_BASE}/floors/${floor.id}/layout/published`, {
        headers: { Authorization: "Bearer " + getToken() },
      });
      if (layoutResp.ok) {
        const published = await layoutResp.json();
        if (published?.layout) {
          _renderInlineLayoutFloor(published.layout, imageFrame);
          return;
        }
      }
    } catch { /* continue to published SVG fallback */ }

    // Fallback: legacy published SVG revision.
    try {
      const resp = await fetch(`${API_BASE}/floors/${floor.id}/map/published`, {
        headers: { Authorization: "Bearer " + getToken() },
      });
      if (resp.ok) {
        const rev = await resp.json();
        if (rev.plan_svg) {
          _currentRevision = rev;
          _renderInlineSVGFloor(rev, imageFrame);
          return;
        }
      }
    } catch { /* continue to PNG fallback */ }

    // Do not render admin draft in client app: booking must rely on published data only.
  }

  // PNG fallback
  if (!floor?.plan_url) {
    if (imageFrame) imageFrame.style.display = "none";
    if (deskSvgOverlay) deskSvgOverlay.innerHTML = "";
    if (mapControls) mapControls.style.display = "none";
    const ph = document.createElement("p");
    ph.id = "floor-plan-placeholder";
    ph.className = "empty";
    ph.style.cssText = "padding:60px 16px;text-align:center";
    ph.textContent = floor
      ? "У этого этажа нет плана."
      : "Выберите офис и этаж для отображения карты.";
    mapZoomWrapper.appendChild(ph);
    return;
  }

  if (imageFrame) imageFrame.style.display = "none"; // hidden until fitFloorPlan sizes it
  floorPlanImage.crossOrigin = "anonymous";
  floorPlanImage.onload = fitFloorPlan;
  floorPlanImage.src = floor.plan_url;
  if (mapControls) mapControls.style.display = "";
  initZoomPan();
  renderPlanMarkersFiltered();
}

function _renderInlineLayoutFloor(layout, imageFrame) {
  _currentLayout = layout;
  if (imageFrame) imageFrame.style.display = "none";
  if (deskSvgOverlay) deskSvgOverlay.innerHTML = "";
  if (mapControls) mapControls.style.display = "";

  let svgWrap = document.getElementById("inline-svg-wrap");
  if (!svgWrap) {
    svgWrap = document.createElement("div");
    svgWrap.id = "inline-svg-wrap";
    svgWrap.style.cssText = "width:100%;height:100%;position:relative;overflow:hidden";
    mapZoomWrapper.appendChild(svgWrap);
  }

  const vb = Array.isArray(layout.vb) && layout.vb.length >= 4 ? layout.vb : [0, 0, 1000, 1000];
  const [vx, vy, vw, vh] = vb.map(Number);

  const bgImage = layout.bg_url
    ? `<image href="${_escAttr(layout.bg_url)}" x="${vx}" y="${vy}" width="${vw}" height="${vh}" preserveAspectRatio="xMidYMid meet" pointer-events="none"/>`
    : "";

  let boundaries = "";
  const strokeScaleVb = Number(vw) || 1000;
  for (const el of (layout.boundaries || [])) {
    const ptsArr = Array.isArray(el.pts) ? el.pts : [];
    if (ptsArr.length < 2) continue;
    const pts = ptsArr.map(p => `${p[0]},${p[1]}`).join(" ");
    const color = _normHexColor(el.color, "#1d4ed8");
    const tag = el.closed === false ? "polyline" : "polygon";
    const fill = el.closed === false ? "none" : color;
    const strokeW = _layoutStrokeWidth("boundary", el.thick, strokeScaleVb);
    boundaries += `<${tag} points="${pts}" fill="${fill}" fill-opacity="0.12" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="butt" stroke-linejoin="round"/>`;
    if (el.label) {
      const labelSize = Number.isFinite(Number(el.label_size))
        ? Math.max(8, Math.min(120, Number(el.label_size)))
        : Math.max(9, vw * 0.011);
      const c = _boundaryLabelPoint(ptsArr, el.label_pos, labelSize);
      const angle = Number(el.label_angle || 0);
      const rotateAttr = Number.isFinite(angle) && Math.abs(angle) > 1e-6
        ? ` transform="rotate(${angle} ${c.x} ${c.y})"`
        : "";
      boundaries += `<text x="${c.x}" y="${c.y}" text-anchor="middle" dominant-baseline="middle" fill="${color}" stroke="#ffffff" stroke-width="0.8" paint-order="stroke" font-size="${labelSize}" font-weight="700" pointer-events="none"${rotateAttr}>${_escSvgText(el.label)}</text>`;
    }
  }

  const walls = (layout.walls || []).map(el => {
    const pts = (el.pts || []).map(p => `${p[0]},${p[1]}`).join(" ");
    if (!pts) return "";
    const strokeW = _layoutStrokeWidth("wall", el.thick, strokeScaleVb);
    return `<polyline points="${pts}" fill="none" stroke="${UI_PALETTE.wall}" stroke-width="${strokeW}" stroke-linecap="butt" stroke-linejoin="round"/>`;
  }).join("");

  const partitions = (layout.partitions || []).map(el => {
    const pts = (el.pts || []).map(p => `${p[0]},${p[1]}`).join(" ");
    if (!pts) return "";
    const strokeW = _layoutStrokeWidth("partition", el.thick, strokeScaleVb);
    return `<polyline points="${pts}" fill="none" stroke="${UI_PALETTE.partition}" stroke-width="${strokeW}" stroke-linecap="butt" stroke-linejoin="round"/>`;
  }).join("");

  const doors = (layout.doors || []).map(el => {
    let pts;
    if (Number.isFinite(el.cx) && Number.isFinite(el.cy) && Number.isFinite(el.angle)) {
      // New-style door: compute endpoints from center + angle + width
      const half = (el.width || 50) / 2;
      const a = el.angle;
      const x1 = el.cx - Math.cos(a) * half, y1 = el.cy - Math.sin(a) * half;
      const x2 = el.cx + Math.cos(a) * half, y2 = el.cy + Math.sin(a) * half;
      pts = `${x1},${y1} ${x2},${y2}`;
    } else {
      pts = (el.pts || []).map(p => `${p[0]},${p[1]}`).join(" ");
    }
    if (!pts) return "";
    // Render as wall gap: white eraser line + colored door line on top
    const wallW = _layoutStrokeWidth("wall", el.thick, strokeScaleVb);
    const doorW = _layoutStrokeWidth("door", el.thick, strokeScaleVb);
    const gap = `<polyline points="${pts}" fill="none" stroke="#f6f8fb" stroke-width="${wallW * 1.6}" stroke-linecap="butt"/>`;
    const door = `<polyline points="${pts}" fill="none" stroke="#c2410c" stroke-width="${doorW * 0.55}" stroke-linecap="round" stroke-linejoin="round"/>`;
    return gap + door;
  }).join("");

  const layoutDesks = Array.isArray(layout.desks) ? layout.desks : [];
  const deskSource = layoutDesks.length
    ? layoutDesks
    : (state.desks || []).map(d => ({
        id: d.id,
        label: d.label,
        x: vx + Number(d.position_x || 0) * vw,
        y: vy + Number(d.position_y || 0) * vh,
        w: Math.max(1, Number(d.w || 0.07) * vw),
        h: Math.max(1, Number(d.h || 0.05) * vh),
      }));

  // Build label→DB-desk lookup so layout UUID ids resolve to DB integer ids.
  // Layout desks use crypto.randomUUID() as id; DB desks use integer ids.
  // _findMarkerElByDeskId (and all highlight/plumbob logic) uses the DB integer id.
  const _labelToDbDesk = new Map((state.desks || []).map(sd => [sd.label, sd]));

  const deskRects = deskSource.map(d => {
    const x = Number(d.x || 0), y = Number(d.y || 0);
    const w = Math.max(1, Number(d.w || 30)), h = Math.max(1, Number(d.h || 20));
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rotation = Number(d.r || 0);
    const transformAttr = Number.isFinite(rotation) && Math.abs(rotation) > 1e-6
      ? ` transform="rotate(${rotation} ${cx} ${cy})"`
      : "";
    const label = _escSvgText(d.label || "");
    // Resolve layout UUID → DB integer id via label match so marker lookup works
    const dbDesk = layoutDesks.length ? _labelToDbDesk.get(d.label) : null;
    const id = _escAttr(dbDesk ? dbDesk.id : (d.id || d.label || ""));
    const visual = _deskVisualState(dbDesk ? String(dbDesk.id) : String(d.id || ""), d.label || "");
    const resolvedSpaceType =
      d.space_type ||
      state.desks.find((sd) => String(sd.id) === String(d.id || ""))?.space_type ||
      "desk";
    let fill = "#dbeafe";
    let stroke = "#2563eb";
    let textColor = "#1d4ed8";
    let stateClass = "tile-unknown";
    if (visual.kind === "mine") {
      stateClass = "tile-mine";
    } else if (visual.kind === "available") {
      const st = d.space_type || "desk";
      const c = _TILE_FILL[st] || _TILE_FILL.desk;
      fill = c.fill;
      stroke = c.stroke;
      textColor = stroke;
      stateClass = "tile-available";
    } else if (visual.kind === "blocked") {
      fill = "#fef3c7";
      stroke = "#d97706";
      textColor = "#92400e";
      stateClass = "tile-blocked";
    } else if (visual.kind === "occupied") {
      fill = "#fee2e2";
      stroke = "#dc2626";
      textColor = "#991b1b";
      stateClass = "tile-busy";
    } else {
      fill = "#e2e8f0";
      stroke = "#64748b";
      textColor = "#334155";
    }
    return `<g class="desk-tile client-marker st-${_escAttr(resolvedSpaceType)} ${stateClass}" data-desk-id="${id}" data-desk-label="${_escAttr(d.label || "")}" cursor="pointer"${transformAttr}>` +
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.max(1, h * 0.1)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
      `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="${textColor}" font-size="${Math.max(7, Math.min(h * 0.45, w * 0.22))}" pointer-events="none">${label}</text>` +
      `</g>`;
  }).join("");

  svgWrap.innerHTML = `
    <svg id="inline-floor-svg" viewBox="${vx} ${vy} ${vw} ${vh}"
         style="width:100%;height:100%;display:block;user-select:none"
         xmlns="http://www.w3.org/2000/svg">
      <g id="if-bg" pointer-events="none">
        <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#e9eef4"/>
        ${bgImage}
      </g>
      <g id="if-boundaries" pointer-events="none">${boundaries}</g>
      <g id="if-walls" pointer-events="none">${walls}</g>
      <g id="if-partitions" pointer-events="none">${partitions}</g>
      <g id="if-doors" pointer-events="none">${doors}</g>
      <g id="if-markers">${deskRects}</g>
    </svg>`;

  const inlineSvg = document.getElementById("inline-floor-svg");
  inlineSvg?.querySelectorAll(".client-marker").forEach(marker => {
    marker.addEventListener("click", async () => {
      const desk = await _resolveDeskForMarker(marker);
      if (desk) {
        showSidePanel(marker, desk);
      } else {
        addMessage("Место не готово к бронированию. Опубликуйте карту и выполните 'Синх. мест' в админке.", "error");
      }
    });
  });

  _inlineZoomController = _initInlineSvgZoomPan(inlineSvg, vx, vy, vw, vh);
  renderLegend(state.desks || []);
  renderFilterChips(state.desks || []);
  applyUnifiedDeskFilter();
  updateMyDeskFocusButton();
  if (_pendingFocusDeskId) {
    const deskId = _pendingFocusDeskId;
    const withArrow = _pendingFocusWithArrow;
    const plumbobUser = _pendingPlumbobUsername;
    _pendingFocusDeskId = null;
    _pendingFocusWithArrow = false;
    _pendingPlumbobUsername = null;
    setTimeout(() => {
      focusDeskOnMap(deskId, { withArrow });
      if (plumbobUser) showColleaguePlumbob(deskId, plumbobUser);
    }, 50);
  }
}

function _renderInlineSVGFloor(rev, imageFrame) {
  _currentLayout = null;
  // Hide the PNG image frame
  if (imageFrame) imageFrame.style.display = "none";
  if (deskSvgOverlay) deskSvgOverlay.innerHTML = "";
  if (mapControls) mapControls.style.display = "";

  // Remove or reuse inline SVG container
  let svgWrap = document.getElementById("inline-svg-wrap");
  if (!svgWrap) {
    svgWrap = document.createElement("div");
    svgWrap.id = "inline-svg-wrap";
    svgWrap.style.cssText = "width:100%;height:100%;position:relative;overflow:hidden";
    mapZoomWrapper.appendChild(svgWrap);
  }

  // Parse viewBox
  const vbMatch = rev.plan_svg.match(/viewBox\s*=\s*["']([^"']+)["']/);
  const vbParts = vbMatch ? vbMatch[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 1000, 1000];
  const [vx, vy, vw, vh] = vbParts.length >= 4 ? vbParts : [0, 0, 1000, 1000];

  // Build a combined SVG: floor plan + zones + desk markers
  const markerR = Math.max(4, vw * 0.008);

  // Zones markup
  let zonesHtml = "";
  if (rev.zones && rev.zones.length) {
    for (const zone of rev.zones) {
      if (!zone.points || zone.points.length < 3) continue;
      const color = zone.color || SPACE_COLORS_CLIENT[zone.space_type] || "#16a34a";
      const pts = zone.points.map(p => `${p.x},${p.y}`).join(" ");
      const cx = zone.points.reduce((s, p) => s + p.x, 0) / zone.points.length;
      const cy = zone.points.reduce((s, p) => s + p.y, 0) / zone.points.length;
      zonesHtml += `<polygon points="${pts}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="1.5" pointer-events="none"/>`;
      zonesHtml += `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="${color}" font-size="${Math.max(8, vw * 0.012)}" pointer-events="none">${_escSvgText(zone.name)}</text>`;
    }
  }

  // Desk markers from revision
  let markersHtml = "";
  if (rev.desks && rev.desks.length) {
    for (const desk of rev.desks) {
      if (desk.x == null) continue;
      const cx = desk.x + (desk.w || 30) / 2;
      const cy = desk.y + (desk.h || 20) / 2;
      const deskId = desk.id || desk.label;
      const visual = _deskVisualState(String(deskId || ""), desk.label || "");
      let fill = SPACE_COLORS_CLIENT[desk.space_type] || "#2563eb";
      let stroke = "white";
      let stateClass = "tile-unknown";
      if (visual.kind === "mine") {
        fill = "#2563eb";
        stateClass = "tile-mine";
      } else if (visual.kind === "available") {
        stateClass = "tile-available";
      } else if (visual.kind === "blocked") {
        fill = "#d97706";
        stroke = "#ffffff";
        stateClass = "tile-blocked";
      } else if (visual.kind === "occupied") {
        fill = "#dc2626";
        stroke = "#ffffff";
        stateClass = "tile-busy";
      } else {
        fill = "#64748b";
        stroke = "#ffffff";
      }
      const st = desk.space_type || state.desks.find((sd) => String(sd.id) === String(deskId || ""))?.space_type || "desk";
      markersHtml += `<g class="desk-tile client-marker st-${_escAttr(st)} ${stateClass}" data-desk-id="${_escAttr(deskId)}" data-desk-label="${_escAttr(desk.label)}" cursor="pointer">` +
        `<circle cx="${cx}" cy="${cy}" r="${markerR}" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>` +
        `</g>`;
    }
  }

  // Inject combined SVG
  const parser = new DOMParser();
  const doc = parser.parseFromString(rev.plan_svg, "image/svg+xml");
  const srcSvg = doc.documentElement;
  const innerContent = srcSvg.innerHTML;

  svgWrap.innerHTML = `
    <svg id="inline-floor-svg" viewBox="${vx} ${vy} ${vw} ${vh}"
         style="width:100%;height:100%;display:block;user-select:none"
         xmlns="http://www.w3.org/2000/svg">
      <g id="if-floorplan" pointer-events="none">${innerContent}</g>
      <g id="if-zones">${zonesHtml}</g>
      <g id="if-markers">${markersHtml}</g>
    </svg>`;

  // Attach click handlers to markers
  const inlineSvg = document.getElementById("inline-floor-svg");
  inlineSvg?.querySelectorAll(".client-marker").forEach(marker => {
    marker.addEventListener("click", async () => {
      const desk = await _resolveDeskForMarker(marker);
      if (desk) {
        showSidePanel(marker, desk);
      } else {
        addMessage("Место не готово к бронированию. Опубликуйте карту и выполните 'Синх. мест' в админке.", "error");
      }
    });
  });

  // Basic zoom/pan on the inline SVG via viewBox manipulation
  _inlineZoomController = _initInlineSvgZoomPan(inlineSvg, vx, vy, vw, vh);
  renderLegend(state.desks || []);
  renderFilterChips(state.desks || []);
  applyUnifiedDeskFilter();
  updateMyDeskFocusButton();
  if (_pendingFocusDeskId) {
    const deskId = _pendingFocusDeskId;
    const withArrow = _pendingFocusWithArrow;
    const plumbobUser = _pendingPlumbobUsername;
    _pendingFocusDeskId = null;
    _pendingFocusWithArrow = false;
    _pendingPlumbobUsername = null;
    setTimeout(() => {
      focusDeskOnMap(deskId, { withArrow });
      if (plumbobUser) showColleaguePlumbob(deskId, plumbobUser);
    }, 50);
  }
}

function _escSvgText(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function _escAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function _safeBBox(node) {
  if (!node || typeof node.getBBox !== "function") return null;
  try {
    const box = node.getBBox();
    if (!box) return null;
    const x = Number(box.x);
    const y = Number(box.y);
    const w = Number(box.width);
    const h = Number(box.height);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  } catch {
    return null;
  }
}

function _computeInlineFitView(svg, origX, origY, origW, origH) {
  const fallback = {
    x: Number(origX) || 0,
    y: Number(origY) || 0,
    w: Math.max(1, Number(origW) || 1000),
    h: Math.max(1, Number(origH) || 1000),
  };
  if (!svg) return fallback;

  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const selectors = [
    "#if-floorplan",
    "#if-boundaries",
    "#if-walls",
    "#if-partitions",
    "#if-doors",
    "#if-zones",
    "#if-markers",
  ];

  for (const selector of selectors) {
    const node = svg.querySelector(selector);
    const box = _safeBBox(node);
    if (!box) continue;
    bounds.minX = Math.min(bounds.minX, box.x);
    bounds.minY = Math.min(bounds.minY, box.y);
    bounds.maxX = Math.max(bounds.maxX, box.x + box.w);
    bounds.maxY = Math.max(bounds.maxY, box.y + box.h);
  }

  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) return fallback;
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const pad = Math.max(8, Math.min(220, Math.max(bw, bh) * 0.08));
  const tx = bounds.minX - pad;
  const ty = bounds.minY - pad;
  const tw = bw + pad * 2;
  const th = bh + pad * 2;

  const ratio = fallback.w / Math.max(1, fallback.h);
  let vw = tw;
  let vh = th;
  if (tw / Math.max(1, th) > ratio) vh = tw / ratio;
  else vw = th * ratio;
  const cx = tx + tw / 2;
  const cy = ty + th / 2;
  return { x: cx - vw / 2, y: cy - vh / 2, w: Math.max(1, vw), h: Math.max(1, vh) };
}

function _initInlineSvgZoomPan(svg, origX, origY, origW, origH) {
  if (!svg) return null;
  let fitView = _computeInlineFitView(svg, origX, origY, origW, origH);
  let vx = fitView.x, vy = fitView.y, vw = fitView.w, vh = fitView.h;
  let isPanning = false;
  let panStart = null;
  let pinchStart = null;
  const pointers = new Map();
  let inlineFitMode = _fitMode;

  svg.style.touchAction = "none";

  const clampViewWidth = (value) => {
    const minW = Math.max(1, fitView.w / 10);
    const maxW = Math.max(minW, Math.min(Math.max(1, origW) * 1.25, fitView.w * 8));
    return Math.max(minW, Math.min(maxW, value));
  };
  const wheelZoomFactor = (deltaY) => {
    const f = Math.exp(-deltaY * 0.0011);
    return Math.max(0.92, Math.min(1.08, f));
  };

  function applyPreserveAspectRatio() {
    svg.setAttribute("preserveAspectRatio", inlineFitMode === "height" ? "xMidYMid slice" : "xMidYMid meet");
  }

  function applyVB() {
    svg.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
    const ind = document.getElementById("zoom-indicator");
    if (ind) ind.textContent = `${Math.round((origW / Math.max(vw, 1e-6)) * 100)}%`;
    if (_plumbobReposition) requestAnimationFrame(_plumbobReposition);
  }

  function zoomBy(scale, clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const ptX = vx + px * vw;
    const ptY = vy + py * vh;
    const nextVW = clampViewWidth(vw / Math.max(scale, 1e-6));
    const nextVH = origH * nextVW / origW;
    vx = ptX - px * nextVW;
    vy = ptY - py * nextVH;
    vw = nextVW;
    vh = nextVH;
    applyVB();
  }

  function centerOnWorld(worldX, worldY, zoomScale = 2.2) {
    const nextVW = clampViewWidth(origW / Math.max(zoomScale, 1));
    const nextVH = origH * nextVW / origW;
    vx = worldX - nextVW / 2;
    vy = worldY - nextVH / 2;
    vw = nextVW;
    vh = nextVH;
    applyVB();
  }

  function beginPinch() {
    if (pointers.size < 2) return;
    const [p1, p2] = Array.from(pointers.values()).slice(0, 2);
    const rect = svg.getBoundingClientRect();
    const dist = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const px = (midX - rect.left) / Math.max(rect.width, 1);
    const py = (midY - rect.top) / Math.max(rect.height, 1);
    pinchStart = {
      dist,
      startVW: vw,
      worldX: vx + px * vw,
      worldY: vy + py * vh,
    };
    isPanning = false;
    panStart = null;
  }

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zoomBy(wheelZoomFactor(e.deltaY), e.clientX, e.clientY);
  }, { passive: false });

  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".client-marker")) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (e.pointerType === "touch") {
      svg.setPointerCapture(e.pointerId);
      if (pointers.size >= 2) {
        beginPinch();
        return;
      }
    }
    isPanning = true;
    panStart = { clientX: e.clientX, clientY: e.clientY, vx, vy };
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    }

    if (pinchStart && pointers.size >= 2) {
      const [p1, p2] = Array.from(pointers.values()).slice(0, 2);
      const rect = svg.getBoundingClientRect();
      const dist = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
      const ratio = pinchStart.dist / dist;
      const nextVW = clampViewWidth(pinchStart.startVW * ratio);
      const nextVH = origH * nextVW / origW;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const px = (midX - rect.left) / Math.max(rect.width, 1);
      const py = (midY - rect.top) / Math.max(rect.height, 1);
      vx = pinchStart.worldX - px * nextVW;
      vy = pinchStart.worldY - py * nextVH;
      vw = nextVW;
      vh = nextVH;
      applyVB();
      return;
    }

    if (!isPanning || !panStart) return;
    const rect = svg.getBoundingClientRect();
    const dx = -(e.clientX - panStart.clientX) / Math.max(rect.width, 1) * vw;
    const dy = -(e.clientY - panStart.clientY) / Math.max(rect.height, 1) * vh;
    vx = panStart.vx + dx;
    vy = panStart.vy + dy;
    applyVB();
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pinchStart && pointers.size < 2) {
      pinchStart = null;
    }
    if (pointers.size === 1) {
      const remaining = Array.from(pointers.values())[0];
      isPanning = true;
      panStart = { clientX: remaining.x, clientY: remaining.y, vx, vy };
    } else if (pointers.size === 0) {
      isPanning = false;
      panStart = null;
    }
  };

  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  applyVB();
  applyPreserveAspectRatio();
  return {
    zoomBy(scale) {
      const rect = svg.getBoundingClientRect();
      zoomBy(scale, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    centerOn(worldX, worldY, zoomScale = 2.2) {
      centerOnWorld(worldX, worldY, zoomScale);
    },
    reset() {
      fitView = _computeInlineFitView(svg, origX, origY, origW, origH);
      vx = fitView.x;
      vy = fitView.y;
      vw = fitView.w;
      vh = fitView.h;
      applyPreserveAspectRatio();
      applyVB();
    },
    setFitMode(mode) {
      inlineFitMode = mode === "height" ? "height" : "contain";
      setGlobalFitMode(inlineFitMode);
      this.reset();
    },
  };
}

// ── Side panel ───────────────────────────────────────────────────────────────

let _selectedDeskId = null;

function closeSidePanel() {
  _selectedDeskId = null;
  deskSvgOverlay?.querySelectorAll(".desk-tile.selected")
    .forEach(m => m.classList.remove("selected"));
  document.querySelectorAll("#inline-floor-svg .desk-tile.selected")
    .forEach(m => m.classList.remove("selected"));
  if (mapSidePanel) mapSidePanel.innerHTML = "";
  const emptyEl = document.getElementById("desk-detail-empty");
  if (emptyEl) emptyEl.style.display = "";
}

function showSidePanel(marker, desk) {
  deskSvgOverlay?.querySelectorAll(".desk-tile.selected")
    .forEach(m => m.classList.remove("selected"));
  document.querySelectorAll("#inline-floor-svg .desk-tile.selected")
    .forEach(m => m.classList.remove("selected"));

  // Toggle off if same desk clicked again
  if (_selectedDeskId === desk.id) {
    closeSidePanel();
    return;
  }
  _selectedDeskId = desk.id;
  if (_isMobileViewport() && _sheetState === "collapsed") {
    setSheetState("half");
  }
  marker.classList.add("selected");
  const emptyEl = document.getElementById("desk-detail-empty");
  if (emptyEl) emptyEl.style.display = "none";

  const visual = _deskAvailabilityState(desk);
  const avail = visual.avail;
  const myResv = visual.mine;
  const booked = visual.occupied;

  const SPACE_LABELS = {
    desk: "Рабочий стол", meeting_room: "Переговорная",
    call_room: "Call-room", open_space: "Open Space", lounge: "Лаунж",
  };
  const spaceLabel = SPACE_LABELS[desk.space_type] ?? desk.space_type ?? "Место";
  const typeLabel  = desk.type === "fixed" ? "Закреплённое" : "Гибкое";

  let statusHtml;
  if (visual.kind === "mine") {
    statusHtml = `<span class="badge" style="background:var(--primary-light);color:var(--primary);border:1px solid var(--primary-border)">Моё</span>`;
  } else if (visual.kind === "available") {
    statusHtml = `<span class="badge available">Доступно</span>`;
  } else if (visual.kind === "blocked") {
    statusHtml = `<span class="badge blocked">Недоступно</span>`;
  } else if (visual.kind === "occupied") {
    statusHtml = `<span class="badge busy">Занято</span>`;
  } else {
    statusHtml = `<span class="badge" style="background:var(--bg-2);color:var(--text-2);border:1px solid var(--border)">Проверяется</span>`;
  }

  let bookedHtml = "";
  if (booked && !myResv) {
    bookedHtml = `<div class="side-panel-meta">
      <i data-lucide="user" style="width:12px;height:12px"></i>
      ${booked.user_id} · ${booked.start_time?.slice(0, 5) ?? "?"} – ${booked.end_time?.slice(0, 5) ?? "?"}
    </div>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="btn btn-secondary btn-sm" id="_sp_profile" data-username="${booked.user_id}" style="width:100%">
        <i data-lucide="user-circle" style="width:12px;height:12px"></i> Профиль
      </button>
    </div>`;
  }

  let actionHtml = "";
  if (visual.kind === "available") {
    actionHtml = `<button class="btn btn-primary btn-sm" id="_sp_book" style="width:100%">Забронировать</button>`;
  } else if (myResv) {
    actionHtml = `<button class="btn btn-danger btn-sm" id="_sp_cancel" data-id="${myResv.id}" style="width:100%">Отменить мою бронь</button>`;
  }

  let blockedReasonHtml = "";
  if (visual.kind === "blocked" && visual.reason) {
    blockedReasonHtml = `<div class="side-panel-meta" style="margin-top:8px">
      <i data-lucide="info" style="width:12px;height:12px"></i>
      ${visual.reason}
    </div>`;
  }

  const isFav = state.favorites.has(desk.id);
  const favBtnHtml = `<button class="btn btn-secondary btn-sm" id="_sp_fav" data-desk-id="${desk.id}" title="${isFav ? "Убрать из избранного" : "В избранное"}" style="font-size:16px;padding:0 8px">${isFav ? "★" : "☆"}</button>`;

  const windowHtml = `<div class="side-panel-meta">
    <i data-lucide="clock-3" style="width:12px;height:12px"></i>
    Просмотр: ${_timeWindowText()}
  </div>`;

  mapSidePanel.innerHTML = `
    <div class="side-panel-header">
      <div>
        <div class="side-panel-title">${desk.label}</div>
        <div class="side-panel-type">${spaceLabel} · ${typeLabel}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">${statusHtml}${favBtnHtml}</div>
    </div>
    ${windowHtml}
    ${bookedHtml}
    ${blockedReasonHtml}
    <div id="_sp_colleague_area"></div>
    ${actionHtml ? `<div class="side-panel-actions">${actionHtml}</div>` : ""}`;

  if (window.lucide) lucide.createIcons({ nodes: [mapSidePanel] });

  mapSidePanel.querySelector("#_sp_book")?.addEventListener("click", () => {
    reserveDesk(desk.id);
  });
  mapSidePanel.querySelector("#_sp_cancel")?.addEventListener("click", (e) => {
    cancelBooking(parseInt(e.currentTarget.dataset.id));
  });

  mapSidePanel.querySelector("#_sp_fav")?.addEventListener("click", async (e) => {
    const did = parseInt(e.currentTarget.dataset.deskId);
    const wasFav = state.favorites.has(did);
    try {
      if (wasFav) {
        await apiRequest(`/users/me/favorites/${did}`, { method: "DELETE" });
        state.favorites.delete(did);
      } else {
        await apiRequest(`/users/me/favorites/${did}`, { method: "POST" });
        state.favorites.add(did);
      }
      const markerEl = _findMarkerElByDeskId(did);
      if (markerEl) markerEl.classList.toggle("favorite", state.favorites.has(did));
      const btn = mapSidePanel.querySelector("#_sp_fav");
      if (btn) {
        const nowFav = state.favorites.has(did);
        btn.textContent = nowFav ? "★" : "☆";
        btn.title = nowFav ? "Убрать из избранного" : "В избранное";
      }
      addMessage(state.favorites.has(did) ? "Добавлено в избранное" : "Убрано из избранного", "success");
    } catch (err) {
      addMessage(`Ошибка: ${err.message}`, "error");
    }
  });

  mapSidePanel.querySelector("#_sp_profile")?.addEventListener("click", (e) => {
    openProfileModal(e.currentTarget.dataset.username);
  });

  if (booked && booked.user_id !== _username) {
    const target = mapSidePanel.querySelector("#_sp_colleague_area");
    if (target) fetchColleagueCard(booked.user_id, target);
  }

  // ── Recurring booking section (only when desk is available) ──
  if (visual.kind === "available") {
    const recurSection = document.createElement("div");
    recurSection.className = "recur-section";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "recur-toggle-btn";
    toggleBtn.innerHTML = '<span class="recur-toggle-icon">▶</span> Повторить';

    const recurBody = document.createElement("div");
    recurBody.className = "recur-body";

    // Day-of-week buttons: Mon–Sun (0=Sun in JS, we map to Mon–Sun display)
    const DAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
    // JS getDay(): 0=Sun,1=Mon,...,6=Sat → display order Mon..Sun maps to JS days 1,2,3,4,5,6,0
    const DAY_JS    = [1, 2, 3, 4, 5, 6, 0];

    const _selectedDays = new Set([1, 2, 3, 4, 5]); // default Mon–Fri

    const daysRow = document.createElement("div");
    daysRow.className = "recur-days";

    DAY_LABELS.forEach((label, i) => {
      const dayJs = DAY_JS[i];
      const btn = document.createElement("button");
      btn.className = "recur-day-btn" + (_selectedDays.has(dayJs) ? " active" : "");
      btn.textContent = label;
      btn.title = label;
      btn.type = "button";
      btn.addEventListener("click", () => {
        if (_selectedDays.has(dayJs)) {
          _selectedDays.delete(dayJs);
          btn.classList.remove("active");
        } else {
          _selectedDays.add(dayJs);
          btn.classList.add("active");
        }
      });
      daysRow.append(btn);
    });

    // End-date picker
    const today    = new Date();
    const maxDate  = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
    const minDate  = new Date(today.getTime() + 1  * 24 * 60 * 60 * 1000);
    const fmt = (d) => _isoLocalDate(d);

    const endRow = document.createElement("div");
    endRow.className = "recur-end-row";

    const endLabel = document.createElement("label");
    endLabel.textContent = "До";

    const endDateInput = document.createElement("input");
    endDateInput.type = "date";
    endDateInput.min  = fmt(minDate);
    endDateInput.max  = fmt(maxDate);
    endDateInput.value = fmt(maxDate);

    endRow.append(endLabel, endDateInput);

    // "Book series" button
    const batchBtn = document.createElement("button");
    batchBtn.className = "btn btn-primary btn-sm";
    batchBtn.style.width = "100%";
    batchBtn.type = "button";
    batchBtn.textContent = "Забронировать серию";

    batchBtn.addEventListener("click", () => {
      const startDate = new Date(dateInput.value + "T00:00:00");
      const endDate   = new Date(endDateInput.value + "T00:00:00");
      const st  = startInput.value;
      const et  = endInput.value;

      if (!endDateInput.value || endDate < minDate) {
        addMessage("Укажите конечную дату (минимум завтра).", "error");
        return;
      }
      if (!_selectedDays.size) {
        addMessage("Выберите хотя бы один день недели.", "error");
        return;
      }

      // Generate dates from startDate (or tomorrow, whichever is later) to endDate
      const dates = [];
      const cursor = new Date(Math.max(startDate.getTime(), minDate.getTime()));
      while (cursor <= endDate) {
        if (_selectedDays.has(cursor.getDay())) {
          dates.push(fmt(cursor));
        }
        cursor.setDate(cursor.getDate() + 1);
      }

      if (!dates.length) {
        addMessage("Нет подходящих дат в выбранном диапазоне.", "info");
        return;
      }

      reserveBatch(desk.id, dates, st, et);
    });

    recurBody.append(daysRow, endRow, batchBtn);

    // Toggle expand/collapse
    toggleBtn.addEventListener("click", () => {
      const isOpen = recurBody.classList.toggle("open");
      toggleBtn.classList.toggle("open", isOpen);
    });

    recurSection.append(toggleBtn, recurBody);
    mapSidePanel.append(recurSection);
  }
}

async function fetchColleagueCard(bookedBy, container) {
  let profile = null;
  try {
    profile = await apiRequest(`/users/${encodeURIComponent(bookedBy)}`);
  } catch {
    // Graceful fallback: show username only
  }

  if (!container.isConnected) return;

  const STATUS_LABELS  = { available: "Доступен", busy: "Занят", away: "Отсутствует" };
  const STATUS_CLASSES = { available: "status-available", busy: "status-busy", away: "status-away" };

  const displayName = profile?.full_name || bookedBy;
  const initials    = displayName.slice(0, 2).toUpperCase();

  const card = document.createElement("div");
  card.className = "colleague-card";

  const avatarEl = document.createElement("div");
  avatarEl.className = "colleague-card-avatar";
  avatarEl.textContent = initials;

  const infoEl = document.createElement("div");
  infoEl.className = "colleague-card-info";

  const nameRow = document.createElement("div");
  nameRow.className = "colleague-card-name";
  nameRow.textContent = displayName;
  infoEl.append(nameRow);

  if (profile?.position) {
    const posRow = document.createElement("div");
    posRow.className = "colleague-card-row";
    posRow.textContent = profile.position;
    infoEl.append(posRow);
  }
  if (profile?.department) {
    const deptRow = document.createElement("div");
    deptRow.className = "colleague-card-row";
    deptRow.textContent = profile.department;
    infoEl.append(deptRow);
  }
  if (profile?.phone) {
    const phoneRow = document.createElement("div");
    phoneRow.className = "colleague-card-row";
    phoneRow.textContent = `📞 ${profile.phone}`;
    infoEl.append(phoneRow);
  }
  if (profile?.user_status && STATUS_LABELS[profile.user_status]) {
    const statusEl = document.createElement("span");
    statusEl.className = `status-badge ${STATUS_CLASSES[profile.user_status]}`;
    statusEl.textContent = STATUS_LABELS[profile.user_status];
    statusEl.style.marginTop = "4px";
    infoEl.append(statusEl);
  }

  card.append(avatarEl, infoEl);
  container.append(card);
}

// ── Profile modal ─────────────────────────────────────────────────────────────

function renderProfileModal(profile, username) {
  const container = document.getElementById("profile-modal");
  if (!container) return;

  const STATUS_LABELS  = { available: "Доступен", busy: "Занят", away: "Отсутствует" };
  const STATUS_CLASSES = { available: "status-available", busy: "status-busy", away: "status-away" };

  const displayName = profile?.full_name || username;
  const initials    = displayName.slice(0, 2).toUpperCase();
  const sub         = [profile?.department, profile?.position].filter(Boolean).join(" · ") || username;
  const statusLabel = profile?.user_status ? STATUS_LABELS[profile.user_status] : null;
  const statusClass = profile?.user_status ? STATUS_CLASSES[profile.user_status] : "";

  container.innerHTML = `
    <div class="profile-modal-header">
      <span class="profile-modal-title">Профиль</span>
      <button class="notif-close-btn" id="profile-modal-close" aria-label="Закрыть">
        <i data-lucide="x" style="width:15px;height:15px"></i>
      </button>
    </div>
    <div class="profile-modal-body">
      <div class="profile-modal-hero">
        <div class="profile-modal-avatar">${initials}</div>
        <div>
          <div class="profile-modal-name">${displayName}</div>
          <div class="profile-modal-sub">${sub}</div>
          ${statusLabel ? `<span class="status-badge ${statusClass}" style="margin-top:6px;display:inline-block">${statusLabel}</span>` : ""}
        </div>
      </div>
      ${profile?.phone ? `<div class="profile-modal-row">
        <i data-lucide="phone" style="width:14px;height:14px;color:var(--text-3)"></i>
        <a href="tel:${profile.phone}">${profile.phone}</a>
      </div>` : ""}
    </div>`;

  // "Find on map" button — only for other users
  if (username !== _username) {
    const findBtn = document.createElement("button");
    findBtn.className = "profile-find-btn";
    findBtn.innerHTML = `<i data-lucide="map-pin" style="width:14px;height:14px"></i> Найти на карте`;
    findBtn.addEventListener("click", async () => {
      findBtn.disabled = true;
      findBtn.textContent = "Поиск…";
      try {
        const today = _isoLocalDate(new Date());
        const results = await apiRequest(`/users/search?q=${encodeURIComponent(username)}&date=${today}&limit=5`);
        const user = results.find(u => u.username === username) || null;
        if (user?.location) {
          const loc = user.location;
          closeProfileModal();
          await navigateToDesk(loc.office_id, loc.floor_id, loc.desk_id, { plumbobUsername: username });
        } else {
          addMessage(`У ${displayName} нет брони на сегодня`, "info");
          findBtn.disabled = false;
          findBtn.innerHTML = `<i data-lucide="map-pin" style="width:14px;height:14px"></i> Найти на карте`;
          if (window.lucide) lucide.createIcons({ nodes: [findBtn] });
        }
      } catch {
        findBtn.disabled = false;
        findBtn.textContent = "Найти на карте";
      }
    });
    container.querySelector(".profile-modal-body")?.appendChild(findBtn);
  }

  if (window.lucide) lucide.createIcons({ nodes: [container] });
  container.querySelector("#profile-modal-close")?.addEventListener("click", closeProfileModal);
}

async function openProfileModal(username) {
  let profile = null;
  try {
    profile = await apiRequest(`/users/${encodeURIComponent(username)}`);
  } catch { /* fallback to username only */ }

  renderProfileModal(profile, username);

  const overlay = document.getElementById("profile-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function closeProfileModal() {
  const overlay = document.getElementById("profile-modal-overlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.addEventListener("transitionend", () => { overlay.style.display = "none"; }, { once: true });
}

// ── Desk highlight ───────────────────────────────────────────────────────────

let _highlightedDeskId = null;
let _searchArrowDeskId = null;
let _plumbobDeskId = null;
let _plumbobReposition = null;

function clearColleaguePlumbob() {
  document.querySelectorAll(".colleague-plumbob").forEach(el => el.remove());
  document.querySelectorAll(".colleague-plumbob-svg").forEach(el => el.remove());
  _plumbobDeskId = null;
  _plumbobReposition = null;
}

function showColleaguePlumbob(deskId, username) {
  clearColleaguePlumbob();
  if (!deskId) return;

  const marker = _findMarkerElByDeskId(deskId);
  if (!marker) return;

  _plumbobDeskId = deskId;
  _plumbobReposition = null;

  const parentSvg = marker.ownerSVGElement;
  if (parentSvg) {
    // SVG-embedded approach: sits in SVG coordinate space, no overflow clipping issues
    let box;
    try { box = marker.getBBox(); } catch { box = null; }
    if (!box || !Number.isFinite(box.x)) return;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const vbParts = parentSvg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number) || [0, 0, 1000, 1000];
    const vw = vbParts[2] || 1000;
    const baseR = Math.max(vw * 0.025, box.width * 0.75);
    const sw    = vw * 0.005;
    const fontSize = vw * 0.028;
    const labelY = box.y - baseR * 0.5;

    const ns = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(ns, "g");
    g.classList.add("colleague-plumbob-svg");
    g.setAttribute("data-desk-id", String(deskId));

    // Outer pulsing ring
    const pulse = document.createElementNS(ns, "circle");
    pulse.setAttribute("cx", cx);
    pulse.setAttribute("cy", cy);
    pulse.setAttribute("r", baseR);
    pulse.setAttribute("fill", "none");
    pulse.setAttribute("stroke", "#22c55e");
    pulse.setAttribute("stroke-width", sw);
    pulse.classList.add("colleague-pulse-ring");

    // Inner solid dot
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
    dot.setAttribute("r", baseR * 0.4);
    dot.setAttribute("fill", "#16a34a");
    dot.setAttribute("stroke", "#fff");
    dot.setAttribute("stroke-width", sw * 0.6);

    // Name label
    const displayName = username.length > 18 ? username.slice(0, 17) + "…" : username;
    const charW = fontSize * 0.6;
    const bgW   = displayName.length * charW + fontSize * 0.8;
    const bgH   = fontSize * 1.5;

    const bgRect = document.createElementNS(ns, "rect");
    bgRect.setAttribute("x", cx - bgW / 2);
    bgRect.setAttribute("y", labelY - bgH);
    bgRect.setAttribute("width", bgW);
    bgRect.setAttribute("height", bgH);
    bgRect.setAttribute("rx", fontSize * 0.3);
    bgRect.setAttribute("fill", "white");
    bgRect.setAttribute("fill-opacity", "0.93");
    bgRect.setAttribute("stroke", "#16a34a");
    bgRect.setAttribute("stroke-width", sw * 0.8);

    const textEl = document.createElementNS(ns, "text");
    textEl.setAttribute("x", cx);
    textEl.setAttribute("y", labelY - bgH * 0.25);
    textEl.setAttribute("text-anchor", "middle");
    textEl.setAttribute("dominant-baseline", "middle");
    textEl.setAttribute("font-size", fontSize);
    textEl.setAttribute("font-weight", "700");
    textEl.setAttribute("fill", "#14532d");
    textEl.setAttribute("pointer-events", "none");
    textEl.textContent = displayName;

    g.appendChild(bgRect);
    g.appendChild(pulse);
    g.appendChild(dot);
    g.appendChild(textEl);

    const container = parentSvg.querySelector("#if-markers") || parentSvg;
    container.appendChild(g);
    return;
  }

  // HTML overlay fallback (PNG maps without inline SVG)
  const el = document.createElement("div");
  el.className = "colleague-plumbob";
  el.setAttribute("data-desk-id", String(deskId));
  const displayName = username.length > 16 ? username.slice(0, 15) + "…" : username;
  el.innerHTML = `
    <div class="plumbob-name">${displayName}</div>
    <div class="plumbob-gem"></div>
    <div class="plumbob-connector"></div>`;
  mapZoomWrapper.appendChild(el);

  function reposition() {
    const wRect = mapZoomWrapper.getBoundingClientRect();
    const mRect = marker.getBoundingClientRect();
    if (!mRect.width && !mRect.height) return;
    el.style.left = (mRect.left + mRect.width / 2 - wRect.left) + "px";
    el.style.top  = (mRect.top - wRect.top) + "px";
  }
  requestAnimationFrame(() => setTimeout(reposition, 80));
  _plumbobReposition = reposition;
}

function clearDeskSearchArrow() {
  document.querySelectorAll(".desk-search-arrow").forEach((el) => el.remove());
  _searchArrowDeskId = null;
}

function showDeskSearchArrow(deskId) {
  clearDeskSearchArrow();
  if (!deskId) return;
  const marker = _findMarkerElByDeskId(deskId);
  if (!marker || typeof marker.getBBox !== "function") return;
  const svg = marker.ownerSVGElement;
  if (!svg) return;

  let box = null;
  try {
    box = marker.getBBox();
  } catch {
    box = null;
  }
  if (!box) return;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.width);
  const h = Number(box.height);
  if (![x, y, w, h].every(Number.isFinite)) return;

  const ns = "http://www.w3.org/2000/svg";
  const cx = x + w / 2;
  const tipY = y - Math.max(2, h * 0.08);
  const headH = Math.max(8, h * 0.55);
  const headHalfW = Math.max(6, w * 0.42);
  const headBaseY = tipY - headH;
  const shaftTopY = headBaseY - Math.max(14, h * 0.95);

  const g = document.createElementNS(ns, "g");
  g.classList.add("desk-search-arrow");
  g.setAttribute("data-desk-id", String(deskId));
  g.setAttribute("pointer-events", "none");

  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", String(cx));
  line.setAttribute("y1", String(shaftTopY));
  line.setAttribute("x2", String(cx));
  line.setAttribute("y2", String(headBaseY));

  const triangle = document.createElementNS(ns, "polygon");
  triangle.setAttribute(
    "points",
    `${cx},${tipY} ${cx - headHalfW},${headBaseY} ${cx + headHalfW},${headBaseY}`,
  );

  const ring = document.createElementNS(ns, "circle");
  ring.setAttribute("cx", String(cx));
  ring.setAttribute("cy", String(shaftTopY));
  ring.setAttribute("r", String(Math.max(4, Math.min(10, headHalfW * 0.7))));

  g.append(line, triangle, ring);
  (marker.parentNode || svg).appendChild(g);
  _searchArrowDeskId = deskId;
}

function highlightDesk(deskId) {
  if (!deskId || (_searchArrowDeskId && String(_searchArrowDeskId) !== String(deskId))) {
    clearDeskSearchArrow();
  }
  if (!deskId || (_plumbobDeskId && String(_plumbobDeskId) !== String(deskId))) {
    clearColleaguePlumbob();
  }
  deskSvgOverlay?.querySelectorAll(".desk-tile.highlighted")
    .forEach(m => m.classList.remove("highlighted"));
  document.querySelectorAll("#inline-floor-svg .desk-tile.highlighted")
    .forEach(m => m.classList.remove("highlighted"));
  _highlightedDeskId = null;

  if (!deskId) return;

  const marker =
    deskSvgOverlay?.querySelector(`[data-desk-id="${deskId}"]`) ||
    document.querySelector(`#inline-floor-svg [data-desk-id="${deskId}"]`);
  if (!marker) return;

  marker.classList.add("highlighted");
  _highlightedDeskId = deskId;
}

function focusDeskOnMap(deskId, opts = {}) {
  const { withArrow = false } = opts;
  if (deskId == null) return;
  highlightDesk(deskId);
  centerOnMarker(deskId);
  if (withArrow) showDeskSearchArrow(deskId);
  else clearDeskSearchArrow();
  const markerEl = _findMarkerElByDeskId(deskId);
  const deskObj = state.desks.find((d) => d.id === deskId);
  if (markerEl && deskObj) showSidePanel(markerEl, deskObj);
}

function centerOnMarker(deskId, zoom = 2.25) {
  if (_inlineZoomController) {
    const marker = document.querySelector(`#inline-floor-svg [data-desk-id="${deskId}"]`);
    if (!marker || typeof marker.getBBox !== "function") return;
    const box = marker.getBBox();
    if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return;
    _inlineZoomController.centerOn(box.x + box.width / 2, box.y + box.height / 2, zoom);
    return;
  }

  const desk = state.desks.find(d => d.id === deskId);
  if (!desk || typeof desk.position_x !== "number") return;

  const wW = mapZoomWrapper?.clientWidth;
  const wH = mapZoomWrapper?.clientHeight;
  if (!wW || !wH || !_imgW) return;

  const targetZoom = Math.min(4, Math.max(_zoom, Math.max(_minZoom * 2.5, 2)));
  _zoom = targetZoom;
  const cx = desk.position_x + (desk.w || 0.03) / 2;
  const cy = desk.position_y + (desk.h || 0.02) / 2;
  _tx   = wW / 2 - (_imgX + cx * _imgW) * targetZoom;
  _ty   = wH / 2 - (_imgY + cy * _imgH) * targetZoom;
  _applyTransform();
  if (mapZoomContent) mapZoomContent.style.cursor = "grab";
}

// ── Plan markers ────────────────────────────────────────────────────────────

// Space-type fill colors for SVG tiles (available state)
const _TILE_FILL = {
  desk:         { fill: "#dcfce7", stroke: "#16a34a" },
  meeting_room: { fill: "#ede9fe", stroke: "#7c3aed" },
  call_room:    { fill: "#cffafe", stroke: "#0891b2" },
  open_space:   { fill: "#ecfccb", stroke: "#65a30d" },
  lounge:       { fill: "#fef3c7", stroke: "#d97706" },
};

function renderPlanMarkers(svgEl, desks) {
  if (!svgEl) return;
  _highlightedDeskId = null;
  clearColleaguePlumbob();
  svgEl.innerHTML = "";

  desks
    .filter((d) => typeof d.position_x === "number" && typeof d.position_y === "number")
    .forEach((d) => {
      const visual = _deskAvailabilityState(d);
      const st = d.space_type || "desk";
      const tileW = (d.w || 0.03) * 1000;
      const tileH = (d.h || 0.02) * 1000;
      const tx    = d.position_x * 1000;
      const ty    = d.position_y * 1000;

      let fillColor, strokeColor;
      if (visual.kind === "mine") {
        fillColor = "#dbeafe"; strokeColor = "#2563eb";
      } else if (visual.kind === "available") {
        const c = _TILE_FILL[st] || _TILE_FILL.desk;
        fillColor = c.fill; strokeColor = c.stroke;
      } else if (visual.kind === "blocked") {
        fillColor = "#fef3c7"; strokeColor = "#d97706";
      } else if (visual.kind === "occupied") {
        fillColor = "#fee2e2"; strokeColor = "#dc2626";
      } else {
        fillColor = "#e2e8f0"; strokeColor = "#64748b";
      }

      const ns = "http://www.w3.org/2000/svg";
      const g = document.createElementNS(ns, "g");
      g.classList.add("desk-tile", "st-" + st);
      if (visual.kind === "mine") g.classList.add("tile-mine");
      else if (visual.kind === "available") g.classList.add("tile-available");
      else if (visual.kind === "blocked") g.classList.add("tile-blocked");
      else if (visual.kind === "occupied") g.classList.add("tile-busy");
      else g.classList.add("tile-unknown");
      if (state.favorites.has(d.id)) g.classList.add("favorite");
      g.dataset.deskId = String(d.id);

      const isDesk = st === "desk";
      if (isDesk) {
        // Desk: small circle at center of tile area
        const cx = tx + tileW / 2;
        const cy = ty + tileH / 2;
        const r  = 6;
        const circ = document.createElementNS(ns, "circle");
        circ.setAttribute("cx",           String(cx));
        circ.setAttribute("cy",           String(cy));
        circ.setAttribute("r",            String(r));
        circ.setAttribute("fill",         fillColor);
        circ.setAttribute("stroke",       strokeColor);
        circ.setAttribute("stroke-width", "2");
        g.appendChild(circ);
      } else {
        // Room: rectangle block
        const rect = document.createElementNS(ns, "rect");
        rect.setAttribute("x",            String(tx));
        rect.setAttribute("y",            String(ty));
        rect.setAttribute("width",        String(tileW));
        rect.setAttribute("height",       String(tileH));
        rect.setAttribute("rx",           "8");
        rect.setAttribute("fill",         fillColor);
        rect.setAttribute("stroke",       strokeColor);
        rect.setAttribute("stroke-width", "2");
        g.appendChild(rect);
      }

      g.addEventListener("click", (e) => {
        e.stopPropagation();
        showSidePanel(g, d);
      });

      svgEl.appendChild(g);
    });

  // Reset side panel on floor change / re-render
  closeSidePanel();
  renderLegend(desks);
  renderFilterChips(desks);
  applyUnifiedDeskFilter();
  updateMyDeskFocusButton();
}

const _LEGEND_LABELS = {
  desk: "Рабочий стол", meeting_room: "Переговорная",
  call_room: "Call-room", open_space: "Open Space", lounge: "Лаунж",
};
const _LEGEND_COLORS = {
  desk: "#059669", meeting_room: "#7c3aed",
  call_room: "#0891b2", open_space: "#65a30d", lounge: "#d97706",
};

function renderLegend(desks) {
  const el = document.getElementById("map-legend");
  if (!el) return;
  const types = [...new Set(desks.map(d => d.space_type || "desk"))];
  if (types.length <= 1) { el.style.display = "none"; return; }
  el.style.display = "";
  el.innerHTML = types.map(t =>
    `<span class="legend-item">
       <span class="legend-dot" style="background:${_LEGEND_COLORS[t] || "#888"}"></span>
       ${_LEGEND_LABELS[t] || t}
     </span>`
  ).join("");
}

// ── Colleagues ──────────────────────────────────────────────────────────────

function hideColleagues() {
  const list  = document.getElementById("colleagues-list");
  const count = document.getElementById("colleagues-count");
  if (list) list.innerHTML = '<p class="empty" style="padding:20px 16px;font-size:12px">Выберите этаж для отображения</p>';
  if (count) count.textContent = "";
  state.floorReservations = [];
  updateSheetMiniSummary();
}

function renderFloorPlacesList() {
  const list = document.getElementById("colleagues-list");
  const count = document.getElementById("colleagues-count");
  if (!list) return;

  list.innerHTML = "";
  const entries = _deskEntriesMatchingFilters()
    .sort((a, b) => String(a.desk?.label || "").localeCompare(String(b.desk?.label || ""), "ru", { numeric: true, sensitivity: "base" }));

  if (!entries.length) {
    list.innerHTML = '<p class="empty" style="padding:20px 16px;font-size:12px">Нет мест по выбранным фильтрам и интервалу</p>';
    if (count) count.textContent = "";
    updateSheetMiniSummary();
    return;
  }

  if (count) count.textContent = `${entries.length}`;

  const col = document.createElement("div");
  col.className = "floor-place-list";

  const windowMeta = document.createElement("div");
  windowMeta.className = "colleagues-window";
  windowMeta.textContent = `Просмотр: ${_timeWindowText()}`;
  col.append(windowMeta);

  const statusLabel = {
    available: "Свободно",
    mine: "Моё",
    occupied: "Занято",
    blocked: "Недоступно",
    unknown: "Проверяется",
  };

  const spaceLabel = {
    desk: "Рабочий стол",
    meeting_room: "Переговорная",
    call_room: "Call-room",
    open_space: "Open Space",
    lounge: "Лаунж",
  };

  for (const entry of entries) {
    const { desk, visual } = entry;
    const item = document.createElement("div");
    item.className = `floor-place-item status-${visual.kind}`;
    const baseDeskLabel = desk.label || `Место #${desk.id}`;
    const metaBits = [spaceLabel[desk.space_type] || desk.space_type || "Место"];
    if (visual.kind === "occupied" && visual.occupied?.user_id) {
      metaBits.push(`занято: ${visual.occupied.user_id}`);
    }

    item.innerHTML = `
      <div class="floor-place-main">
        <div class="floor-place-title">${baseDeskLabel}</div>
        <div class="floor-place-meta">${metaBits.join(" · ")}</div>
      </div>
      <div class="place-status-badge ${visual.kind}">${statusLabel[visual.kind] || statusLabel.unknown}</div>`;

    item.addEventListener("click", () => {
      if (_highlightedDeskId === desk.id) {
        highlightDesk(null);
        closeSidePanel();
        item.classList.remove("active-place");
        return;
      }
      document.querySelectorAll(".floor-place-item.active-place, .colleague-item.active-colleague")
        .forEach((el) => el.classList.remove("active-place", "active-colleague"));
      item.classList.add("active-place");
      highlightDesk(desk.id);
      centerOnMarker(desk.id);
      const markerEl = _findMarkerElByDeskId(desk.id);
      if (markerEl) showSidePanel(markerEl, desk);
    });

    col.append(item);
  }

  list.append(col);
  updateSheetMiniSummary();
}

function renderColleagues() {
  const list  = document.getElementById("colleagues-list");
  const count = document.getElementById("colleagues-count");
  if (!list) return;

  if (_statusFilter !== "all") {
    renderFloorPlacesList();
    return;
  }

  list.innerHTML = "";

  const reservations = _reservationsMatchingFilters();

  if (!reservations.length) {
    const hasExtraFilters =
      _activeSpaceFilters.size > 0 || _favFilterActive || _teamFilterActive;
    const emptyMsg = hasExtraFilters
      ? "По выбранным фильтрам на интервал нет совпадений"
      : "На выбранный интервал никого нет на этаже";
    list.innerHTML = `<p class="empty" style="padding:20px 16px;font-size:12px">${emptyMsg}</p>`;
    if (count) count.textContent = "";
    updateSheetMiniSummary();
    return;
  }

  if (count) count.textContent = `${reservations.length}`;

  const col = document.createElement("div");
  col.className = "colleague-list";
  const windowMeta = document.createElement("div");
  windowMeta.className = "colleagues-window";
  windowMeta.textContent = `Просмотр: ${_timeWindowText()}`;
  col.append(windowMeta);

  for (const r of reservations) {
    const desk = state.desks.find((d) => d.id === r.desk_id);
    const isMe = r.user_id === _username;
    const isTeam = state.team.has(r.user_id);

    const item = document.createElement("div");
    item.className = `colleague-item${isMe ? " is-me" : ""}`;

    const initials  = r.user_id.slice(0, 2).toUpperCase();
    const deskLabel = desk?.label ?? `Место #${r.desk_id}`;
    const timeText  = (r.start_time && r.end_time)
      ? `${r.start_time.slice(0, 5)} – ${r.end_time.slice(0, 5)}`
      : "Весь день";
    const meTag   = isMe ? `<span class="colleague-me-tag">вы</span>` : "";
    const teamTag = !isMe && isTeam ? `<span class="colleague-team-tag">команда</span>` : "";

    item.innerHTML = `
      <div class="colleague-avatar">${initials}</div>
      <div class="colleague-info">
        <div class="colleague-name">${r.user_id}${meTag}${teamTag}</div>
        <div class="colleague-desk">${deskLabel}</div>
      </div>
      <div class="colleague-time">${timeText}</div>
      ${!isMe ? `<button class="colleague-profile-btn" data-uid="${r.user_id}" title="Профиль" aria-label="Открыть профиль">👤</button>` : ""}`;

    // Profile button
    item.querySelector(".colleague-profile-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openProfileModal(e.currentTarget.dataset.uid);
    });

    if (desk) {
      item.style.cursor = "pointer";
      (function(reservation, listItem, userId) {
        listItem.addEventListener("click", () => {
          if (_highlightedDeskId === reservation.desk_id) {
            highlightDesk(null);
            clearColleaguePlumbob();
            closeSidePanel();
            listItem.classList.remove("active-colleague");
            return;
          }
          document.querySelectorAll(".floor-place-item.active-place, .colleague-item.active-colleague")
            .forEach(el => el.classList.remove("active-place", "active-colleague"));
          listItem.classList.add("active-colleague");
          highlightDesk(reservation.desk_id);
          centerOnMarker(reservation.desk_id);
          showColleaguePlumbob(reservation.desk_id, userId);
          const markerEl = _findMarkerElByDeskId(reservation.desk_id);
          const deskObj  = state.desks.find(d => d.id === reservation.desk_id);
          if (markerEl && deskObj) showSidePanel(markerEl, deskObj);
        });
      })(r, item, r.user_id);
    }

    col.append(item);
  }

  list.append(col);
  updateSheetMiniSummary();
}

// ── My bookings ─────────────────────────────────────────────────────────────

function renderMyBookings(bookings) {
  _myBookingsCount = Array.isArray(bookings) ? bookings.length : 0;
  updateSheetMiniSummary();
  myBookingsContainer.innerHTML = "";
  if (!bookings.length) {
    myBookingsContainer.innerHTML = '<p class="empty">Нет активных бронирований</p>';
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

// ── Unified filters ─────────────────────────────────────────────────────────
const _SF_LABELS = {
  desk: "Рабочий стол", meeting_room: "Переговорная",
  call_room: "Call-room", open_space: "Open Space", lounge: "Лаунж",
};
const _SF_COLORS = {
  desk: "#059669", meeting_room: "#7c3aed",
  call_room: "#0891b2", open_space: "#65a30d", lounge: "#d97706",
};
const _STATUS_COLORS = {
  all: "#475569",
  available: "#16a34a",
  mine: "#2563eb",
  occupied: "#dc2626",
  blocked: "#d97706",
};

function _saveFilterState() {
  localStorage.setItem(LS_KEYS.statusFilter, _statusFilter);
  localStorage.setItem(LS_KEYS.spaceFilters, JSON.stringify([..._activeSpaceFilters]));
  localStorage.setItem(LS_KEYS.favFilter, _favFilterActive ? "1" : "0");
  localStorage.setItem(LS_KEYS.teamFilter, _teamFilterActive ? "1" : "0");
}

function _teamDeskIdsForCurrentWindow() {
  return new Set(
    (state.floorReservations || [])
      .filter((r) =>
        r.status === "active"
        && _reservationMatchesCurrentWindow(r)
        && (state.team.has(r.user_id) || r.user_id === _username)
      )
      .map((r) => r.desk_id),
  );
}

function _deskPassesFilters(desk, visualKind, teamDeskIds) {
  if (!desk) return false;
  const kind = visualKind || _deskAvailabilityState(desk).kind;
  const st = desk.space_type || "desk";
  if (_statusFilter !== "all" && kind !== _statusFilter) return false;
  if (_activeSpaceFilters.size > 0 && !_activeSpaceFilters.has(st)) return false;
  if (_favFilterActive && !state.favorites.has(desk.id)) return false;
  if (_teamFilterActive && !teamDeskIds.has(desk.id)) return false;
  return true;
}

function applyUnifiedDeskFilter() {
  const markers = document.querySelectorAll(".desk-tile");
  if (!markers.length) return;
  const teamDeskIds = _teamDeskIdsForCurrentWindow();
  markers.forEach((marker) => {
    const desk = _findDeskByMarkerData(marker.dataset?.deskId || "", marker.dataset?.deskLabel || "");
    if (!desk) {
      marker.classList.remove("filtered-out");
      return;
    }
    const visual = _deskAvailabilityState(desk);
    const show = _deskPassesFilters(desk, visual.kind, teamDeskIds);
    marker.classList.toggle("filtered-out", !show);
  });
}

function renderFilterChips(desks) {
  const bar = document.getElementById("space-filter-bar");
  if (!bar) return;
  const items = Array.isArray(desks) ? desks : [];
  bar.style.display = "";
  bar.innerHTML = "";

  const makeChip = ({ label, active, color, onClick, dot = false }) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `filter-chip${active ? " active" : ""}`;
    chip.setAttribute("aria-pressed", active ? "true" : "false");
    if (active && color) chip.style.backgroundColor = color;
    if (dot) {
      const dotEl = document.createElement("span");
      dotEl.className = "filter-chip-dot";
      dotEl.style.backgroundColor = active ? "#fff" : color;
      chip.append(dotEl);
    }
    const txt = document.createElement("span");
    txt.textContent = label;
    chip.append(txt);
    chip.addEventListener("click", onClick);
    return chip;
  };

  for (const kind of DESK_STATUS_FILTERS) {
    const active = _statusFilter === kind;
    bar.append(
      makeChip({
        label: DESK_STATUS_LABELS[kind],
        active,
        color: _STATUS_COLORS[kind],
        dot: kind !== "all",
        onClick: () => {
          _statusFilter = kind;
          _saveFilterState();
          renderFilterChips(items);
          applyUnifiedDeskFilter();
          renderColleagues();
          updateMyDeskFocusButton();
        },
      }),
    );
  }

  const types = [...new Set(items.map((d) => d.space_type || "desk"))];
  if (types.length > 1) {
    bar.append(
      makeChip({
        label: "Тип: все",
        active: _activeSpaceFilters.size === 0,
        color: "#475569",
        onClick: () => {
          _activeSpaceFilters.clear();
          _saveFilterState();
          renderFilterChips(items);
          applyUnifiedDeskFilter();
          renderColleagues();
        },
      }),
    );
    for (const t of types) {
      const active = _activeSpaceFilters.has(t);
      const color = _SF_COLORS[t] || "#64748b";
      bar.append(
        makeChip({
          label: _SF_LABELS[t] || t,
          active,
          color,
          dot: true,
          onClick: () => {
            if (_activeSpaceFilters.has(t)) _activeSpaceFilters.delete(t);
            else _activeSpaceFilters.add(t);
            _saveFilterState();
            renderFilterChips(items);
            applyUnifiedDeskFilter();
            renderColleagues();
          },
        }),
      );
    }
  }

  bar.append(
    makeChip({
      label: "☆ Избранные",
      active: _favFilterActive,
      color: "#f59e0b",
      onClick: () => {
        _favFilterActive = !_favFilterActive;
        if (_favFilterActive) _teamFilterActive = false;
        _saveFilterState();
        renderFilterChips(items);
        applyUnifiedDeskFilter();
        renderColleagues();
      },
    }),
  );

  bar.append(
    makeChip({
      label: "👥 Команда",
      active: _teamFilterActive,
      color: "#7c3aed",
      onClick: () => {
        _teamFilterActive = !_teamFilterActive;
        if (_teamFilterActive) _favFilterActive = false;
        _saveFilterState();
        renderFilterChips(items);
        applyUnifiedDeskFilter();
        renderColleagues();
      },
    }),
  );
}

function renderPlanMarkersFiltered() {
  renderPlanMarkers(deskSvgOverlay, state.desks);
}

// ── Events ──────────────────────────────────────────────────────────────────

quickDateTodayBtn?.addEventListener("click", () => setDatePreset("today"));
quickDateTomorrowBtn?.addEventListener("click", () => setDatePreset("tomorrow"));
quickDateCustomBtn?.addEventListener("click", () => {
  _datePreset = "custom";
  _applyDatePresetButtons();
  updateTimeWindowIndicator();
  if (typeof dateInput?.showPicker === "function") {
    try { dateInput.showPicker(); } catch { /* no-op */ }
  }
});

officeSelect.addEventListener("change", (e) => {
  localStorage.setItem("dk_office", e.target.value);
  loadFloors(e.target.value);
  loadPolicies(e.target.value);
});

floorSelect.addEventListener("change", (e) => {
  const floorId = e.target.value;
  localStorage.setItem("dk_floor", floorId);
  state.desks = [];
  loadDesks(floorId);
  const floor = state.floors.find((f) => String(f.id) === String(floorId));
  renderFloorPlan(floor);
});

refreshBookings.addEventListener("click", () => loadMyBookings());

// Debounce auto-refresh when date/time params change
let _refreshDebounce;
function debouncedRefresh() {
  clearTimeout(_refreshDebounce);
  _refreshDebounce = setTimeout(refreshAvailability, 400);
}
dateInput.addEventListener("change", debouncedRefresh);
dateInput.addEventListener("change", syncDatePresetFromInput);
startInput.addEventListener("change", () => {
  updateTimeWindowIndicator();
  debouncedRefresh();
});
endInput.addEventListener("change", () => {
  updateTimeWindowIndicator();
  debouncedRefresh();
});

// Policies accordion toggle
document.getElementById("policies-toggle")?.addEventListener("click", () => {
  if (!policiesAccordion) return;
  const isOpen = policiesAccordion.classList.toggle("open");
  const btn = document.getElementById("policies-toggle");
  if (btn) btn.textContent = isOpen ? "Правила ▴" : "Правила ▾";
});

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem("user_token");
  localStorage.removeItem("user_username");
  window.location.href = "./login.html";
});

// ── Notification drawer events ────────────────────────────────────────────────

document.getElementById("notif-bell")?.addEventListener("click", openNotifDrawer);
document.getElementById("notif-drawer-close")?.addEventListener("click", closeNotifDrawer);
document.getElementById("notif-backdrop")?.addEventListener("click", closeNotifDrawer);
document.getElementById("notif-clear-btn")?.addEventListener("click", () => {
  _notifHistory = []; _notifUnread = 0;
  _notifSave(); _notifUpdateBadge(); _notifRenderDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (appLayoutEl?.classList.contains("params-sheet-open")) {
      setParamsSheetOpen(false);
      return;
    }
    if (_isDrawerOpen) {
      closeNotifDrawer();
      return;
    }
    if (document.getElementById("profile-modal-overlay")?.classList.contains("open")) {
      closeProfileModal();
      return;
    }
    if (_isMobileViewport() && _sheetState !== "collapsed") {
      setSheetState("collapsed");
    }
  }
});

document.getElementById("profile-modal-overlay")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeProfileModal();
});

// ── Panel tabs ────────────────────────────────────────────────────────────────

document.querySelectorAll(".panel-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    setActivePanelTab(btn.dataset.tab, { promoteMobile: true });
  });
});

// ── Navigate to desk (cross-floor / cross-office) ────────────────────────────

async function navigateToDesk(officeId, floorId, deskId, opts = {}) {
  const { showArrow = false, plumbobUsername = null } = opts;

  // Clear stale pending state so intermediate re-renders don't consume it
  _pendingFocusDeskId = null;
  _pendingFocusWithArrow = false;
  _pendingPlumbobUsername = null;

  // Switch office if needed
  if (String(officeSelect.value) !== String(officeId)) {
    officeSelect.value = String(officeId);
    localStorage.setItem("dk_office", String(officeId));
    await loadFloors(officeId);
    loadPolicies(officeId);
  }

  // Switch floor if needed
  let floorChanged = false;
  if (String(floorSelect.value) !== String(floorId)) {
    floorSelect.value = String(floorId);
    localStorage.setItem("dk_floor", String(floorId));
    state.desks = [];
    await loadDesks(floorId);
    const floor = state.floors.find(f => String(f.id) === String(floorId));
    await renderFloorPlan(floor);
    floorChanged = true;
  }

  // PNG path: renderFloorPlan returns before image onload — delegate to fitFloorPlan
  if (floorChanged && !_currentLayout && !_currentRevision) {
    _pendingFocusDeskId = deskId;
    _pendingFocusWithArrow = showArrow;
    _pendingPlumbobUsername = plumbobUsername;
    return;
  }

  // Inline SVG / layout path, or same floor: rendering is complete, act directly
  setTimeout(() => {
    centerOnMarker(deskId, 4.0);
    highlightDesk(deskId);
    clearDeskSearchArrow();
    if (showArrow) showDeskSearchArrow(deskId);
    if (plumbobUsername) showColleaguePlumbob(deskId, plumbobUsername);
    const markerEl = _findMarkerElByDeskId(deskId);
    const deskObj  = state.desks.find(d => d.id === deskId);
    if (markerEl && deskObj) showSidePanel(markerEl, deskObj);
  }, 150);
}

// ── Colleague search ─────────────────────────────────────────────────────────

(function initColleagueSearch() {
  const searchInput   = document.getElementById("colleague-search");
  const dropdown      = document.getElementById("search-dropdown");
  const clearBtn      = document.getElementById("colleague-search-clear");
  if (!searchInput || !dropdown) return;

  let _debounceTimer = null;

  function closeDropdown() {
    dropdown.style.display = "none";
    dropdown.innerHTML = "";
  }

  function clearSearch() {
    searchInput.value = "";
    clearBtn.style.display = "none";
    closeDropdown();
    highlightDesk(null);
    clearDeskSearchArrow();
  }

  function renderDropdown(users) {
    dropdown.innerHTML = "";
    if (!users.length) {
      dropdown.innerHTML = '<div class="search-empty">Никого не найдено</div>';
      dropdown.style.display = "";
      return;
    }
    for (const u of users) {
      const displayName = u.full_name || u.username;
      const initials    = displayName.slice(0, 2).toUpperCase();
      const sub         = [u.department, u.position].filter(Boolean).join(" · ") || u.username;
      const loc         = u.location;

      // Location line: office · floor · desk (or "Нет брони на эту дату")
      let locLine = "";
      if (loc) {
        const parts = [loc.office_name, loc.floor_name, loc.desk_label].filter(Boolean);
        locLine = parts.join(" · ");
      } else if (dateInput?.value) {
        locLine = "Нет брони на эту дату";
      }

      // Is the user on a different floor than currently selected?
      const onOtherFloor = loc && String(loc.floor_id) !== String(floorSelect.value);
      const isTeamMember = state.team.has(u.username);
      const teamBadge    = isTeamMember ? `<span class="search-team-badge">Моя команда</span>` : "";

      const item = document.createElement("div");
      item.className = "search-result-item";
      item.innerHTML = `
        <div class="search-result-avatar${isTeamMember ? " is-team" : ""}">${initials}</div>
        <div class="search-result-info">
          <div class="search-result-name">${displayName}${teamBadge}</div>
          <div class="search-result-sub">${sub}</div>
          ${locLine ? `<div class="search-result-loc${loc ? "" : " search-result-loc--empty"}">${locLine}</div>` : ""}
        </div>
        ${onOtherFloor ? `<button class="search-goto-btn" data-desk="${loc.desk_id}" data-floor="${loc.floor_id}" data-office="${loc.office_id}">Перейти →</button>` : ""}`;

      // Click on item (not the button) — focus on current floor if possible
      item.addEventListener("mousedown", (e) => {
        if (e.target.closest(".search-goto-btn")) return; // handled below
        e.preventDefault();
        searchInput.value = displayName;
        clearBtn.style.display = "";
        closeDropdown();

        if (loc && String(loc.floor_id) === String(floorSelect.value)) {
          // Same floor — highlight, center and arrow pointer.
          focusDeskOnMap(loc.desk_id, { withArrow: true });
        } else if (loc && onOtherFloor) {
          // Different floor — navigate automatically and keep pointer arrow.
          navigateToDesk(loc.office_id, loc.floor_id, loc.desk_id, { showArrow: true });
        } else {
          clearDeskSearchArrow();
          addMessage(`У ${displayName} нет активной брони`, "info");
        }
      });

      // "Перейти →" button
      const gotoBtn = item.querySelector(".search-goto-btn");
      if (gotoBtn) {
        gotoBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          searchInput.value = displayName;
          clearBtn.style.display = "";
          closeDropdown();
          navigateToDesk(
            parseInt(gotoBtn.dataset.office),
            parseInt(gotoBtn.dataset.floor),
            parseInt(gotoBtn.dataset.desk),
            { showArrow: true },
          );
        });
      }

      dropdown.append(item);
    }
    dropdown.style.display = "";
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    clearBtn.style.display = q ? "" : "none";
    clearTimeout(_debounceTimer);

    if (q.length < 2) { closeDropdown(); return; }

    dropdown.innerHTML = '<div class="search-empty">Поиск...</div>';
    dropdown.style.display = "";

    _debounceTimer = setTimeout(async () => {
      try {
        const rd = dateInput?.value || "";
        const st = startInput?.value || "";
        const et = endInput?.value || "";
        let url = `/users/search?q=${encodeURIComponent(q)}&limit=10`;
        if (rd) url += `&date=${encodeURIComponent(rd)}`;
        if (st) url += `&start_time=${encodeURIComponent(st)}`;
        if (et) url += `&end_time=${encodeURIComponent(et)}`;
        const users = await apiRequest(url);
        renderDropdown(users);
      } catch {
        closeDropdown();
      }
    }, 300);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearSearch();
  });

  clearBtn.addEventListener("click", clearSearch);

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#colleague-search-bar")) closeDropdown();
  });
})();

// ── Init ────────────────────────────────────────────────────────────────────

let _responsiveUiBound = false;
function initResponsiveUiState() {
  setParamsSheetOpen(false);
  setSheetState(_sheetState, { persist: false });
  setActivePanelTab(_activePanelTab);
  updateSheetMiniSummary();

  if (_responsiveUiBound) return;
  _responsiveUiBound = true;
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!_isMobileViewport()) setParamsSheetOpen(false);
      setSheetState(_sheetState, { persist: false });
    }, 80);
  });
}

async function init() {
  if (window.lucide) lucide.createIcons();
  bindMapControlsOnce();
  initParamsSheetInteractions();
  initMobileSheetInteractions();
  initResponsiveUiState();
  updateTimeWindowIndicator();
  updateFitButtonsUI();
  _notifLoad();
  await checkApi();
  await loadOffices();

  const savedOffice = localStorage.getItem("dk_office");
  const savedFloor  = localStorage.getItem("dk_floor");
  const officeCandidate = savedOffice && state.offices.some(o => String(o.id) === String(savedOffice))
    ? String(savedOffice)
    : (state.offices[0] ? String(state.offices[0].id) : "");

  if (officeCandidate) {
    officeSelect.value = officeCandidate;
    localStorage.setItem("dk_office", officeCandidate);
    await loadFloors(officeCandidate);
    await loadPolicies(officeCandidate);

    const floorCandidate = savedFloor && state.floors.some(f => String(f.id) === String(savedFloor))
      ? String(savedFloor)
      : (state.floors[0] ? String(state.floors[0].id) : "");

    if (floorCandidate) {
      floorSelect.value = floorCandidate;
      localStorage.setItem("dk_floor", floorCandidate);
      const floor = state.floors.find(f => String(f.id) === String(floorCandidate));
      renderFloorPlan(floor);
      await loadDesks(floorCandidate);
    }
  }

  await Promise.all([loadFavorites(), loadTeam()]);
  await loadMyBookings();

  // Handle ?find=<username> from profile "Найти на карте"
  const findParam = new URLSearchParams(window.location.search).get("find");
  if (findParam) {
    // Clean URL without reload
    history.replaceState(null, "", window.location.pathname);
    try {
      const selectedDate = (dateInput?.value || _isoLocalDate(new Date()));
      const st    = startInput?.value || "";
      const et    = endInput?.value  || "";
      let url = `/users/search?q=${encodeURIComponent(findParam)}&limit=5&date=${selectedDate}`;
      if (st) url += `&start_time=${encodeURIComponent(st)}`;
      if (et) url += `&end_time=${encodeURIComponent(et)}`;
      const results = await apiRequest(url);
      const user = results.find(u => u.username === findParam) || results[0];
      if (user?.location) {
        const loc = user.location;
        navigateToDesk(loc.office_id, loc.floor_id, loc.desk_id, { showArrow: false, plumbobUsername: user.username || findParam });
      } else if (user) {
        addMessage(`У ${user.full_name || findParam} нет брони на выбранный день`, "info");
      }
    } catch { /* silent */ }
  }
}

init();
