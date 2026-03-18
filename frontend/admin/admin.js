const API_BASE = "/api";

// ── Pagination ────────────────────────────────────────────────────────────────
var _pages = {};
var PAGE_SIZE = 15;

function _getPage(tableId) { return _pages[tableId] || 1; }
function _setPage(tableId, p) { _pages[tableId] = p; }

function renderPagination(containerId, total, tableId) {
  var el = document.getElementById(containerId);
  if (!el) return;
  var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  var cur = Math.min(_getPage(tableId), totalPages);
  _setPage(tableId, cur);
  var from = (cur - 1) * PAGE_SIZE + 1;
  var to   = Math.min(cur * PAGE_SIZE, total);
  el.innerHTML = (
    '<span style="color:var(--text-2)">' + (total ? from + '–' + to + ' из ' + total : '0') + '</span>' +
    '<div style="display:flex;gap:4px">' +
      '<button onclick="changePage(\'' + tableId + '\',-1)" ' + (cur <= 1 ? 'disabled' : '') + ' class="btn btn-secondary btn-sm" style="padding:2px 8px">&#8249;</button>' +
      '<span style="padding:2px 8px;font-weight:500">' + cur + ' / ' + totalPages + '</span>' +
      '<button onclick="changePage(\'' + tableId + '\',1)" ' + (cur >= totalPages ? 'disabled' : '') + ' class="btn btn-secondary btn-sm" style="padding:2px 8px">&#8250;</button>' +
    '</div>'
  );
}

function changePage(tableId, delta) {
  _setPage(tableId, (_getPage(tableId) + delta));
  var reloaders = {
    offices:      loadOffices,
    floors:       loadFloors,
    desks:        loadDesks,
    reservations: loadReservations,
    departments:  loadDepartments,
    users:        loadUsers,
  };
  if (reloaders[tableId]) reloaders[tableId]();
}

function pageSlice(arr, tableId) {
  var cur  = _getPage(tableId);
  var from = (cur - 1) * PAGE_SIZE;
  return arr.slice(from, from + PAGE_SIZE);
}

const SPACE_LABELS = {
  desk: "Рабочий стол",
  meeting_room: "Переговорная",
  call_room: "Call-room",
  open_space: "Open Space",
  lounge: "Лаунж",
};

const SPACE_COLORS = {
  desk:         "#2563eb",
  meeting_room: "#7c3aed",
  call_room:    "#0891b2",
  open_space:   "#16a34a",
  lounge:       "#d97706",
};

const ADMIN_SIDEBAR_COLLAPSED_KEY = "admin_sidebar_collapsed";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginOverlay       = document.getElementById("login-overlay");
const loginError         = document.getElementById("login-error");
const adminApp           = document.getElementById("admin-app");
const sidebarUsername    = document.getElementById("sidebar-username");
const logoutBtn          = document.getElementById("logout-btn");
const adminSidebarToggle = document.getElementById("admin-sidebar-toggle");

// Tables
const officesBody      = document.getElementById("offices-body");
const floorsBody       = document.getElementById("floors-body");
const desksBody        = document.getElementById("desks-body");
const policiesBody     = document.getElementById("policies-body");
const reservationsBody = document.getElementById("reservations-body");

// Office form
const officeName    = document.getElementById("office-name");
const officeAddress = document.getElementById("office-address");

// Floor form
const floorOfficeSelect = document.getElementById("floor-office-select");
const floorName         = document.getElementById("floor-name");
const planFloorSelect   = document.getElementById("plan-floor-select");
const planFile          = document.getElementById("plan-file");

// Policy form
const policyOfficeSelect = document.getElementById("policy-office-select");
const policyName         = document.getElementById("policy-name");
const policyMinDays      = document.getElementById("policy-min-days");
const policyMaxDays      = document.getElementById("policy-max-days");
const policyMinDur       = document.getElementById("policy-min-dur");
const policyMaxDur       = document.getElementById("policy-max-dur");
const policyNoshow       = document.getElementById("policy-noshow");
const policyMaxPerDay    = document.getElementById("policy-max-per-day");

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute("aria-hidden", "false");
  el.classList.add("open");
  // Focus first input
  const first = el.querySelector("input, select");
  if (first) setTimeout(() => first.focus(), 60);
  if (window.lucide) lucide.createIcons({ nodes: [el] });
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute("aria-hidden", "true");
  el.classList.remove("open");
  // Reset edit state when modal is dismissed
  if (id === "modal-office")  _editOfficeId = null;
  if (id === "modal-floor")   _editFloorId  = null;
  if (id === "modal-policy")  _editPolicyId = null;
  if (id === "modal-dept")    _editDeptId   = null;
}
// Close on backdrop click or [data-close] button
document.addEventListener("click", (e) => {
  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) { closeModal(closeBtn.dataset.close); return; }
  if (e.target.classList.contains("adm-modal-overlay")) {
    closeModal(e.target.id);
  }
});
// Close on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".adm-modal-overlay.open").forEach(el => closeModal(el.id));
  }
});

// Open buttons (create mode — no item)
document.getElementById("open-office-modal")?.addEventListener("click", () => openOfficeModal(null));
document.getElementById("open-floor-modal")?.addEventListener("click", () => openFloorModal(null));
document.getElementById("open-upload-plan-modal")?.addEventListener("click", () => openModal("modal-upload-plan"));
document.getElementById("open-policy-modal")?.addEventListener("click", () => openPolicyModal(null));
document.getElementById("open-dept-modal")?.addEventListener("click", () => openDeptModal(null));

// ── Debounce ──────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  var t;
  return function () {
    var args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(null, args); }, ms);
  };
}

// ── Modal edit state ──────────────────────────────────────────────────────────
var _editOfficeId   = null;
var _editFloorId    = null;
var _editPolicyId   = null;
var _editDeptId     = null;

function _setModalMode(modalId, titleEl, btnEl, isEdit, createLabel, editLabel) {
  document.getElementById(titleEl).textContent = isEdit ? editLabel : createLabel;
  document.getElementById(btnEl).textContent   = isEdit ? "Сохранить" : createLabel;
}

function openOfficeModal(item) {
  _editOfficeId = item ? item.id : null;
  _setModalMode("modal-office", "modal-office-title", "create-office-btn",
    !!item, "Создать офис", "Редактировать офис");
  document.getElementById("office-name").value    = item ? (item.name    || "") : "";
  document.getElementById("office-address").value = item ? (item.address || "") : "";
  openModal("modal-office");
}

function openFloorModal(item) {
  _editFloorId = item ? item.id : null;
  _setModalMode("modal-floor-title", "modal-floor-title", "create-floor-btn",
    !!item, "Создать этаж", "Редактировать этаж");
  document.getElementById("modal-floor-title").textContent = item ? "Редактировать этаж" : "Создать этаж";
  document.getElementById("create-floor-btn").textContent  = item ? "Сохранить" : "Создать этаж";
  var offSel = document.getElementById("floor-office-select");
  if (item && offSel) offSel.value = item.office_id || "";
  document.getElementById("floor-name").value = item ? (item.name || "") : "";
  openModal("modal-floor");
}

function openUploadPlanModal(floorId) {
  if (floorId && planFloorSelect) planFloorSelect.value = floorId;
  openModal("modal-upload-plan");
}

function openPolicyModal(item) {
  _editPolicyId = item ? item.id : null;
  document.getElementById("modal-policy-title").textContent = item ? "Редактировать политику" : "Создать политику";
  document.getElementById("create-policy-btn").textContent  = item ? "Сохранить" : "Создать политику";
  var offSel = document.getElementById("policy-office-select");
  if (item && offSel) offSel.value = item.office_id || "";
  document.getElementById("policy-name").value        = item ? (item.name                    || "")  : "";
  document.getElementById("policy-min-days").value    = item ? (item.min_days_ahead           ?? 0)  : 0;
  document.getElementById("policy-max-days").value    = item ? (item.max_days_ahead           ?? 30) : 30;
  document.getElementById("policy-min-dur").value     = item ? (item.min_duration_minutes     ?? 30) : 30;
  document.getElementById("policy-max-dur").value     = item ? (item.max_duration_minutes     ?? 480): 480;
  document.getElementById("policy-noshow").value      = item ? (item.no_show_timeout_minutes  ?? 15) : 15;
  var mpd = document.getElementById("policy-max-per-day");
  if (mpd) mpd.value = item ? (item.max_bookings_per_day ?? 1) : 1;
  // Open advanced section if editing and any advanced field differs from defaults
  var details = document.getElementById("policy-advanced-details");
  if (details) {
    var hasAdvanced = item && (
      (item.min_duration_minutes ?? 30)  !== 30  ||
      (item.max_duration_minutes ?? 480) !== 480 ||
      (item.no_show_timeout_minutes ?? 15) !== 15 ||
      (item.max_bookings_per_day ?? 1) !== 1
    );
    details.open = !!hasAdvanced;
  }
  openModal("modal-policy");
}

function openDeptModal(item) {
  _editDeptId = item ? item.id : null;
  document.getElementById("modal-dept-title").textContent = item ? "Редактировать отдел" : "Создать отдел";
  document.getElementById("add-dept-btn").textContent     = item ? "Сохранить" : "Создать отдел";
  document.getElementById("dept-name").value = item ? (item.name || "") : "";
  openModal("modal-dept");
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  offices: [],
  floors: [],
  desks: [],
  policies: [],
  reservations: [],
};

// ── Auth ──────────────────────────────────────────────────────────────────────
function getToken() {
  return localStorage.getItem("admin_token");
}

function setToken(token, username) {
  localStorage.setItem("admin_token", token);
  localStorage.setItem("admin_username", username);
  showAdminUI(username);
}

function clearToken() {
  localStorage.removeItem("admin_token");
  localStorage.removeItem("admin_username");
  showLoginOverlay();
}

function showAdminUI(username) {
  loginOverlay.classList.add("hidden");
  adminApp.classList.remove("hidden");
  sidebarUsername.textContent = username;
  applyAdminSidebarState(isAdminSidebarCollapsed(), false);
  if (window.lucide) lucide.createIcons();
  // Set initial breadcrumb (offices tab is active by default)
  setBreadcrumbs([{ label: "Офисы", icon: "building-2" }]);
}

function isAdminSidebarCollapsed() {
  return localStorage.getItem(ADMIN_SIDEBAR_COLLAPSED_KEY) === "1";
}

function applyAdminSidebarState(collapsed, persist) {
  if (adminApp) adminApp.classList.toggle("sidebar-collapsed", !!collapsed);
  if (adminSidebarToggle) {
    adminSidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    adminSidebarToggle.title = collapsed ? "Показать меню" : "Скрыть меню";
  }
  if (persist !== false) {
    localStorage.setItem(ADMIN_SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  }
}

function initAdminSidebarToggle() {
  if (!adminSidebarToggle) return;
  applyAdminSidebarState(isAdminSidebarCollapsed(), false);
  adminSidebarToggle.addEventListener("click", function () {
    applyAdminSidebarState(!adminApp.classList.contains("sidebar-collapsed"), true);
  });
}

function showLoginOverlay() {
  loginOverlay.classList.remove("hidden");
  adminApp.classList.add("hidden");
}

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(text, type) {
  type = type || "info";
  var container = document.getElementById("admin-toast");
  if (!container) return;
  var item = document.createElement("div");
  item.className = "admin-toast-item " + type;
  item.textContent = text;
  container.prepend(item);
  requestAnimationFrame(function () { item.classList.add("visible"); });
  var duration = type === "error" ? 7000 : 3500;
  setTimeout(function () {
    item.classList.remove("visible");
    setTimeout(function () { item.remove(); }, 300);
  }, duration);
}

// Backwards compat alias
function addMessage(text, type) { showToast(text, type); }

function authHeader() {
  var token = getToken();
  return token ? { Authorization: "Bearer " + token } : {};
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function apiRequest(path, options) {
  options = options || {};
  const token = getToken();
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    token ? { Authorization: "Bearer " + token } : {},
    options.headers || {}
  );
  const response = await fetch(API_BASE + path, Object.assign({}, options, { headers: headers }));
  if (!response.ok) {
    const body = await response.json().catch(function () { return {}; });
    throw new Error(body.detail || ("Ошибка " + response.status));
  }
  if (response.status === 204) return null;
  return response.json();
}

function makeDeleteBtn(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "btn btn-danger btn-sm";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

// ── Confirm delete modal ───────────────────────────────────────────────────────
var _confirmCallback = null;
document.getElementById("confirm-modal-ok").addEventListener("click", function () {
  closeModal("modal-confirm");
  if (_confirmCallback) { var cb = _confirmCallback; _confirmCallback = null; cb(); }
});
function confirmDelete(title, message, onConfirm) {
  document.getElementById("confirm-modal-title").textContent = title;
  document.getElementById("confirm-modal-message").textContent = message;
  _confirmCallback = onConfirm;
  openModal("modal-confirm");
}

// ── Actions menu (⋮) ──────────────────────────────────────────────────────────
function closeActionsMenus() {
  document.querySelectorAll(".adm-actions-wrap.open").forEach(function (w) { w.classList.remove("open"); });
}
document.addEventListener("click", closeActionsMenus);
window.addEventListener("scroll", closeActionsMenus, true);
window.addEventListener("resize", closeActionsMenus);

function positionActionsMenu(btn, menu) {
  var r = btn.getBoundingClientRect();
  var menuH = menu.offsetHeight || 120; // estimated before first paint
  var menuW = menu.offsetWidth  || 164;
  var GAP   = 4;
  var vh    = window.innerHeight;
  var vw    = window.innerWidth;

  // Horizontal: align right edge to button right, clamp to viewport
  var left = r.right - menuW;
  if (left < 8) left = 8;
  if (left + menuW > vw - 8) left = vw - menuW - 8;

  // Vertical: open below by default, flip above if not enough space
  var top;
  if (r.bottom + GAP + menuH > vh - 8) {
    top = r.top - GAP - menuH; // open upward
  } else {
    top = r.bottom + GAP;
  }

  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
}

function makeActionsMenu(items) {
  var wrap = document.createElement("div");
  wrap.className = "adm-actions-wrap";

  var btn = document.createElement("button");
  btn.className = "btn btn-secondary btn-sm adm-actions-btn";
  btn.title = "Действия";
  btn.innerHTML = '<i data-lucide="more-horizontal" style="width:15px;height:15px"></i>';

  var menu = document.createElement("div");
  menu.className = "adm-actions-menu";

  items.forEach(function (item) {
    var mi = document.createElement("button");
    mi.className = "adm-actions-item" + (item.danger ? " danger" : "");
    mi.innerHTML = '<i data-lucide="' + item.icon + '" style="width:14px;height:14px"></i> ' + item.label;
    mi.addEventListener("click", function (e) {
      e.stopPropagation();
      closeActionsMenus();
      item.onClick();
    });
    menu.append(mi);
  });

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var isOpen = wrap.classList.contains("open");
    closeActionsMenus();
    if (!isOpen) {
      // Show first so browser can measure real dimensions, then reposition
      wrap.classList.add("open");
      if (window.lucide) lucide.createIcons({ nodes: [wrap] });
      // rAF ensures menu is rendered before measuring
      requestAnimationFrame(function() { positionActionsMenu(btn, menu); });
    }
  });

  wrap.append(btn, menu);
  return wrap;
}

// makeActionCell(primaryEl?, menuItems?) → standardised action cell wrapper
function makeActionCell(primaryEl, menuItems) {
  var wrap = document.createElement("div");
  wrap.className = "adm-action-cell";
  if (primaryEl) wrap.append(primaryEl);
  if (menuItems && menuItems.length) wrap.append(makeActionsMenu(menuItems));
  return wrap;
}

// makePrimaryBtn(label, icon, onClick) → consistent primary action button
function makePrimaryBtn(label, icon, onClick) {
  var btn = document.createElement("button");
  btn.className = "btn btn-secondary btn-sm adm-primary-action";
  btn.innerHTML = '<i data-lucide="' + icon + '" style="width:13px;height:13px"></i> ' + label;
  btn.addEventListener("click", onClick);
  return btn;
}

function makeCancelBtn(reservationId) {
  return makeDeleteBtn("Отменить", async function () {
    if (!confirm("Отменить это бронирование?")) return;
    try {
      await apiRequest("/reservations/" + reservationId + "/cancel", { method: "POST" });
      showToast("Бронирование отменено.", "success");
      await loadReservations();
    } catch (e) {
      showToast("Ошибка: " + e.message, "error");
    }
  });
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function checkApi() {
  try {
    await apiRequest("/health");
  } catch {
    showToast("API недоступно. Убедитесь, что backend запущен.", "error");
  }
}

async function loadOffices() {
  try {
    state.offices = await apiRequest("/offices");
    renderOfficesTable();
    populateOfficeSelects();
  } catch (e) {
    showToast("Не удалось загрузить офисы: " + e.message, "error");
  }
}

async function loadFloors() {
  try {
    state.floors = await apiRequest("/floors");
    renderFloorsTable();
    populateFloorSelects();
  } catch (e) {
    showToast("Не удалось загрузить этажи: " + e.message, "error");
  }
}

async function loadDesks() {
  try {
    state.desks = await apiRequest("/desks");
    renderDesksTable();
  } catch (e) {
    showToast("Не удалось загрузить рабочие места: " + e.message, "error");
  }
}

async function loadPolicies() {
  try {
    state.policies = await apiRequest("/policies");
    renderPoliciesTable();
  } catch (e) {
    showToast("Не удалось загрузить политики: " + e.message, "error");
  }
}

async function loadReservations() {
  try {
    const officeId = document.getElementById("filter-office").value;
    const dateFrom = document.getElementById("filter-date-from").value;
    const dateTo   = document.getElementById("filter-date-to").value;
    const userId   = document.getElementById("filter-user").value.trim();
    const status   = document.getElementById("filter-status").value;

    const qs = new URLSearchParams();
    if (officeId) qs.set("office_id", officeId);
    if (dateFrom) qs.set("date_from", dateFrom);
    if (dateTo)   qs.set("date_to", dateTo);
    if (userId)   qs.set("user_id", userId);
    if (status)   qs.set("status", status);

    const query = qs.toString();
    state.reservations = await apiRequest("/reservations" + (query ? "?" + query : ""));
    renderReservationsTable();
  } catch (e) {
    showToast("Не удалось загрузить бронирования: " + e.message, "error");
  }
}

var _anlPeriod = "day";

function renderTrend(elId, pct, invertGood) {
  var el = document.getElementById(elId);
  if (!el) return;
  if (pct === null || pct === undefined) { el.textContent = ""; return; }
  var up = pct >= 0;
  var good = invertGood ? !up : up;  // for cancelled/noshow: up is bad
  var arrow = up ? "↑" : "↓";
  var abs = Math.abs(pct);
  el.textContent = arrow + " " + abs + "%";
  el.className = "anl-trend " + (good ? "anl-trend-up" : "anl-trend-down");
}

async function loadAnalytics() {
  try {
    const data = await apiRequest("/analytics?period=" + _anlPeriod);

    var labels = { day: "сегодня", week: "за неделю", month: "за месяц" };
    var lbl = document.getElementById("kpi-today-label");
    if (lbl) lbl.textContent = "Бронирований " + (labels[_anlPeriod] || "");

    document.getElementById("kpi-today").textContent     = data.total_today;
    document.getElementById("kpi-active").textContent    = data.total_active;
    document.getElementById("kpi-cancelled").textContent = data.total_cancelled;
    document.getElementById("kpi-noshow").textContent    = data.noshow_rate + "%";

    renderTrend("trend-today",     data.trend_today,     false);
    renderTrend("trend-active",    data.trend_active,    false);
    renderTrend("trend-cancelled", data.trend_cancelled, true);
    renderTrend("trend-noshow",    data.trend_noshow,    true);

    const occupancyEl = document.getElementById("occupancy-list");
    occupancyEl.innerHTML = "";
    if (!data.occupancy_by_office || !data.occupancy_by_office.length) {
      occupancyEl.innerHTML = '<p class="empty">Нет данных</p>';
    } else {
      data.occupancy_by_office.forEach(function (o) {
        const row = document.createElement("div");
        row.style.cssText = "margin-bottom:12px";
        row.innerHTML = (
          '<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:13px">' +
            '<span style="font-weight:500">' + o.office_name + '</span>' +
            '<span style="color:var(--text-2)">' + o.booked_today + ' / ' + o.total_desks + ' мест (' + o.occupancy_pct + '%)</span>' +
          '</div>' +
          '<div style="background:var(--border);border-radius:4px;height:8px;overflow:hidden">' +
            '<div style="height:100%;background:var(--accent);border-radius:4px;width:' + o.occupancy_pct + '%;transition:width .4s"></div>' +
          '</div>'
        );
        occupancyEl.append(row);
      });
    }

    const topDesksBody = document.getElementById("top-desks-body");
    topDesksBody.innerHTML = (data.top_desks && data.top_desks.length)
      ? data.top_desks.map(function (d) {
          return "<tr><td>" + d.label + "</td><td>" + d.floor_name + "</td><td>" + d.office_name + "</td><td><strong>" + d.total + "</strong></td></tr>";
        }).join("")
      : '<tr><td colspan="4" class="empty">Нет данных</td></tr>';

    const topUsersBody = document.getElementById("top-users-body");
    topUsersBody.innerHTML = (data.top_users && data.top_users.length)
      ? data.top_users.map(function (u) {
          return "<tr><td>" + u.user_id + "</td><td><strong>" + u.total + "</strong></td></tr>";
        }).join("")
      : '<tr><td colspan="2" class="empty">Нет данных</td></tr>';

    var chartEl = document.getElementById("desks-chart");
    if (chartEl && data.top_desks && data.top_desks.length) {
      var maxVal = data.top_desks[0].total || 1;
      chartEl.innerHTML = data.top_desks.slice(0, 10).map(function (d) {
        var pct = Math.round(d.total / maxVal * 100);
        return (
          '<div style="display:flex;align-items:center;gap:10px;font-size:13px">' +
            '<span style="width:120px;text-align:right;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + d.label + '">' + d.label + '</span>' +
            '<div style="flex:1;background:var(--border);border-radius:4px;height:20px;overflow:hidden">' +
              '<div style="height:100%;background:var(--accent);border-radius:4px;width:' + pct + '%;transition:width .4s;display:flex;align-items:center;padding-left:6px">' +
                '<span style="font-size:11px;font-weight:600;color:white;white-space:nowrap">' + (pct > 15 ? d.total : '') + '</span>' +
              '</div>' +
            '</div>' +
            '<span style="width:24px;font-weight:600">' + d.total + '</span>' +
          '</div>'
        );
      }).join('');
    } else if (chartEl) {
      chartEl.innerHTML = '<p class="empty">Нет данных</p>';
    }

  } catch (e) {
    showToast("Аналитика: " + e.message, "error");
  }
}

async function loadAll() {
  await loadOffices();
  await Promise.all([loadFloors(), loadPolicies(), loadReservations(), loadDepartments()]);
  await loadDesks();
  await loadAnalytics();
}

// ── Skeleton loading ──────────────────────────────────────────────────────────

var SKELETON_COLS = {
  "offices-body":      6,
  "floors-body":       5,
  "desks-body":        7,
  "policies-body":     6,
  "reservations-body": 7,
  "departments-body":  4,
  "users-body":        8,
};

function showSkeleton(tbodyId) {
  var tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  var cols = SKELETON_COLS[tbodyId] || 4;
  var rows = "";
  for (var i = 0; i < 3; i++) {
    rows += "<tr>";
    for (var j = 0; j < cols; j++) {
      rows += '<td><span class="adm-skeleton"></span></td>';
    }
    rows += "</tr>";
  }
  tbody.innerHTML = rows;
}

function showSkeletonForTab(tab) {
  var map = {
    offices:      ["offices-body"],
    floors:       ["floors-body"],
    desks:        ["desks-body"],
    policies:     ["policies-body"],
    reservations: ["reservations-body"],
    departments:  ["departments-body"],
    users:        ["users-body"],
  };
  (map[tab] || []).forEach(showSkeleton);
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────

var AUTO_REFRESH_MS = 60000;  // 1 minute
var _autoRefreshTimer = null;
var _currentTab = "offices";
var _isAutoRefresh = false;

var TAB_LOADERS = {
  offices:      function() { return loadOffices(); },
  floors:       function() { return loadFloors(); },
  desks:        function() { return loadDesks(); },
  policies:     function() { return loadPolicies(); },
  reservations: function() { return loadReservations(); },
  departments:  function() { return loadDepartments(); },
  analytics:    function() { return loadAnalytics(); },
  users:        function() { return loadUsers(); },
};

function startAutoRefresh(tab) {
  stopAutoRefresh();
  var loader = TAB_LOADERS[tab];
  if (!loader) return;
  _autoRefreshTimer = setInterval(async function() {
    _isAutoRefresh = true;
    spinRefreshBtn(tab, true);
    showSkeletonForTab(tab);
    try {
      await loader();
      showToast("Данные обновлены", "info");
    } finally {
      _isAutoRefresh = false;
      spinRefreshBtn(tab, false);
    }
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
}

// ── Refresh button spin animation ─────────────────────────────────────────────

function spinRefreshBtn(tab, spinning) {
  var idMap = {
    offices: "refresh-offices", floors: "refresh-floors", desks: "refresh-desks",
    policies: "refresh-policies", reservations: "refresh-reservations",
    departments: "refresh-departments", analytics: "refresh-analytics", users: "refresh-users",
  };
  var btn = document.getElementById(idMap[tab]);
  if (btn) btn.classList.toggle("adm-refresh-spinning", spinning);
}

// ── Render helpers ────────────────────────────────────────────────────────────
function getOfficeName(officeId) {
  var o = state.offices.find(function (o) { return o.id === officeId; });
  return o ? o.name : String(officeId);
}

function getFloorName(floorId) {
  var f = state.floors.find(function (f) { return f.id === floorId; });
  return f ? f.name + " (" + getOfficeName(f.office_id) + ")" : String(floorId);
}

// ── Render tables ─────────────────────────────────────────────────────────────
function renderOfficesTable() {
  officesBody.innerHTML = "";
  var q = (document.getElementById("offices-search")?.value || "").trim().toLowerCase();
  var offices = q
    ? state.offices.filter(function (o) {
        return o.name.toLowerCase().includes(q) || (o.address || "").toLowerCase().includes(q);
      })
    : state.offices;
  if (!offices.length) {
    officesBody.innerHTML = '<tr><td colspan="6" class="empty">' + (q ? "Ничего не найдено." : "Нет офисов.") + '</td></tr>';
    renderPagination('offices-pagination', 0, 'offices');
    return;
  }
  var slice = pageSlice(offices, 'offices');
  slice.forEach(function (o) {
    var floorCount = state.floors.filter(function (f) { return f.office_id === o.id; }).length;
    var deskCount = state.desks.filter(function (d) {
      return state.floors.some(function (f) { return f.office_id === o.id && f.id === d.floor_id; });
    }).length;
    var tr = document.createElement("tr");
    tr.innerHTML = "<td>" + o.id + "</td><td>" + o.name + "</td><td>" + (o.address || "—") + "</td>" +
      "<td style='text-align:center'><span class='adm-badge'>" + floorCount + "</span></td>" +
      "<td style='text-align:center'><span class='adm-badge'>" + deskCount + "</span></td>" +
      "<td></td>";
    tr.querySelector("td:last-child").append(makeActionCell(
      makePrimaryBtn("Этажи", "layers", function () { drillToFloors(o); }),
      [
        { label: "Редактировать", icon: "pencil", onClick: function () { openOfficeModal(o); } },
        { label: "Удалить", icon: "trash-2", danger: true, onClick: function () {
          confirmDelete("Удалить офис?", "Вы уверены, что хотите удалить офис «" + o.name + "»? Это действие нельзя отменить.", async function () {
            try {
              await apiRequest("/offices/" + o.id, { method: "DELETE" });
              showToast("Офис «" + o.name + "» удалён.", "success");
              await loadAll();
            } catch (e) { showToast("Ошибка: " + e.message, "error"); }
          });
        }},
      ]
    ));
    officesBody.append(tr);
  });
  renderPagination('offices-pagination', offices.length, 'offices');
}

function drillToFloors(office) {
  _floorsOfficeFilter = office.id;
  // Switch to floors tab without clearing the filter
  document.querySelectorAll(".nav-item").forEach(function (b) { b.classList.remove("active"); });
  document.querySelectorAll(".tab-content").forEach(function (t) { t.classList.add("hidden"); });
  var btn = document.querySelector(".nav-item[data-tab='floors']");
  if (btn) btn.classList.add("active");
  document.getElementById("tab-floors").classList.remove("hidden");
  document.dispatchEvent(new CustomEvent("admin:tab-change", { detail: { tab: "floors" } }));
  renderFloorsTable();
  setBreadcrumbs([
    { label: "Офисы", icon: "building-2", onClick: function () { switchTab("offices"); } },
    { label: office.name },
    { label: "Этажи", icon: "layers" },
  ]);
}

function renderFloorsTable() {
  floorsBody.innerHTML = "";
  var q        = (document.getElementById("floors-search")?.value || "").trim().toLowerCase();
  var offSel   = document.getElementById("floors-office-filter");
  var offFilt  = _floorsOfficeFilter || (offSel ? Number(offSel.value) || null : null);
  var floors   = state.floors;
  if (offFilt) floors = floors.filter(function (f) { return f.office_id === offFilt; });
  if (q)       floors = floors.filter(function (f) { return f.name.toLowerCase().includes(q) || getOfficeName(f.office_id).toLowerCase().includes(q); });

  // Filter badge
  var filterBadge = document.getElementById("floors-filter-badge");
  if (_floorsOfficeFilter && filterBadge) {
    var oName = getOfficeName(_floorsOfficeFilter);
    filterBadge.innerHTML = 'Офис: <strong>' + oName + '</strong> &nbsp;' +
      '<button class="bc-clear-filter" title="Сбросить фильтр">' +
        '<i data-lucide="x" style="width:11px;height:11px"></i>' +
      '</button>';
    filterBadge.style.display = "";
    filterBadge.querySelector(".bc-clear-filter").addEventListener("click", function () {
      switchTab("floors");
    });
    if (window.lucide) lucide.createIcons({ nodes: [filterBadge] });
  } else if (filterBadge) {
    filterBadge.style.display = "none";
  }

  if (!floors.length) {
    floorsBody.innerHTML = '<tr><td colspan="5" class="empty">Нет этажей.</td></tr>';
    renderPagination('floors-pagination', 0, 'floors');
    return;
  }
  var slice = pageSlice(floors, 'floors');
  slice.forEach(function (f) {
    var tr = document.createElement("tr");
    tr.innerHTML = "<td>" + f.id + "</td><td>" + getOfficeName(f.office_id) + "</td><td>" + f.name + "</td><td></td><td></td>";

    // Plan column — primary action
    var planTd = tr.querySelectorAll("td")[3];
    var planPrimary;
    if (f.plan_url) {
      planPrimary = document.createElement("a");
      planPrimary.href = f.plan_url;
      planPrimary.target = "_blank";
      planPrimary.rel = "noopener";
      planPrimary.className = "adm-plan-btn";
      planPrimary.innerHTML = '<i data-lucide="map" style="width:13px;height:13px"></i> Открыть план';
    } else {
      planPrimary = document.createElement("span");
      planPrimary.className = "adm-plan-none";
      var uploadCta = document.createElement("button");
      uploadCta.className = "adm-plan-upload-cta";
      uploadCta.innerHTML = '<i data-lucide="upload" style="width:12px;height:12px"></i> Загрузить план';
      uploadCta.addEventListener("click", function () { openUploadPlanModal(f.id); });
      planPrimary.append(uploadCta);
    }
    planTd.append(planPrimary);

    // Actions column — secondary actions only
    tr.querySelector("td:last-child").append(makeActionsMenu([
      { label: "Редактировать", icon: "pencil", onClick: function () { openFloorModal(f); } },
      { label: f.plan_url ? "Заменить план" : "Загрузить план", icon: "upload", onClick: function () { openUploadPlanModal(f.id); } },
      { label: "Удалить", icon: "trash-2", danger: true, onClick: function () {
        confirmDelete("Удалить этаж?", "Вы уверены, что хотите удалить этаж «" + f.name + "»? Это действие нельзя отменить.", async function () {
          try {
            await apiRequest("/floors/" + f.id, { method: "DELETE" });
            showToast("Этаж «" + f.name + "» удалён.", "success");
            await loadAll();
          } catch (e) { showToast("Ошибка: " + e.message, "error"); }
        });
      }},
    ]));
    floorsBody.append(tr);
  });
  renderPagination('floors-pagination', floors.length, 'floors');
}

function _populateDeskFloorFilter() {
  var sel = document.getElementById("desks-floor-filter");
  if (!sel) return;
  var val = sel.value;
  sel.innerHTML = '<option value="">Все этажи</option>';
  state.floors.forEach(function (f) {
    var opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    sel.append(opt);
  });
  if (val) sel.value = val;
}

function renderDesksTable() {
  if (!desksBody) return;
  _populateDeskFloorFilter();
  var search = (document.getElementById("desks-search")?.value || "").toLowerCase().trim();
  var floorId = document.getElementById("desks-floor-filter")?.value || "";
  var items = state.desks.filter(function (d) {
    if (floorId && String(d.floor_id) !== String(floorId)) return false;
    if (search && !String(d.label || "").toLowerCase().includes(search)) return false;
    return true;
  });
  desksBody.innerHTML = "";
  if (!items.length) {
    desksBody.innerHTML = '<tr><td colspan="7" class="empty">Нет рабочих мест.</td></tr>';
    renderPagination('desks-pagination', 0, 'desks');
    return;
  }
  items.forEach(function (d) {
    var tr = document.createElement("tr");
    tr.innerHTML = (
      "<td>" + d.id + "</td>" +
      "<td>" + getFloorName(d.floor_id) + "</td>" +
      "<td>" + d.label + "</td>" +
      "<td>" + (d.type === "fixed" ? "Закреплённое" : "Гибкое") + "</td>" +
      "<td>" + (SPACE_LABELS[d.space_type] || d.space_type || "—") + "</td>" +
      "<td>" + (d.assigned_to || "—") + "</td>" +
      "<td></td>"
    );
    var actionCell = tr.querySelector("td:last-child");

    var qrBtn = document.createElement("button");
    qrBtn.className = "btn btn-secondary btn-sm adm-primary-action";
    qrBtn.innerHTML = '<i data-lucide="qr-code" style="width:13px;height:13px"></i> QR';
    qrBtn.title = "Показать QR-код для места «" + d.label + "»";
    qrBtn.addEventListener("click", async function () {
      var token = getToken();
      try {
        var resp = await fetch(API_BASE + "/desks/" + d.id + "/qr", {
          headers: token ? { Authorization: "Bearer " + token } : {},
        });
        if (!resp.ok) {
          var body = await resp.json().catch(function () { return {}; });
          showToast("Не удалось получить QR: " + (body.detail || resp.status), "error");
          return;
        }
        var blob = await resp.blob();
        window.open(URL.createObjectURL(blob), "_blank", "noopener");
      } catch (e) {
        showToast("Ошибка при загрузке QR: " + e.message, "error");
      }
    });

    actionCell.append(makeActionCell(qrBtn, [
      { label: "Удалить", icon: "trash-2", danger: true, onClick: function () {
        confirmDelete("Удалить место?", "Вы уверены, что хотите удалить место «" + d.label + "»? Это действие нельзя отменить.", async function () {
          try {
            await apiRequest("/desks/" + d.id, { method: "DELETE" });
            showToast("Место «" + d.label + "» удалено.", "success");
            await loadDesks();
          } catch (e) { showToast("Ошибка: " + e.message, "error"); }
        });
      }},
    ]));
    desksBody.append(tr);
  });
  renderPagination('desks-pagination', items.length, 'desks');
}

function renderPoliciesTable() {
  policiesBody.innerHTML = "";
  if (!state.policies.length) {
    policiesBody.innerHTML = '<tr><td colspan="8" class="empty">Нет политик.</td></tr>';
    renderPagination('policies-pagination', 0, 'policies');
    return;
  }
  var slice = pageSlice(state.policies, 'policies');
  slice.forEach(function (p) {
    var tr = document.createElement("tr");
    tr.innerHTML = (
      "<td>" + p.id + "</td>" +
      "<td>" + getOfficeName(p.office_id) + "</td>" +
      "<td>" + p.name + "</td>" +
      "<td>" + p.min_days_ahead + "–" + p.max_days_ahead + "</td>" +
      "<td>" + p.min_duration_minutes + "–" + p.max_duration_minutes + "</td>" +
      "<td>" + p.no_show_timeout_minutes + "</td>" +
      "<td>" + (p.max_bookings_per_day || 1) + "</td>" +
      "<td></td>"
    );
    tr.querySelector("td:last-child").append(makeActionCell(
      makePrimaryBtn("Изменить", "pencil", function () { openPolicyModal(p); }),
      [
        { label: "Удалить", icon: "trash-2", danger: true, onClick: function () {
          confirmDelete("Удалить политику?", "Вы уверены, что хотите удалить политику «" + p.name + "»? Это действие нельзя отменить.", async function () {
            try {
              await apiRequest("/policies/" + p.id, { method: "DELETE" });
              showToast("Политика «" + p.name + "» удалена.", "success");
              await loadPolicies();
            } catch (e) { showToast("Ошибка: " + e.message, "error"); }
          });
        }},
      ]
    ));
    policiesBody.append(tr);
  });
  renderPagination('policies-pagination', state.policies.length, 'policies');
}

function renderReservationsTable() {
  reservationsBody.innerHTML = "";
  if (!state.reservations.length) {
    reservationsBody.innerHTML = '<tr><td colspan="9" class="empty">Нет бронирований.</td></tr>';
    renderPagination('reservations-pagination', 0, 'reservations');
    return;
  }
  var slice = pageSlice(state.reservations, 'reservations');
  slice.forEach(function (r) {
    var tr = document.createElement("tr");
    var checkinText = r.checked_in_at ? r.checked_in_at.slice(11, 16) : "—";
    var statusClass = r.status === "active" ? "active" : "cancelled";
    var statusText  = r.status === "active" ? "Активно" : "Отменено";
    tr.innerHTML = (
      "<td>" + r.id + "</td>" +
      "<td>" + r.desk_id + "</td>" +
      "<td>" + r.user_id + "</td>" +
      "<td>" + r.reservation_date + "</td>" +
      "<td>" + (r.start_time ? r.start_time.slice(0, 5) : "—") + "</td>" +
      "<td>" + (r.end_time ? r.end_time.slice(0, 5) : "—") + "</td>" +
      "<td>" + checkinText + "</td>" +
      "<td><span class=\"badge " + statusClass + "\">" + statusText + "</span></td>" +
      "<td></td>"
    );
    if (r.status === "active") {
      var cancelBtn = makePrimaryBtn("Отменить", "x-circle", function () {
        confirmDelete("Отменить бронирование?", "Вы уверены, что хотите отменить это бронирование?", async function () {
          try {
            await apiRequest("/reservations/" + r.id + "/cancel", { method: "POST" });
            showToast("Бронирование отменено.", "success");
            await loadReservations();
          } catch (e) { showToast("Ошибка: " + e.message, "error"); }
        });
      });
      cancelBtn.classList.add("adm-primary-action--danger");
      tr.querySelector("td:last-child").append(makeActionCell(cancelBtn, []));
    }
    reservationsBody.append(tr);
  });
  renderPagination('reservations-pagination', state.reservations.length, 'reservations');
}

// ── Populate selects ──────────────────────────────────────────────────────────
function populateOfficeSelects() {
  [floorOfficeSelect, policyOfficeSelect, document.getElementById("filter-office"), document.getElementById("floors-office-filter")].forEach(function (sel) {
    if (!sel) return;
    var val = sel.value;
    var placeholder = sel === document.getElementById("filter-office") ? "Все офисы" : "Выберите офис";
    sel.innerHTML = '<option value="">' + placeholder + '</option>';
    state.offices.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.name;
      sel.append(opt);
    });
    if (val) sel.value = val;
  });
}

function populateFloorSelects() {
  [planFloorSelect].forEach(function (sel) {
    if (!sel) return;
    var val = sel.value;
    sel.innerHTML = '<option value="">Выберите этаж</option>';
    state.floors.forEach(function (f) {
      var opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name + " (" + getOfficeName(f.office_id) + ")";
      sel.append(opt);
    });
    if (val) sel.value = val;
  });
  if (typeof populateEdFloorSelect === "function") {
    populateEdFloorSelect(state.floors, state.offices);
  }
}

// ── Placement editor ──────────────────────────────────────────────────────────
var pendingDesks     = [];
var placementFloorId = null;
var _selectedIdx     = null;
var _placementMode   = "select"; // "select" | "desk" | "room"

// ── Multi-selection ────────────────────────────────────────────────────────────
var _selectedIdxs = new Set(); // indices of all selected desks (rubber-band)

// ── Undo/Redo history ─────────────────────────────────────────────────────────
var _history    = [];
var _historyIdx = -1;

function _pushHistory() {
  _history = _history.slice(0, _historyIdx + 1);
  _history.push(JSON.parse(JSON.stringify(pendingDesks)));
  _historyIdx = _history.length - 1;
  _updateUndoRedoBtns();
}

function _updateUndoRedoBtns() {
  var u = document.getElementById("undo-btn");
  var r = document.getElementById("redo-btn");
  if (u) u.disabled = _historyIdx <= 0;
  if (r) r.disabled = _historyIdx >= _history.length - 1;
}

function doUndo() {
  if (_historyIdx <= 0) return;
  _historyIdx--;
  pendingDesks = JSON.parse(JSON.stringify(_history[_historyIdx]));
  _selectedIdx = null;
  renderPlacementEditor();
  updatePropertiesPanel();
  _updateUndoRedoBtns();
}

function doRedo() {
  if (_historyIdx >= _history.length - 1) return;
  _historyIdx++;
  pendingDesks = JSON.parse(JSON.stringify(_history[_historyIdx]));
  _selectedIdx = null;
  renderPlacementEditor();
  updatePropertiesPanel();
  _updateUndoRedoBtns();
}

// ── Snap-to-grid ──────────────────────────────────────────────────────────────
var _snapEnabled = false;
var SNAP_GRID    = 0.025;

function _snap(val) {
  if (!_snapEnabled) return val;
  return Math.round(val / SNAP_GRID) * SNAP_GRID;
}

var TILE_W  = { desk: 0.03, room: 0.08 };
var TILE_H  = { desk: 0.02, room: 0.05 };
var MIN_W   = 0.01, MAX_W = 0.30;
var MIN_H   = 0.01, MAX_H = 0.30;
var ANCHOR_R = 6; // SVG units for desk anchor radius

function isBlockType(spaceType) {
  return spaceType === "meeting_room" || spaceType === "call_room" ||
         spaceType === "open_space"   || spaceType === "lounge";
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Desk anchor (small dot, center = position_x + w/2, position_y + h/2) ────
function createAnchor(d, idx, img) {
  var ns         = "http://www.w3.org/2000/svg";
  var dw         = d.w || TILE_W.desk;
  var dh         = d.h || TILE_H.desk;
  var acx        = (d.position_x + dw / 2) * 1000;
  var acy        = (d.position_y + dh / 2) * 1000;
  var isSel      = idx === _selectedIdx;
  var isMultiSel = _selectedIdxs.has(idx);

  var g = document.createElementNS(ns, "g");
  g.classList.add("placement-anchor");
  if (isSel) g.classList.add("selected");

  var ring = null, previewRect = null;
  if (isSel) {
    // Dashed ring around dot
    ring = document.createElementNS(ns, "circle");
    ring.setAttribute("cx", String(acx));
    ring.setAttribute("cy", String(acy));
    ring.setAttribute("r",  String(ANCHOR_R + 7));
    ring.setAttribute("fill",             "none");
    ring.setAttribute("stroke",           "#3b82f6");
    ring.setAttribute("stroke-width",     "3");
    ring.setAttribute("stroke-dasharray", "5 3");
    ring.setAttribute("pointer-events",   "none");
    g.appendChild(ring);

    // Dashed preview of client tile size
    previewRect = document.createElementNS(ns, "rect");
    previewRect.setAttribute("x",               String(d.position_x * 1000));
    previewRect.setAttribute("y",               String(d.position_y * 1000));
    previewRect.setAttribute("width",           String(dw * 1000));
    previewRect.setAttribute("height",          String(dh * 1000));
    previewRect.setAttribute("rx",              "5");
    previewRect.setAttribute("fill",            "none");
    previewRect.setAttribute("stroke",          "#3b82f6");
    previewRect.setAttribute("stroke-width",    "2");
    previewRect.setAttribute("stroke-dasharray","6 4");
    previewRect.setAttribute("opacity",         "0.45");
    previewRect.setAttribute("pointer-events",  "none");
    g.appendChild(previewRect);
  }

  // Anchor dot
  var dot = document.createElementNS(ns, "circle");
  dot.setAttribute("cx",           String(acx));
  dot.setAttribute("cy",           String(acy));
  dot.setAttribute("r",            String(ANCHOR_R));
  dot.setAttribute("fill",         isMultiSel ? "#f59e0b" : (SPACE_COLORS["desk"] || "#2563eb"));
  dot.setAttribute("stroke",       "white");
  dot.setAttribute("stroke-width", "4");
  g.appendChild(dot);

  // Drag: separate click-select from drag so renderMarkers() doesn't kill pointer capture
  var _anchorMoved = false;
  g.addEventListener("pointerdown", function (e) {
    e.stopPropagation();
    e.preventDefault();
    _anchorMoved = false;
    g.setPointerCapture(e.pointerId);
    // Do NOT call selectDesk here — it triggers renderMarkers() which destroys this element
  });

  g.addEventListener("pointermove", function (e) {
    if (!g.hasPointerCapture(e.pointerId)) return;
    _anchorMoved = true;
    var ir  = img.getBoundingClientRect();
    var mx  = Math.max(0, Math.min(1, (e.clientX - ir.left) / ir.width));
    var my  = Math.max(0, Math.min(1, (e.clientY - ir.top)  / ir.height));
    var cdw = pendingDesks[idx].w || TILE_W.desk;
    var cdh = pendingDesks[idx].h || TILE_H.desk;
    var nx  = _snap(Math.max(0, Math.min(1 - cdw, mx - cdw / 2)));
    var ny  = _snap(Math.max(0, Math.min(1 - cdh, my - cdh / 2)));
    pendingDesks[idx].position_x = nx;
    pendingDesks[idx].position_y = ny;
    var nacx = (nx + cdw / 2) * 1000;
    var nacy = (ny + cdh / 2) * 1000;
    dot.setAttribute("cx", String(nacx));
    dot.setAttribute("cy", String(nacy));
    if (ring)        { ring.setAttribute("cx", String(nacx)); ring.setAttribute("cy", String(nacy)); }
    if (previewRect) { previewRect.setAttribute("x", String(nx * 1000)); previewRect.setAttribute("y", String(ny * 1000)); }
  });

  g.addEventListener("pointerup", function (e) {
    if (!g.hasPointerCapture(e.pointerId)) return;
    if (_anchorMoved) {
      // Drag ended: push undo snapshot, commit selection and re-render
      _pushHistory();
      _selectedIdx = idx;
      renderMarkers();
      updatePropertiesPanel();
    } else {
      // Simple click: toggle selection
      selectDesk(idx);
    }
  });

  return g;
}

// ── Room / large-space block (rect with resize handle) ────────────────────
function createBlock(d, idx, img) {
  var ns         = "http://www.w3.org/2000/svg";
  var tileW      = (d.w || TILE_W.room) * 1000;
  var tileH      = (d.h || TILE_H.room) * 1000;
  var tx         = d.position_x * 1000;
  var ty         = d.position_y * 1000;
  var isSel      = idx === _selectedIdx;
  var isMultiSel = _selectedIdxs.has(idx);

  var g = document.createElementNS(ns, "g");
  g.classList.add("placement-block");
  if (isSel) g.classList.add("selected");

  var rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x",            String(tx));
  rect.setAttribute("y",            String(ty));
  rect.setAttribute("width",        String(tileW));
  rect.setAttribute("height",       String(tileH));
  rect.setAttribute("rx",           "8");
  rect.setAttribute("fill",         isMultiSel ? "#f59e0b" : (SPACE_COLORS[d.space_type] || "#7c3aed"));
  rect.setAttribute("fill-opacity", isMultiSel ? "0.5" : "0.7");
  rect.setAttribute("stroke",       "white");
  rect.setAttribute("stroke-width", "4");
  g.appendChild(rect);

  var outline = null;
  if (isSel) {
    outline = document.createElementNS(ns, "rect");
    outline.setAttribute("x",               String(tx - 4));
    outline.setAttribute("y",               String(ty - 4));
    outline.setAttribute("width",           String(tileW + 8));
    outline.setAttribute("height",          String(tileH + 8));
    outline.setAttribute("rx",              "10");
    outline.setAttribute("fill",            "none");
    outline.setAttribute("stroke",          "#3b82f6");
    outline.setAttribute("stroke-width",    "3");
    outline.setAttribute("stroke-dasharray","8 4");
    outline.setAttribute("pointer-events",  "none");
    g.appendChild(outline);
  }

  // Drag (move block) — same click-vs-drag split as anchor
  var _blockMoved = false;
  g.addEventListener("pointerdown", function (e) {
    e.stopPropagation();
    e.preventDefault();
    _blockMoved = false;
    g.setPointerCapture(e.pointerId);
  });

  g.addEventListener("pointermove", function (e) {
    if (!g.hasPointerCapture(e.pointerId)) return;
    _blockMoved = true;
    var ir = img.getBoundingClientRect();
    var x  = _snap(Math.max(0, Math.min(1, (e.clientX - ir.left) / ir.width)));
    var y  = _snap(Math.max(0, Math.min(1, (e.clientY - ir.top)  / ir.height)));
    pendingDesks[idx].position_x = x;
    pendingDesks[idx].position_y = y;
    rect.setAttribute("x", String(x * 1000));
    rect.setAttribute("y", String(y * 1000));
    if (outline) {
      outline.setAttribute("x", String(x * 1000 - 4));
      outline.setAttribute("y", String(y * 1000 - 4));
    }
    _repositionHandle(handle, x * 1000, y * 1000,
      (pendingDesks[idx].w || TILE_W.room) * 1000,
      (pendingDesks[idx].h || TILE_H.room) * 1000);
  });

  g.addEventListener("pointerup", function (e) {
    if (!g.hasPointerCapture(e.pointerId)) return;
    if (_blockMoved) {
      _pushHistory();
      _selectedIdx = idx;
      renderMarkers();
      updatePropertiesPanel();
    } else {
      selectDesk(idx);
    }
  });

  // Resize handle (only for selected blocks)
  var handle = null;
  if (isSel) {
    handle = document.createElementNS(ns, "rect");
    handle.classList.add("resize-handle");
    _repositionHandle(handle, tx, ty, tileW, tileH);
    handle.setAttribute("rx",           "3");
    handle.setAttribute("fill",         "#3b82f6");
    handle.setAttribute("stroke",       "white");
    handle.setAttribute("stroke-width", "3");

    handle.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", function (e) {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      var ir     = img.getBoundingClientRect();
      var mouseX = Math.max(0, Math.min(1, (e.clientX - ir.left) / ir.width));
      var mouseY = Math.max(0, Math.min(1, (e.clientY - ir.top)  / ir.height));
      var newW   = Math.round(Math.max(MIN_W, Math.min(MAX_W, mouseX - pendingDesks[idx].position_x)) * 1000) / 1000;
      var newH   = Math.round(Math.max(MIN_H, Math.min(MAX_H, mouseY - pendingDesks[idx].position_y)) * 1000) / 1000;
      pendingDesks[idx].w = newW;
      pendingDesks[idx].h = newH;
      var newTW = newW * 1000, newTH = newH * 1000;
      rect.setAttribute("width",  String(newTW));
      rect.setAttribute("height", String(newTH));
      if (outline) { outline.setAttribute("width", String(newTW + 8)); outline.setAttribute("height", String(newTH + 8)); }
      _repositionHandle(handle, pendingDesks[idx].position_x * 1000, pendingDesks[idx].position_y * 1000, newTW, newTH);
      var wIn = document.getElementById("prop-w");
      var hIn = document.getElementById("prop-h");
      if (wIn) wIn.value = newW;
      if (hIn) hIn.value = newH;
    });

    g.appendChild(handle);
  }

  return g;
}

// Helper: reposition resize handle to bottom-right corner of a block
function _repositionHandle(handle, tx, ty, tileW, tileH) {
  if (!handle) return;
  var HS = 16;
  handle.setAttribute("x",      String(tx + tileW - HS / 2));
  handle.setAttribute("y",      String(ty + tileH - HS / 2));
  handle.setAttribute("width",  String(HS));
  handle.setAttribute("height", String(HS));
}

// Highlight selected tile and scroll list row into view
function selectDesk(idx) {
  _selectedIdx = idx;
  renderMarkers();
  updatePropertiesPanel();

  var listEl = document.getElementById("desk-list-editor");
  listEl.querySelectorAll(".desk-row").forEach(function (r, j) {
    r.classList.toggle("selected", j === idx);
  });
  var row = listEl.querySelectorAll(".desk-row")[idx];
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function updatePropertiesPanel() {
  var emptyEl = document.getElementById("tile-properties-empty");
  var formEl  = document.getElementById("tile-properties-form");
  if (!emptyEl || !formEl) return;

  // Multi-select: show count in empty panel, hide form
  if (_selectedIdxs.size > 1) {
    emptyEl.textContent = "Выбрано: " + _selectedIdxs.size + " объектов. Del — удалить.";
    emptyEl.style.display = "";
    formEl.style.display  = "none";
    return;
  }

  if (_selectedIdx === null || !pendingDesks[_selectedIdx]) {
    emptyEl.textContent = "Выберите объект на плане, чтобы редактировать свойства.";
    emptyEl.style.display = "";
    formEl.style.display  = "none";
    return;
  }

  var d = pendingDesks[_selectedIdx];
  emptyEl.style.display = "none";
  formEl.style.display  = "";

  document.getElementById("prop-label").value     = d.label || "";
  document.getElementById("prop-space").value     = d.space_type || "desk";
  document.getElementById("prop-desk-type").value = d.type || "flex";
  document.getElementById("prop-w").value         = d.w || TILE_W.desk;
  document.getElementById("prop-h").value         = d.h || TILE_H.desk;
}

function setPlacementMode(mode) {
  _placementMode = mode;
  var overlay = document.getElementById("placement-overlay");
  var isAdd   = mode === "desk" || mode === "room";
  if (overlay) overlay.style.cursor = isAdd ? "crosshair" : "default";
  document.querySelectorAll(".placement-mode-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  renderMarkers();
}

function initPlacementEditor() {
  var floorSel = document.getElementById("placement-floor-select");
  var overlay  = document.getElementById("placement-overlay");
  var img      = document.getElementById("placement-plan-img");

  // Mode toolbar
  document.querySelectorAll(".placement-mode-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { setPlacementMode(btn.dataset.mode); });
  });

  floorSel.addEventListener("change", function () {
    placementFloorId = floorSel.value || null;
    loadPlacementFloor(placementFloorId);
  });

  document.getElementById("save-map-btn").addEventListener("click", saveMapDesks);
  document.getElementById("clear-map-btn").addEventListener("click", function () {
    if (!confirm("Очистить все плитки с плана этажа?")) return;
    pendingDesks = [];
    _selectedIdx = null;
    _pushHistory();
    renderPlacementEditor();
    updatePropertiesPanel();
  });

  // Properties panel event listeners
  document.getElementById("prop-label").addEventListener("input", function () {
    if (_selectedIdx === null) return;
    pendingDesks[_selectedIdx].label = this.value;
    renderMarkers();
    // Also update the matching list row label
    var rows = document.getElementById("desk-list-editor").querySelectorAll(".desk-input-label");
    if (rows[_selectedIdx]) rows[_selectedIdx].value = this.value;
  });

  document.getElementById("prop-space").addEventListener("change", function () {
    if (_selectedIdx === null) return;
    pendingDesks[_selectedIdx].space_type = this.value;
    renderMarkers();
    var rows = document.getElementById("desk-list-editor").querySelectorAll(".desk-select-space");
    if (rows[_selectedIdx]) rows[_selectedIdx].value = this.value;
  });

  document.getElementById("prop-desk-type").addEventListener("change", function () {
    if (_selectedIdx === null) return;
    pendingDesks[_selectedIdx].type = this.value;
    var rows = document.getElementById("desk-list-editor").querySelectorAll(".desk-select");
    if (rows[_selectedIdx]) rows[_selectedIdx].value = this.value;
  });

  document.getElementById("prop-w").addEventListener("input", function () {
    if (_selectedIdx === null) return;
    var v = Math.max(MIN_W, Math.min(MAX_W, parseFloat(this.value) || MIN_W));
    pendingDesks[_selectedIdx].w = v;
    renderMarkers();
  });

  document.getElementById("prop-h").addEventListener("input", function () {
    if (_selectedIdx === null) return;
    var v = Math.max(MIN_H, Math.min(MAX_H, parseFloat(this.value) || MIN_H));
    pendingDesks[_selectedIdx].h = v;
    renderMarkers();
  });

  document.getElementById("prop-delete-btn").addEventListener("click", function () {
    if (_selectedIdx === null) return;
    pendingDesks.splice(_selectedIdx, 1);
    _selectedIdx = null;
    _pushHistory();
    renderPlacementEditor();
    updatePropertiesPanel();
  });

  // ── Rubber-band selection (select mode drag) ──────────────────────────────
  var _rubberStart = null;
  var _rubberRect  = null; // SVG rect element for visual feedback

  function _getRubberSvg() {
    return document.getElementById("placement-svg");
  }

  function _clearRubber() {
    if (_rubberRect && _rubberRect.parentNode) _rubberRect.parentNode.removeChild(_rubberRect);
    _rubberRect = null;
    _rubberStart = null;
  }

  overlay.addEventListener("pointermove", function (e) {
    if (!_rubberStart || _placementMode !== "select") return;
    var ir  = img.getBoundingClientRect();
    var x1  = Math.max(0, Math.min(1, (_rubberStart.clientX - ir.left) / ir.width));
    var y1  = Math.max(0, Math.min(1, (_rubberStart.clientY - ir.top)  / ir.height));
    var x2  = Math.max(0, Math.min(1, (e.clientX - ir.left) / ir.width));
    var y2  = Math.max(0, Math.min(1, (e.clientY - ir.top)  / ir.height));
    var svgEl = _getRubberSvg();
    if (!svgEl) return;
    if (!_rubberRect) {
      _rubberRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      _rubberRect.setAttribute("fill",            "rgba(59,130,246,0.12)");
      _rubberRect.setAttribute("stroke",          "#3b82f6");
      _rubberRect.setAttribute("stroke-width",    "2");
      _rubberRect.setAttribute("stroke-dasharray","6 3");
      _rubberRect.setAttribute("pointer-events",  "none");
      svgEl.appendChild(_rubberRect);
    }
    var rx = Math.min(x1, x2) * 1000, ry = Math.min(y1, y2) * 1000;
    var rw = Math.abs(x2 - x1) * 1000, rh = Math.abs(y2 - y1) * 1000;
    _rubberRect.setAttribute("x", String(rx));
    _rubberRect.setAttribute("y", String(ry));
    _rubberRect.setAttribute("width",  String(rw));
    _rubberRect.setAttribute("height", String(rh));
  });

  // Click on overlay/SVG background → add object (desk/room mode) or rubber-band (select mode)
  var addStart = null;
  overlay.addEventListener("pointerdown", function (e) {
    var isObj = e.target.closest && (e.target.closest(".placement-anchor") || e.target.closest(".placement-block"));
    if (isObj) return;
    if (_placementMode === "select") {
      _rubberStart = { clientX: e.clientX, clientY: e.clientY };
      return;
    }
    if (_placementMode !== "desk" && _placementMode !== "room") return;
    addStart = { x: e.clientX, y: e.clientY };
  });
  overlay.addEventListener("pointerup", function (e) {
    // Handle rubber-band release in select mode
    if (_rubberStart && _placementMode === "select") {
      var ir   = img.getBoundingClientRect();
      var x1   = Math.max(0, Math.min(1, (_rubberStart.clientX - ir.left) / ir.width));
      var y1   = Math.max(0, Math.min(1, (_rubberStart.clientY - ir.top)  / ir.height));
      var x2   = Math.max(0, Math.min(1, (e.clientX - ir.left) / ir.width));
      var y2   = Math.max(0, Math.min(1, (e.clientY - ir.top)  / ir.height));
      var isDrag = Math.abs(e.clientX - _rubberStart.clientX) > 8 || Math.abs(e.clientY - _rubberStart.clientY) > 8;
      _clearRubber();
      if (isDrag) {
        var minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
        var minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
        _selectedIdxs.clear();
        pendingDesks.forEach(function (d, i) {
          if (d.position_x === null || d.position_y === null) return;
          var cx = d.position_x + (d.w || TILE_W.desk) / 2;
          var cy = d.position_y + (d.h || TILE_H.desk) / 2;
          if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) _selectedIdxs.add(i);
        });
        if (_selectedIdxs.size === 1) {
          _selectedIdx = Array.from(_selectedIdxs)[0];
          _selectedIdxs.clear();
        } else {
          _selectedIdx = null;
        }
        renderMarkers();
        updatePropertiesPanel();
      } else {
        // Simple click on background → deselect all
        _selectedIdx = null;
        _selectedIdxs.clear();
        renderMarkers();
        updatePropertiesPanel();
      }
      return;
    }

    if (!addStart) return;
    var isObj = e.target.closest && (e.target.closest(".placement-anchor") || e.target.closest(".placement-block"));
    if (isObj) { addStart = null; return; }
    var dx = e.clientX - addStart.x, dy = e.clientY - addStart.y;
    addStart = null;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) return;
    var ir      = img.getBoundingClientRect();
    var mx      = Math.max(0, Math.min(1, (e.clientX - ir.left) / ir.width));
    var my      = Math.max(0, Math.min(1, (e.clientY - ir.top)  / ir.height));
    var autoIdx = pendingDesks.length + 1;
    var isRoom  = _placementMode === "room";
    var newW    = isRoom ? TILE_W.room : TILE_W.desk;
    var newH    = isRoom ? TILE_H.room : TILE_H.desk;
    // For desks: center anchor on cursor. For rooms: top-left at cursor.
    var posX    = _snap(isRoom ? mx : Math.max(0, mx - newW / 2));
    var posY    = _snap(isRoom ? my : Math.max(0, my - newH / 2));
    pendingDesks.push({
      label:       isRoom ? "R-" + autoIdx : "D-" + autoIdx,
      type:        "flex",
      space_type:  isRoom ? "meeting_room" : "desk",
      assigned_to: "",
      position_x:  posX,
      position_y:  posY,
      w:           newW,
      h:           newH,
    });
    _pushHistory();
    _selectedIdx = pendingDesks.length - 1;
    renderPlacementEditor();
    updatePropertiesPanel();
  });

  // Del / Backspace to delete selected desk; Ctrl+Z/Y for undo/redo
  document.addEventListener("keydown", function (e) {
    var active = document.activeElement;
    var inInput = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");

    // Undo/Redo — always active (even in inputs we allow it)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
      e.preventDefault();
      doUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
      e.preventDefault();
      doRedo();
      return;
    }

    if (inInput) return;

    if (e.key === "Delete" || e.key === "Backspace") {
      if (_selectedIdxs.size > 0) {
        // Delete all rubber-band selected
        var toDelete = Array.from(_selectedIdxs).sort(function (a, b) { return b - a; });
        toDelete.forEach(function (i) { pendingDesks.splice(i, 1); });
        _selectedIdxs.clear();
        _selectedIdx = null;
        _pushHistory();
        renderPlacementEditor();
        updatePropertiesPanel();
      } else if (_selectedIdx !== null) {
        pendingDesks.splice(_selectedIdx, 1);
        _selectedIdx = null;
        _pushHistory();
        renderPlacementEditor();
        updatePropertiesPanel();
      }
    }
  });

  // Deselect on Escape
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && _selectedIdx !== null) {
      _selectedIdx = null;
      selectDesk(null);
    }
  });

  // Undo/Redo buttons
  document.getElementById("undo-btn").addEventListener("click", doUndo);
  document.getElementById("redo-btn").addEventListener("click", doRedo);

  // Snap-to-grid toggle
  document.getElementById("snap-toggle").addEventListener("change", function () {
    _snapEnabled = this.checked;
  });
}

async function loadPlacementFloor(floorId) {
  var area   = document.getElementById("placement-area");
  var noplan = document.getElementById("placement-no-plan");
  area.style.display = "none";
  noplan.classList.add("hidden");
  pendingDesks  = [];
  _selectedIdx  = null;
  _selectedIdxs = new Set();
  _history      = [];
  _historyIdx   = -1;
  _updateUndoRedoBtns();
  if (!floorId) return;

  var floor = state.floors.find(function (f) { return String(f.id) === String(floorId); });
  if (!floor || !floor.plan_url) { noplan.classList.remove("hidden"); return; }

  var img = document.getElementById("placement-plan-img");
  img.src = floor.plan_url;
  area.style.display = "";

  try {
    var existing = await apiRequest("/desks?floor_id=" + floorId);
    pendingDesks = existing.map(function (d) {
      return {
        label:      d.label,
        type:       d.type || "flex",
        space_type: d.space_type || "desk",
        assigned_to: d.assigned_to || "",
        position_x: typeof d.position_x === "number" ? d.position_x : null,
        position_y: typeof d.position_y === "number" ? d.position_y : null,
        w: typeof d.w === "number" ? d.w : TILE_W.desk,
        h: typeof d.h === "number" ? d.h : TILE_H.desk,
      };
    });
  } catch {
    pendingDesks = [];
  }

  _pushHistory(); // initial state as undo base
  renderPlacementEditor();
  updatePropertiesPanel();
}

function renderPlacementEditor() {
  var img     = document.getElementById("placement-plan-img");
  var svgEl   = document.getElementById("placement-svg");
  var listEl  = document.getElementById("desk-list-editor");
  var countEl = document.getElementById("desk-count");

  if (svgEl) svgEl.innerHTML = "";
  countEl.textContent = pendingDesks.length;
  listEl.innerHTML = "";

  pendingDesks.forEach(function (d, i) {
    // SVG marker on plan (edit mode dispatch)
    if (d.position_x !== null && d.position_y !== null && svgEl) {
      if (isBlockType(d.space_type)) {
        svgEl.appendChild(createBlock(d, i, img));
      } else {
        svgEl.appendChild(createAnchor(d, i, img));
      }
    }

    // List row
    var row = document.createElement("div");
    row.className = "desk-row" + (i === _selectedIdx ? " selected" : "");

    row.innerHTML = (
      "<input class='desk-input desk-input-label' value='" + escHtml(d.label) + "' placeholder='Метка'>" +
      "<select class='desk-select'>" +
        "<option value='flex'"  + (d.type === "flex"  ? " selected" : "") + ">Гибкое</option>" +
        "<option value='fixed'" + (d.type === "fixed" ? " selected" : "") + ">Закреплённое</option>" +
      "</select>" +
      "<select class='desk-select desk-select-space'>" +
        "<option value='desk'"         + (d.space_type === "desk"         ? " selected" : "") + ">Стол</option>" +
        "<option value='meeting_room'" + (d.space_type === "meeting_room" ? " selected" : "") + ">Переговорная</option>" +
        "<option value='call_room'"    + (d.space_type === "call_room"    ? " selected" : "") + ">Call-room</option>" +
        "<option value='open_space'"   + (d.space_type === "open_space"   ? " selected" : "") + ">Open Space</option>" +
        "<option value='lounge'"       + (d.space_type === "lounge"       ? " selected" : "") + ">Лаунж</option>" +
      "</select>" +
      "<input class='desk-input desk-input-assigned' value='" + escHtml(d.assigned_to || "") + "' placeholder='Назначен (fixed)'>" +
      "<button class='desk-del-btn' title='Удалить место'><i data-lucide='trash-2' style='width:13px;height:13px'></i></button>"
    );

    var labelInput    = row.querySelector(".desk-input-label");
    var typeSelect    = row.querySelectorAll(".desk-select")[0];
    var spaceSelect   = row.querySelector(".desk-select-space");
    var assignedInput = row.querySelector(".desk-input-assigned");
    var delBtn        = row.querySelector(".desk-del-btn");

    labelInput.addEventListener("input", function () {
      pendingDesks[i].label = this.value;
      renderMarkers();
    });
    typeSelect.addEventListener("change", function () {
      pendingDesks[i].type = this.value;
      renderMarkers();
    });
    spaceSelect.addEventListener("change", function () {
      pendingDesks[i].space_type = this.value;
      renderMarkers();
    });
    assignedInput.addEventListener("input", function () {
      pendingDesks[i].assigned_to = this.value;
    });

    delBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      pendingDesks.splice(i, 1);
      if (_selectedIdx === i) _selectedIdx = null;
      else if (_selectedIdx !== null && _selectedIdx > i) _selectedIdx--;
      _pushHistory();
      renderPlacementEditor();
      updatePropertiesPanel();
    });

    row.addEventListener("pointerdown", function (e) {
      if (e.target === delBtn || delBtn.contains(e.target)) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      selectDesk(i);
    });

    listEl.appendChild(row);
  });

  if (window.lucide) lucide.createIcons({ nodes: [listEl] });
}

// Re-render SVG markers (called on any data change or selectDesk)
function renderMarkers() {
  var img   = document.getElementById("placement-plan-img");
  var svgEl = document.getElementById("placement-svg");
  if (!svgEl) return;
  svgEl.innerHTML = "";

  pendingDesks.forEach(function (d, i) {
    if (d.position_x === null || d.position_y === null) return;
    if (isBlockType(d.space_type)) {
      svgEl.appendChild(createBlock(d, i, img));
    } else {
      svgEl.appendChild(createAnchor(d, i, img));
    }
  });
}

async function saveMapDesks() {
  if (!placementFloorId) { showToast("Выберите этаж.", "error"); return; }
  var withPos = pendingDesks.filter(function (d) { return d.position_x !== null; });
  if (!withPos.length) { showToast("Нет размещённых столов.", "error"); return; }
  var invalid = withPos.filter(function (d) { return d.type === "fixed" && !(d.assigned_to || "").trim(); });
  if (invalid.length) {
    showToast("Закреплённые (fixed) места должны иметь назначенного сотрудника: " + invalid.map(function (d) { return d.label || "?"; }).join(", "), "error");
    return;
  }
  if (!confirm("Сохранение пересоздаст все столы этажа (старые будут удалены). Продолжить?")) return;

  try {
    var body = withPos.map(function (d) {
      return {
        label:       (d.label || "").trim() || ("D-" + (withPos.indexOf(d) + 1)),
        type:        d.type || "flex",
        space_type:  d.space_type || "desk",
        assigned_to: (d.assigned_to || "").trim() || null,
        position_x:  d.position_x,
        position_y:  d.position_y,
        w:           d.w || TILE_W.desk,
        h:           d.h || TILE_H.desk,
      };
    });
    await apiRequest("/floors/" + placementFloorId + "/desks-from-map", {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast("Сохранено: " + body.length + " " + (body.length === 1 ? "стол" : "столов") + ".", "success");
    await loadDesks();
  } catch (e) {
    showToast("Ошибка сохранения: " + e.message, "error");
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
// ── Breadcrumbs ───────────────────────────────────────────────────────────────
var TAB_LABELS = {
  offices:      { label: "Офисы",             icon: "building-2"   },
  floors:       { label: "Этажи",             icon: "layers"       },
  editor:       { label: "Редактор карты",    icon: "pencil-ruler" },
  policies:     { label: "Политики",          icon: "file-text"    },
  reservations: { label: "Бронирования",      icon: "calendar"     },
  departments:  { label: "Отделы",            icon: "users"        },
  users:        { label: "Пользователи",      icon: "user-cog"     },
  analytics:    { label: "Аналитика",         icon: "bar-chart-2"  },
};

function setBreadcrumbs(crumbs) {
  var nav = document.getElementById("admin-breadcrumbs");
  if (!nav) return;
  nav.innerHTML = "";
  crumbs.forEach(function (crumb, i) {
    var isLast = i === crumbs.length - 1;
    if (i > 0) {
      var sep = document.createElement("span");
      sep.className = "bc-sep";
      sep.innerHTML = '<i data-lucide="chevron-right" style="width:12px;height:12px"></i>';
      nav.append(sep);
    }
    var el;
    if (!isLast && crumb.onClick) {
      el = document.createElement("button");
      el.className = "bc-item bc-link";
      el.addEventListener("click", crumb.onClick);
    } else {
      el = document.createElement("span");
      el.className = "bc-item" + (isLast ? " bc-current" : "");
    }
    if (crumb.icon) {
      var ico = document.createElement("i");
      ico.setAttribute("data-lucide", crumb.icon);
      ico.style.cssText = "width:13px;height:13px";
      el.append(ico);
    }
    el.append(document.createTextNode(" " + crumb.label));
    nav.append(el);
  });
  if (window.lucide) lucide.createIcons({ nodes: [nav] });
}

// Drill-down filter state
var _floorsOfficeFilter = null;

function switchTab(tabName) {
  document.querySelectorAll(".nav-item").forEach(function (b) { b.classList.remove("active"); });
  document.querySelectorAll(".tab-content").forEach(function (t) { t.classList.add("hidden"); });
  var btn = document.querySelector(".nav-item[data-tab='" + tabName + "']");
  if (btn) btn.classList.add("active");
  var tabEl = document.getElementById("tab-" + tabName);
  if (tabEl) tabEl.classList.remove("hidden");

  // If switching tabs directly (not via drill-down), clear filters
  if (tabName === "floors") {
    _floorsOfficeFilter = null;
    renderFloorsTable();
  }
  var meta = TAB_LABELS[tabName] || { label: tabName, icon: null };
  setBreadcrumbs([{ label: meta.label, icon: meta.icon }]);

  _currentTab = tabName;
  startAutoRefresh(tabName);

  document.dispatchEvent(new CustomEvent("admin:tab-change", { detail: { tab: tabName } }));
  if (tabName === "analytics") loadAnalytics();
  if (tabName === "users") loadUsers();
  if (tabName === "editor" && typeof populateEdFloorSelect === "function") {
    populateEdFloorSelect(state.floors, state.offices);
  }
}

document.querySelectorAll(".nav-item[data-tab]").forEach(function (btn) {
  btn.addEventListener("click", function () { switchTab(btn.dataset.tab); });
});

initAdminSidebarToggle();

// ── Reservation filters ───────────────────────────────────────────────────────
document.getElementById("apply-filters-btn").addEventListener("click", loadReservations);
document.getElementById("reset-filters-btn").addEventListener("click", function () {
  document.getElementById("filter-office").value    = "";
  document.getElementById("filter-date-from").value = "";
  document.getElementById("filter-date-to").value   = "";
  document.getElementById("filter-user").value      = "";
  document.getElementById("filter-status").value    = "";
  loadReservations();
});

// ── Login form ────────────────────────────────────────────────────────────────
document.getElementById("login-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  loginError.classList.add("hidden");
  var username = document.getElementById("login-username").value.trim();
  var password = document.getElementById("login-password").value;
  if (!username || !password) {
    loginError.textContent = "Введите логин и пароль.";
    loginError.classList.remove("hidden");
    return;
  }
  try {
    var form = new URLSearchParams({ username: username, password: password });
    var resp = await fetch(API_BASE + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!resp.ok) {
      var body = await resp.json().catch(function () { return {}; });
      throw new Error(body.detail || ("Ошибка " + resp.status));
    }
    var data = await resp.json();
    setToken(data.access_token, username);
    showToast("Добро пожаловать, " + username + "!", "success");
    await loadAll();
  } catch (e) {
    loginError.textContent = e.message;
    loginError.classList.remove("hidden");
  }
});

document.getElementById("login-password").addEventListener("keydown", function (e) {
  if (e.key === "Enter") document.getElementById("login-form").requestSubmit();
});

// ── Logout ────────────────────────────────────────────────────────────────────
logoutBtn.addEventListener("click", function () {
  clearToken();
  showToast("Вы вышли из панели администратора.", "info");
});

// ── Search inputs (debounced) ─────────────────────────────────────────────────
document.getElementById("offices-search")?.addEventListener("input", debounce(renderOfficesTable, 300));
document.getElementById("floors-search")?.addEventListener("input", debounce(renderFloorsTable, 300));
document.getElementById("floors-office-filter")?.addEventListener("change", renderFloorsTable);
document.getElementById("desks-search")?.addEventListener("input", debounce(renderDesksTable, 300));
document.getElementById("desks-floor-filter")?.addEventListener("change", renderDesksTable);
document.getElementById("departments-search")?.addEventListener("input", debounce(renderDepartmentsTable, 300));

// ── Refresh buttons ───────────────────────────────────────────────────────────

function makeRefreshHandler(tab, loader) {
  return async function() {
    spinRefreshBtn(tab, true);
    showSkeletonForTab(tab);
    try { await loader(); } finally { spinRefreshBtn(tab, false); }
  };
}

document.getElementById("refresh-offices").addEventListener("click",      makeRefreshHandler("offices",      loadOffices));
document.getElementById("refresh-floors").addEventListener("click",       makeRefreshHandler("floors",       loadFloors));
document.getElementById("refresh-desks")?.addEventListener("click",       makeRefreshHandler("desks",        loadDesks));
document.getElementById("refresh-policies").addEventListener("click",     makeRefreshHandler("policies",     loadPolicies));
document.getElementById("refresh-reservations").addEventListener("click", makeRefreshHandler("reservations", loadReservations));
document.getElementById("refresh-analytics").addEventListener("click",    makeRefreshHandler("analytics",    loadAnalytics));
document.getElementById("refresh-users")?.addEventListener("click",       makeRefreshHandler("users",        loadUsers));
document.getElementById("refresh-departments")?.addEventListener("click", makeRefreshHandler("departments",  loadDepartments));

document.getElementById("anl-period-group")?.addEventListener("click", function(e) {
  var btn = e.target.closest(".anl-period-btn");
  if (!btn) return;
  _anlPeriod = btn.dataset.period;
  document.querySelectorAll(".anl-period-btn").forEach(function(b) {
    b.classList.toggle("active", b === btn);
  });
  loadAnalytics();
});
document.getElementById("users-search")?.addEventListener("input", renderUsers);

document.getElementById("export-reservations-csv")?.addEventListener("click", function() {
  var rows = [["ID","Стол","Пользователь","Дата","Начало","Конец","Статус"]];
  state.reservations.forEach(function(r) {
    rows.push([r.id, r.desk_id, r.user_id, r.reservation_date, r.start_time, r.end_time, r.status]);
  });
  var csv = rows.map(function(r) { return r.map(function(c) { return '"' + String(c).replace(/"/g,'""') + '"'; }).join(','); }).join('\n');
  var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'reservations.csv'; a.click();
  URL.revokeObjectURL(url);
});

// ── Create / Update office ────────────────────────────────────────────────────
document.getElementById("create-office-btn").addEventListener("click", async function () {
  var name = officeName.value.trim();
  if (!name) { showToast("Введите название офиса.", "error"); return; }
  try {
    if (_editOfficeId) {
      await apiRequest("/offices/" + _editOfficeId, {
        method: "PATCH",
        body: JSON.stringify({ name: name, address: officeAddress.value.trim() || null }),
      });
      showToast("Офис «" + name + "» обновлён.", "success");
    } else {
      await apiRequest("/offices", {
        method: "POST",
        body: JSON.stringify({ name: name, address: officeAddress.value.trim() || null }),
      });
      showToast("Офис «" + name + "» создан.", "success");
    }
    officeName.value = "";
    officeAddress.value = "";
    _editOfficeId = null;
    closeModal("modal-office");
    await loadAll();
  } catch (e) {
    showToast("Ошибка: " + e.message, "error");
  }
});

// ── Create / Update floor ─────────────────────────────────────────────────────
document.getElementById("create-floor-btn").addEventListener("click", async function () {
  var officeId = Number(floorOfficeSelect.value);
  var name = floorName.value.trim();
  if (!name) { showToast("Введите название этажа.", "error"); return; }
  try {
    if (_editFloorId) {
      var body = { name: name };
      if (officeId) body.office_id = officeId;
      await apiRequest("/floors/" + _editFloorId, { method: "PATCH", body: JSON.stringify(body) });
      showToast("Этаж «" + name + "» обновлён.", "success");
    } else {
      if (!officeId) { showToast("Выберите офис.", "error"); return; }
      await apiRequest("/floors", { method: "POST", body: JSON.stringify({ office_id: officeId, name: name }) });
      showToast("Этаж «" + name + "» создан.", "success");
    }
    floorName.value = "";
    _editFloorId = null;
    closeModal("modal-floor");
    await loadAll();
  } catch (e) {
    showToast("Ошибка: " + e.message, "error");
  }
});

// ── Upload floor plan ─────────────────────────────────────────────────────────
document.getElementById("upload-plan-btn").addEventListener("click", async function () {
  var floorId = planFloorSelect.value;
  var file = planFile.files[0];
  if (!floorId || !file) { showToast("Выберите этаж и файл PNG.", "error"); return; }
  try {
    var token = getToken();
    var formData = new FormData();
    formData.append("file", file);
    var resp = await fetch(API_BASE + "/floors/" + floorId + "/plan", {
      method: "POST",
      headers: token ? { Authorization: "Bearer " + token } : {},
      body: formData,
    });
    if (!resp.ok) {
      var body = await resp.json().catch(function () { return {}; });
      throw new Error(body.detail || ("Ошибка " + resp.status));
    }
    showToast("План этажа загружен.", "success");
    planFile.value = "";
    closeModal("modal-upload-plan");
    await loadFloors();
    // Auto-refresh placement editor if this floor is currently open
    var selFloor = document.getElementById("placement-floor-select");
    if (selFloor && String(selFloor.value) === String(floorId)) {
      await loadPlacementFloor(floorId);
    }
  } catch (e) {
    showToast("Ошибка: " + e.message, "error");
  }
});

// ── Create / Update policy ────────────────────────────────────────────────────
document.getElementById("create-policy-btn").addEventListener("click", async function () {
  var officeId = Number(policyOfficeSelect.value);
  var name = policyName.value.trim();
  if (!name) { showToast("Введите название политики.", "error"); return; }
  var payload = {
    name: name,
    min_days_ahead:          Number(policyMinDays.value),
    max_days_ahead:          Number(policyMaxDays.value),
    min_duration_minutes:    Number(policyMinDur.value),
    max_duration_minutes:    Number(policyMaxDur.value),
    no_show_timeout_minutes: Number(policyNoshow.value),
    max_bookings_per_day:    Number(policyMaxPerDay && policyMaxPerDay.value) || 1,
  };
  try {
    if (_editPolicyId) {
      if (officeId) payload.office_id = officeId;
      await apiRequest("/policies/" + _editPolicyId, { method: "PATCH", body: JSON.stringify(payload) });
      showToast("Политика «" + name + "» обновлена.", "success");
    } else {
      if (!officeId) { showToast("Выберите офис.", "error"); return; }
      payload.office_id = officeId;
      await apiRequest("/policies", { method: "POST", body: JSON.stringify(payload) });
      showToast("Политика «" + name + "» создана.", "success");
    }
    policyName.value = "";
    if (policyMaxPerDay) policyMaxPerDay.value = "1";
    _editPolicyId = null;
    closeModal("modal-policy");
    await loadPolicies();
  } catch (e) {
    showToast("Ошибка: " + e.message, "error");
  }
});

// ── Departments ───────────────────────────────────────────────────────────────

// ── Users management ──────────────────────────────────────────────────────────

var _AVATAR_PALETTE = [
  '#2563eb','#7c3aed','#0891b2','#059669','#d97706',
  '#dc2626','#be185d','#4f46e5','#0f766e','#b45309',
];

function usernameColor(username) {
  var hash = 0;
  for (var i = 0; i < username.length; i++) hash = (hash * 31 + username.charCodeAt(i)) | 0;
  return _AVATAR_PALETTE[Math.abs(hash) % _AVATAR_PALETTE.length];
}

function makeInitialsSpan(initials, username) {
  var span = document.createElement('span');
  span.className = 'usr-avatar usr-avatar-initials';
  span.textContent = initials;
  span.style.background = usernameColor(username);
  return span;
}

function buildUserAvatar(avatarUrl, initials, username) {
  // Normalize /static/... URLs to /api/static/... for admin proxy
  var src = avatarUrl ? avatarUrl.replace(/^\/static\//, '/api/static/') : null;

  if (!src) return makeInitialsSpan(initials, username);

  var img = document.createElement('img');
  img.className = 'usr-avatar usr-avatar-img';
  img.alt = '';
  img.src = src;
  img.addEventListener('error', function() {
    img.replaceWith(makeInitialsSpan(initials, username));
  }, { once: true });
  return img;
}

var _allUsers = [];

async function loadUsers() {
  try {
    _allUsers = await apiRequest("/admin/users");
    renderUsers();
  } catch(e) {
    showToast("Пользователи: " + e.message, "error");
  }
}

function renderUsers() {
  var search = (document.getElementById("users-search")?.value || "").toLowerCase();
  var filtered = search
    ? _allUsers.filter(function(u) {
        return u.username.toLowerCase().includes(search) || (u.email || "").toLowerCase().includes(search);
      })
    : _allUsers;
  var tbody = document.getElementById("users-body");
  if (!tbody) return;
  var slice = pageSlice(filtered, 'users');
  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Нет пользователей</td></tr>';
    renderPagination('users-pagination', filtered.length, 'users');
    return;
  }
  tbody.innerHTML = "";
  slice.forEach(function(u) {
    var tr = document.createElement("tr");
    tr.style.opacity = u.is_active === false ? "0.5" : "1";

    var roleSelect = '<select class="desk-select" style="font-size:12px;padding:2px 6px" onchange="adminSetRole(\'' + u.username + '\',this.value)">' +
      '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>user</option>' +
      '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>admin</option>' +
      '</select>';
    var statusBadge = '<span style="font-size:11px;background:var(--bg-2);padding:2px 6px;border-radius:4px">' + (u.user_status || 'available') + '</span>';
    var toggleLbl = u.is_active === false ? '✓ Активировать' : '⊘ Заблокировать';

    var initials = (u.full_name || u.username || '?').trim().split(/\s+/).slice(0, 2).map(function(w) { return w[0]; }).join('').toUpperCase();

    var clientOrigin = window.location.protocol + '//' + window.location.hostname;
    var profileUrl = clientOrigin + '/profile.html?user=' + encodeURIComponent(u.username);

    tr.innerHTML = (
      '<td>' + u.id + '</td>' +
      '<td><div class="usr-name-cell"><span class="usr-avatar-slot"></span><a href="' + profileUrl + '" target="_blank" class="usr-name-link"><strong>' + u.username + '</strong></a></div></td>' +
      '<td style="font-size:12px;color:var(--text-2)">' + (u.email || '—') + '</td>' +
      '<td>' + (u.full_name || '—') + '</td>' +
      '<td>' + (u.department || '—') + '</td>' +
      '<td>' + roleSelect + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td></td>'
    );

    // Build avatar with DOM so we can attach a real onerror handler
    var slot = tr.querySelector(".usr-avatar-slot");
    if (slot) slot.replaceWith(buildUserAvatar(u.avatar_url, initials, u.username));

    // Toggle button (primary action)
    var toggleBtn = document.createElement("button");
    toggleBtn.className = "btn btn-secondary btn-sm adm-primary-action" + (u.is_active === false ? "" : " adm-primary-action--warn");
    toggleBtn.innerHTML = u.is_active === false
      ? '<i data-lucide="check-circle" style="width:13px;height:13px"></i> Активировать'
      : '<i data-lucide="ban" style="width:13px;height:13px"></i> Заблокировать';
    toggleBtn.addEventListener("click", function() { adminToggleActive(u.username, !!u.is_active); });

    // Action cell: toggle (primary) + ⋮ (delete)
    tr.querySelector("td:last-child").append(makeActionCell(toggleBtn, [
      { label: "Удалить", icon: "trash-2", danger: true, onClick: function () {
        confirmDelete(
          "Удалить пользователя?",
          "Вы уверены, что хотите удалить пользователя «" + u.username + "»? Это действие нельзя отменить.",
          async function () {
            try {
              await apiRequest('/admin/users/' + u.username, { method: 'DELETE' });
              _allUsers = _allUsers.filter(function(x) { return x.username !== u.username; });
              renderUsers();
              showToast('Пользователь удалён.', 'success');
            } catch(e) { showToast('Ошибка: ' + e.message, 'error'); }
          }
        );
      }},
    ]));

    tbody.append(tr);
  });
  if (window.lucide) lucide.createIcons({ nodes: [tbody] });
  renderPagination('users-pagination', filtered.length, 'users');
}

async function adminSetRole(username, role) {
  try {
    await apiRequest('/admin/users/' + username, { method: 'PATCH', body: JSON.stringify({ role: role }) });
    var u = _allUsers.find(function(x) { return x.username === username; });
    if (u) u.role = role;
    showToast('Роль обновлена.', 'success');
  } catch(e) { showToast('Ошибка: ' + e.message, 'error'); }
}

async function adminToggleActive(username, currentlyActive) {
  try {
    await apiRequest('/admin/users/' + username, { method: 'PATCH', body: JSON.stringify({ is_active: !currentlyActive }) });
    var u = _allUsers.find(function(x) { return x.username === username; });
    if (u) u.is_active = !currentlyActive;
    renderUsers();
    showToast(currentlyActive ? 'Пользователь заблокирован.' : 'Пользователь активирован.', 'success');
  } catch(e) { showToast('Ошибка: ' + e.message, 'error'); }
}

var _allDepartments = [];

async function loadDepartments() {
  const tbody = document.getElementById("departments-body");
  if (!tbody) return;
  try {
    _allDepartments = await apiRequest("/departments");
    renderDepartmentsTable();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="2" class="empty">Ошибка загрузки</td></tr>';
  }
}

function renderDepartmentsTable() {
  const tbody = document.getElementById("departments-body");
  if (!tbody) return;
  var q = (document.getElementById("departments-search")?.value || "").trim().toLowerCase();
  var depts = q
    ? _allDepartments.filter(function (d) { return d.name.toLowerCase().includes(q); })
    : _allDepartments;
  if (!depts.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="empty">' + (q ? "Ничего не найдено." : "Нет отделов") + '</td></tr>';
    renderPagination('departments-pagination', 0, 'departments');
    return;
  }
  tbody.innerHTML = "";
  var slice = pageSlice(depts, 'departments');
  for (const d of slice) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = d.name;
    const tdAct = document.createElement("td");
    tdAct.append(makeActionCell(
      makePrimaryBtn("Изменить", "pencil", function () { openDeptModal(d); }),
      [
        { label: "Удалить", icon: "trash-2", danger: true, onClick: function () {
          confirmDelete("Удалить отдел?", "Вы уверены, что хотите удалить отдел «" + d.name + "»? Это действие нельзя отменить.", async function () {
            try {
              await apiRequest("/departments/" + d.id, { method: "DELETE" });
              showToast("Отдел «" + d.name + "» удалён.", "success");
              await loadDepartments();
            } catch (e) { showToast("Ошибка: " + e.message, "error"); }
          });
        }},
      ]
    ));
    tr.append(tdName, tdAct);
    tbody.append(tr);
  }
  renderPagination('departments-pagination', depts.length, 'departments');
}

document.getElementById("add-dept-btn")?.addEventListener("click", async () => {
  const nameInput = document.getElementById("dept-name");
  const name = nameInput?.value.trim();
  if (!name) { showToast("Введите название отдела.", "error"); return; }
  try {
    if (_editDeptId) {
      await apiRequest("/departments/" + _editDeptId, { method: "PATCH", body: JSON.stringify({ name }) });
      showToast("Отдел «" + name + "» обновлён.", "success");
    } else {
      await apiRequest("/departments", { method: "POST", body: JSON.stringify({ name }) });
      showToast("Отдел «" + name + "» создан.", "success");
    }
    if (nameInput) nameInput.value = "";
    _editDeptId = null;
    closeModal("modal-dept");
    await loadDepartments();
  } catch (e) {
    showToast("Ошибка: " + e.message, "error");
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await checkApi();
  var token    = getToken();
  var username = localStorage.getItem("admin_username");
  if (token && username) {
    try {
      await apiRequest("/offices");
      showAdminUI(username);
      if (typeof initFloorEditor === "function") initFloorEditor();
      await loadAll();
    } catch {
      clearToken();
    }
  } else {
    showLoginOverlay();
    if (typeof initFloorEditor === "function") initFloorEditor();
    if (window.lucide) lucide.createIcons();
  }
}

init();
