/**
 * Floor Editor v2 — SVG-first canonical layout editor
 * Modes: select | pan | wall | boundary | partition | door | desk
 * No external dependencies.
 */

'use strict';

/* ── Constants ──────────────────────────────────────────────────────────────── */
const API = '/api';
const NS  = 'http://www.w3.org/2000/svg';

const STRUCT_COLORS = {
  wall:      '#2f343b',
  boundary:  '#1d4ed8',
  partition: '#4b5563',
  door:      '#1f2937',
};
const DEFAULT_ZONE_COLOR = STRUCT_COLORS.boundary;
const STRUCT_OPACITY = { wall: 1, boundary: 0.15, partition: 0.7, door: 1 };
const MAX_LAYOUT_DESKS = 2000;
const PX_CLOSE_THRESHOLD = 14;
const MARQUEE_MIN_PX = 4;
const OBJECT_HIT_PX = 14;
const DEFAULT_ZONE_LABEL_SIZE = 18;
const DRAW_ANGLE_STEP_DEG = 45;
const PANEL_LEFT_KEY = 'editor_left_collapsed';
const PANEL_RIGHT_KEY = 'editor_right_collapsed';

const DESK_COLORS = {
  flex:     { fill: '#dbeafe', stroke: '#2563eb' },
  fixed:    { fill: '#fef3c7', stroke: '#d97706' },
  disabled: { fill: '#f1f5f9', stroke: '#94a3b8' },
  occupied: { fill: '#fee2e2', stroke: '#dc2626' },
};

const MODE_HINTS = {
  select:    'Клик — выбор; Shift+клик/рамка — мультивыбор объектов; тащи — перемещение; круглая ручка — поворот; Q/E — шаг поворота; Пробел+тащи — рука',
  pan:       'Тащи для панорамирования; колесо — зум',
  wall:      'Клик — добавить точку; Shift — угол 45°; Enter/двойной клик — завершить; Esc — отменить',
  boundary:  'Клик — точка; Shift — угол 45°; клик рядом с первой — замкнуть; Enter — замкнуть; Esc — отменить',
  partition: 'Клик — точка; Shift — угол 45°; Enter — завершить; Esc — отменить',
  door:      'Клик — точка; Shift — угол 45°; Enter/двойной клик — завершить; Esc — отменить',
  desk:      'Клик — поставить стол; для блока выберите "Блок" в панели ниже',
};
const STRUCT_TYPES = ['wall', 'boundary', 'partition', 'door'];

/* ── State ──────────────────────────────────────────────────────────────────── */
let ld = null;        // LayoutDocument (canonical)
let ed = resetEd();

function resetEd() {
  return {
    floorId:  null,
    status:   null,
    version:  0,
    dirty:    false,
    locked:   false,
    lockOwner: null,
    lockExpiresAt: null,
    lockRenewInterval: null,

    // Viewport
    vb: { x: 0, y: 0, w: 1000, h: 1000 },

    bgAdjust: {
      active: false,
      dragging: false,
      start: null,
    },

    // Tool
    mode: 'select',
    snapGrid: false,
    gridSize: 10,
    altSnapOff: false,
    shiftFine: false,
    shiftDown: false,
    deskTool: {
      placeMode: 'single', // single | block
      pattern: 'rows',     // rows | double
      axis: 'horizontal',  // horizontal | vertical
      deskW: null,
      deskH: null,
      seatsPerRow: 6,
      rowCount: 2,
      pairCount: 1,
      preview: null,       // transient preview for block placement
    },

    // Drawing (wall/boundary/partition)
    drawing: null,   // { type, pts: [[x,y],...], rubberPt: [x,y] }

    // Selection
    selType: null,   // 'desk' | 'wall' | 'boundary' | 'partition' | 'door'
    selId:   null,
    multiDeskIds: [],
    multiStructKeys: [],
    marquee: null,   // { pointerId, start:{x,y}, current:{x,y}, append:boolean }
    dragGroup: null, // { pointerId, startPt:{x,y}, desks:[...], structs:[...], moved }

    // Pan
    panning:  false,
    panStart: null,

    // Space-key hand
    spaceDown: false,
    spacePanning: false,
    spacePanStart: null,
  };
}

/* ── Tiny ID helper ─────────────────────────────────────────────────────────── */
function uid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2);
}

function _degToRad(deg) {
  return Number(deg || 0) * Math.PI / 180;
}

function normalizeDeskRotation(value) {
  let ang = Number(value);
  if (!Number.isFinite(ang)) return 0;
  ang = ((ang + 180) % 360 + 360) % 360 - 180;
  return Math.abs(ang) < 1e-6 ? 0 : ang;
}

/* ── Auth header ────────────────────────────────────────────────────────────── */
function ah() {
  const t = localStorage.getItem('admin_token');
  return t ? { Authorization: 'Bearer ' + t } : {};
}

/* ── Viewport helpers ───────────────────────────────────────────────────────── */
function setVb(x, y, w, h) {
  ed.vb = { x, y, w, h };
  const svg = _svg();
  if (svg) svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  updateMinimap();
  updateStatusBar();
  updateGridPattern();
}

function svgPt(e) {
  const svg = _svg();
  if (!svg) return { x: 0, y: 0 };

  // Use SVG screen CTM for accurate coordinate mapping.
  // This handles preserveAspectRatio and any visual letterboxing,
  // so pointer placement matches the visible plan exactly.
  const ctm = svg.getScreenCTM();
  if (ctm) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  // Fallback when CTM is unavailable.
  const r = svg.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  return { x: ed.vb.x + px * ed.vb.w, y: ed.vb.y + py * ed.vb.h };
}

function snapV(v) {
  if (ed.altSnapOff || !ed.snapGrid) return v;
  const step = Math.max(0.1, ed.shiftFine ? ed.gridSize / 4 : ed.gridSize);
  return Math.round(v / step) * step;
}

function isDrawMode(mode = ed.mode) {
  return ['wall', 'boundary', 'partition', 'door'].includes(mode);
}

function _toXYPoint(pt) {
  if (!pt) return null;
  const x = Number(Array.isArray(pt) ? pt[0] : pt.x);
  const y = Number(Array.isArray(pt) ? pt[1] : pt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function getConstrainedDrawPoint(basePt, pointerPt, opts = {}) {
  const ptr = _toXYPoint(pointerPt);
  if (!ptr) return [0, 0];

  const angleLock = !!opts.angleLock;
  if (!angleLock) return [snapV(ptr.x), snapV(ptr.y)];

  const base = _toXYPoint(basePt);
  if (!base) return [snapV(ptr.x), snapV(ptr.y)];

  const dx = ptr.x - base.x;
  const dy = ptr.y - base.y;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-9) return [base.x, base.y];

  const stepDeg = Number.isFinite(Number(opts.angleStepDeg))
    ? Number(opts.angleStepDeg)
    : DRAW_ANGLE_STEP_DEG;
  const stepRad = Math.max(1, stepDeg) * Math.PI / 180;
  const rawAngle = Math.atan2(dy, dx);
  const lockedAngle = Math.round(rawAngle / stepRad) * stepRad;

  let dist = len;
  if (!ed.altSnapOff && ed.snapGrid) {
    const gridStep = Math.max(0.1, Number(ed.gridSize || 10));
    dist = Math.round(len / gridStep) * gridStep;
  }

  return [
    base.x + Math.cos(lockedAngle) * dist,
    base.y + Math.sin(lockedAngle) * dist,
  ];
}

function worldUnitsForScreenPx(px) {
  const svg = _svg();
  if (!svg || !Number.isFinite(px) || px <= 0) return 0;
  const ctm = svg.getScreenCTM();
  if (ctm) {
    const sx = Math.hypot(ctm.a, ctm.b);
    const sy = Math.hypot(ctm.c, ctm.d);
    const scale = (sx + sy) / 2;
    if (scale > 0) return px / scale;
  }
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return px;
  return px * (ed.vb.w / rect.width);
}

function layoutStrokeScale(vbWidth) {
  const w = Number(vbWidth);
  if (!Number.isFinite(w) || w <= 0) return 1;
  return Math.max(0.2, Math.min(8, w * 0.001));
}

function layoutStrokeWidth(kind, thick, vbWidth) {
  const base = Number.isFinite(Number(thick)) ? Number(thick) : (
    kind === 'wall' ? 4 :
    kind === 'partition' ? 3 :
    kind === 'door' ? 2.2 :
    2
  );
  const scale = layoutStrokeScale(vbWidth);
  if (kind === 'boundary') return Math.max(1, base * scale * 0.4);
  return Math.max(1, base * scale);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function collectDeskNumberSet() {
  const used = new Set();
  for (const d of (ld?.desks || [])) {
    const m = /^D-(\d+)$/i.exec(String(d.label || '').trim());
    if (m) used.add(parseInt(m[1], 10));
  }
  return used;
}

function takeNextDeskLabel(used) {
  let n = 1;
  while (used.has(n)) n++;
  used.add(n);
  return 'D-' + n;
}

function baseDeskSize() {
  if (!ld) return { w: 28, h: 16 };
  const w = Math.max(8, ld.vb[2] * 0.028);
  const h = Math.max(6, ld.vb[3] * 0.016);
  return { w, h };
}

function defaultDeskSize() {
  const base = baseDeskSize();
  const maxW = Math.max(120, base.w * 8);
  const maxH = Math.max(90, base.h * 8);
  return {
    w: clampNum(ed?.deskTool?.deskW, 4, maxW, base.w),
    h: clampNum(ed?.deskTool?.deskH, 4, maxH, base.h),
  };
}

function makeDeskRecord(rect, label) {
  return {
    id: uid(), label, name: null, team: null, dept: null,
    bookable: true, fixed: false, assigned_to: null, status: 'available',
    x: rect.x, y: rect.y, w: rect.w, h: rect.h, r: 0, locked: false,
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

function isDeskBlockMode() {
  return ed.mode === 'desk' && ed.deskTool.placeMode === 'block';
}

function syncDeskBulkControls() {
  const panel = $el('ed-desk-bulk-panel');
  const show = ed.mode === 'desk';
  panel?.classList.toggle('ed-hidden', !show);
  if (!show) return;

  const baseSize = baseDeskSize();
  const maxW = Math.max(120, baseSize.w * 8);
  const maxH = Math.max(90, baseSize.h * 8);
  ed.deskTool.deskW = clampNum(ed.deskTool.deskW, 4, maxW, baseSize.w);
  ed.deskTool.deskH = clampNum(ed.deskTool.deskH, 4, maxH, baseSize.h);
  ed.deskTool.seatsPerRow = clampInt(ed.deskTool.seatsPerRow, 1, 100, 6);
  ed.deskTool.rowCount = clampInt(ed.deskTool.rowCount, 1, 50, 2);
  ed.deskTool.pairCount = clampInt(ed.deskTool.pairCount, 1, 25, 1);
  if (!['single', 'block'].includes(ed.deskTool.placeMode)) ed.deskTool.placeMode = 'single';
  if (!['rows', 'double'].includes(ed.deskTool.pattern)) ed.deskTool.pattern = 'rows';
  if (!['horizontal', 'vertical'].includes(ed.deskTool.axis)) ed.deskTool.axis = 'horizontal';

  _v('ed-desk-place-mode', ed.deskTool.placeMode);
  _v('ed-desk-block-pattern', ed.deskTool.pattern);
  _v('ed-desk-block-axis', ed.deskTool.axis);
  _v('ed-desk-width', Math.round(ed.deskTool.deskW * 10) / 10);
  _v('ed-desk-height', Math.round(ed.deskTool.deskH * 10) / 10);
  _v('ed-desk-seats-per-row', ed.deskTool.seatsPerRow);
  _v('ed-desk-row-count', ed.deskTool.rowCount);
  _v('ed-desk-pair-count', ed.deskTool.pairCount);

  $el('ed-desk-rows-field')?.classList.toggle('ed-hidden', ed.deskTool.pattern !== 'rows');
  $el('ed-desk-pairs-field')?.classList.toggle('ed-hidden', ed.deskTool.pattern !== 'double');

  const note = $el('ed-desk-bulk-note');
  if (note) {
    const sizeNote = `(${Math.round(ed.deskTool.deskW)}×${Math.round(ed.deskTool.deskH)})`;
    if (ed.deskTool.placeMode === 'single') {
      note.textContent = `Одиночный режим: клик по холсту ставит одно место ${sizeNote}`;
    } else if (ed.deskTool.preview?.awaitConfirm) {
      note.textContent = `Превью готово: клик по холсту подтвердит вставку, Esc — отменит ${sizeNote}`;
    } else {
      note.textContent = `Режим блока: выберите ориентацию, drag задает направление, затем клик для подтверждения ${sizeNote}`;
    }
  }

  const conflictEl = $el('ed-desk-bulk-conflicts');
  if (conflictEl) {
    conflictEl.classList.remove('ok');
    const preview = ed.deskTool.preview;
    if (ed.deskTool.placeMode !== 'block' || !preview) {
      conflictEl.textContent = '';
    } else if (preview.overflow) {
      conflictEl.textContent = `Превышение лимита: максимум ${MAX_LAYOUT_DESKS} мест`;
    } else if (preview.conflicts > 0) {
      conflictEl.textContent = `Конфликтов: ${preview.conflicts}`;
    } else {
      conflictEl.textContent = `Без конфликтов (${preview.desks.length})`;
      conflictEl.classList.add('ok');
    }
  }
}

function fitToScreen() {
  if (!ld) return;
  const wrap = document.getElementById('ed-canvas-wrap');
  if (!wrap) return;
  const target = getFitTargetRect();
  const ww = Math.max(1, wrap.clientWidth);
  const wh = Math.max(1, wrap.clientHeight - 26); // minus statusbar

  const pad = Math.max(8, Math.min(220, Math.max(target.w, target.h) * 0.08));
  const tx = target.x - pad;
  const ty = target.y - pad;
  const tw = Math.max(1, target.w + pad * 2);
  const th = Math.max(1, target.h + pad * 2);

  const viewportRatio = ww / wh;
  const targetRatio = tw / th;
  let viewW = tw;
  let viewH = th;
  if (targetRatio > viewportRatio) {
    viewH = tw / viewportRatio;
  } else {
    viewW = th * viewportRatio;
  }

  const cx = tx + tw / 2;
  const cy = ty + th / 2;
  setVb(cx - viewW / 2, cy - viewH / 2, viewW, viewH);
}

function zoomBy(factor, cx, cy) {
  const vb = ed.vb;
  if (cx === undefined) { cx = vb.x + vb.w / 2; cy = vb.y + vb.h / 2; }
  const nw = vb.w * factor, nh = vb.h * factor;
  // Clamp: 5× zoom in, 10× zoom out relative to content
  const ref = getFitTargetRect();
  const origW = Math.max(1, Number(ref?.w || 1000));
  const origH = Math.max(1, Number(ref?.h || 1000));
  if (nw < origW / 20 || nw > origW * 20) return;
  const nx = cx - (cx - vb.x) * (nw / vb.w);
  const ny = cy - (cy - vb.y) * (nh / vb.h);
  setVb(nx, ny, nw, nh);
}

/* ── DOM shortcuts ──────────────────────────────────────────────────────────── */
function _svg()  { return document.getElementById('ed-svg'); }
function _layer(id) { return document.getElementById('ed-layer-' + id); }
function $el(id) { return document.getElementById(id); }

function _bgSrc(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) return raw;
  if (raw.startsWith('/api/')) return raw;
  if (raw.startsWith('/static/')) return '/api' + raw;
  return raw;
}

function _layoutHasGeometry(doc) {
  if (!doc) return false;
  return !!(
    (doc.walls?.length || 0) +
    (doc.boundaries?.length || 0) +
    (doc.partitions?.length || 0) +
    (doc.doors?.length || 0) +
    (doc.desks?.length || 0)
  );
}

function ensureLayoutArrays(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (!Array.isArray(doc.walls)) doc.walls = [];
  if (!Array.isArray(doc.boundaries)) doc.boundaries = [];
  if (!Array.isArray(doc.partitions)) doc.partitions = [];
  if (!Array.isArray(doc.doors)) doc.doors = [];
  if (!Array.isArray(doc.desks)) doc.desks = [];
  doc.walls = doc.walls.map(el => ({ ...el, locked: !!el?.locked }));
  doc.boundaries = doc.boundaries.map(el => ({ ...el, locked: !!el?.locked }));
  doc.partitions = doc.partitions.map(el => ({ ...el, locked: !!el?.locked }));
  doc.doors = doc.doors.map(el => ({ ...el, locked: !!el?.locked }));
  doc.desks = doc.desks.map(d => ({ ...d, locked: !!d?.locked }));
  return doc;
}

function _readRasterDims(file) {
  return new Promise((resolve, reject) => {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const out = {
          w: Math.max(1, Number(img.naturalWidth || 0)),
          h: Math.max(1, Number(img.naturalHeight || 0)),
        };
        URL.revokeObjectURL(url);
        resolve(out);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('image load failed'));
      };
      img.src = url;
    } catch (e) {
      reject(e);
    }
  });
}

function _readImageDimsFromUrl(src) {
  return new Promise((resolve, reject) => {
    try {
      const img = new Image();
      img.onload = () => resolve({
        w: Math.max(1, Number(img.naturalWidth || 0)),
        h: Math.max(1, Number(img.naturalHeight || 0)),
      });
      img.onerror = () => reject(new Error('image load failed'));
      img.src = src;
    } catch (e) {
      reject(e);
    }
  });
}

function _fitRectMeet(boxW, boxH, imgW, imgH) {
  const bw = Math.max(1, Number(boxW || 0));
  const bh = Math.max(1, Number(boxH || 0));
  const iw = Math.max(1, Number(imgW || 0));
  const ih = Math.max(1, Number(imgH || 0));
  const boxRatio = bw / bh;
  const imgRatio = iw / ih;
  if (imgRatio >= boxRatio) {
    const w = bw;
    const h = bw / imgRatio;
    return { x: 0, y: (bh - h) / 2, w, h };
  }
  const h = bh;
  const w = bh * imgRatio;
  return { x: (bw - w) / 2, y: 0, w, h };
}

function normalizeHexColor(value, fallback = DEFAULT_ZONE_COLOR) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return fallback;
}

function centroidOfPoints(pts) {
  if (!Array.isArray(pts) || pts.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += Number(p?.[0] || 0);
    sy += Number(p?.[1] || 0);
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

function defaultZoneLabelSize() {
  const base = Number(ld?.vb?.[2] || 0) * 0.012;
  const fallback = Number.isFinite(base) && base > 0 ? base : DEFAULT_ZONE_LABEL_SIZE;
  return Math.max(12, Math.min(72, fallback));
}

function zoneLabelSize(el) {
  const n = Number(el?.label_size);
  if (Number.isFinite(n) && n > 0) return Math.max(8, Math.min(120, n));
  return defaultZoneLabelSize();
}

function normalizeLabelPos(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['center', 'top', 'bottom', 'left', 'right'].includes(v) ? v : 'center';
}

function labelOrientationFromAngle(value) {
  const a = normalizeDeskRotation(value);
  if (Math.abs(a) <= 0.5) return 'horizontal';
  if (Math.abs(Math.abs(a) - 90) <= 0.5) return 'vertical';
  return 'angle';
}

function labelAngleFromInputs(orientation, angleValue) {
  const orient = String(orientation || '').trim().toLowerCase();
  if (orient === 'vertical') return -90;
  if (orient === 'horizontal') return 0;
  return normalizeDeskRotation(angleValue);
}

function pointsBounds(pts) {
  if (!Array.isArray(pts) || pts.length === 0) return null;
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

function zoneLabelAnchorPoint(el, fontSize) {
  const bounds = pointsBounds(el?.pts);
  if (!bounds) return centroidOfPoints(el?.pts || []);
  const pos = normalizeLabelPos(el?.label_pos);
  const margin = Math.max(4, fontSize * 0.65, Math.min(bounds.w, bounds.h) * 0.08);
  if (pos === 'top') return { x: bounds.cx, y: bounds.minY + margin };
  if (pos === 'bottom') return { x: bounds.cx, y: bounds.maxY - margin };
  if (pos === 'left') return { x: bounds.minX + margin, y: bounds.cy };
  if (pos === 'right') return { x: bounds.maxX - margin, y: bounds.cy };
  return { x: bounds.cx, y: bounds.cy };
}

function getCanvasRect() {
  if (!ld) return { x: 0, y: 0, w: 1000, h: 1000 };
  const vb = Array.isArray(ld.vb) && ld.vb.length >= 4 ? ld.vb : [0, 0, 1000, 1000];
  const x = Number(vb[0] || 0);
  const y = Number(vb[1] || 0);
  const w = Math.max(1, Number(vb[2] || 1000));
  const h = Math.max(1, Number(vb[3] || 1000));
  return { x, y, w, h };
}

function getBackgroundRect() {
  const vb = getCanvasRect();
  const t = ld?.bg_transform;
  if (!t) return { ...vb };
  const x = Number(t.x);
  const y = Number(t.y);
  const w = Number(t.w);
  const h = Number(t.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ...vb };
  }
  return { x, y, w, h };
}

function _expandBoundsByPoint(bounds, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
}

function _hasFiniteBounds(bounds) {
  return Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.minY) &&
    Number.isFinite(bounds.maxX) &&
    Number.isFinite(bounds.maxY);
}

function getGeometryBounds() {
  if (!ld) return null;
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };

  const scanStruct = (arr) => {
    for (const el of (arr || [])) {
      for (const p of (el?.pts || [])) {
        _expandBoundsByPoint(bounds, Number(p?.[0]), Number(p?.[1]));
      }
    }
  };

  scanStruct(ld.walls);
  scanStruct(ld.boundaries);
  scanStruct(ld.partitions);
  scanStruct(ld.doors);

  for (const d of (ld.desks || [])) {
    const x = Number(d?.x);
    const y = Number(d?.y);
    const w = Number(d?.w);
    const h = Number(d?.h);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dw = Number.isFinite(w) ? Math.max(1, w) : 1;
    const dh = Number.isFinite(h) ? Math.max(1, h) : 1;
    _expandBoundsByPoint(bounds, x, y);
    _expandBoundsByPoint(bounds, x + dw, y + dh);
  }

  if (!_hasFiniteBounds(bounds)) return null;
  return {
    x: bounds.minX,
    y: bounds.minY,
    w: Math.max(1, bounds.maxX - bounds.minX),
    h: Math.max(1, bounds.maxY - bounds.minY),
  };
}

function getFitTargetRect() {
  const geom = getGeometryBounds();
  if (geom) return geom;
  if (ld?.bg_url) return getBackgroundRect();
  return getCanvasRect();
}

function setBackgroundRect(rect, opts = {}) {
  if (!ld || !rect) return;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Math.max(1, Number(rect.w));
  const h = Math.max(1, Number(rect.h));
  if (![x, y, w, h].every(Number.isFinite)) return;
  ld.bg_transform = { x, y, w, h };
  renderBackground();
  if (opts.markDirty) markDirty();
}

function clearSelectionState(opts = {}) {
  ed.selType = null;
  ed.selId = null;
  if (!opts.keepMulti && !opts.keepDeskMulti) ed.multiDeskIds = [];
  if (!opts.keepMulti && !opts.keepStructMulti) ed.multiStructKeys = [];
}

function hasMultiDeskSelection() {
  return Array.isArray(ed.multiDeskIds) && ed.multiDeskIds.length > 0;
}

function hasMultiStructSelection() {
  return Array.isArray(ed.multiStructKeys) && ed.multiStructKeys.length > 0;
}

function isStructType(type) {
  return STRUCT_TYPES.includes(type);
}

function structSelKey(type, id) {
  if (!isStructType(type) || !id) return null;
  return `${type}:${id}`;
}

function parseStructSelKey(key) {
  const raw = String(key || '');
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const type = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!isStructType(type) || !id) return null;
  return { type, id };
}

function isDeskSelected(deskId) {
  if (!deskId) return false;
  if (ed.selType === 'desk' && ed.selId === deskId) return true;
  return (ed.multiDeskIds || []).includes(deskId);
}

function isStructSelected(type, id) {
  if (!isStructType(type) || !id) return false;
  if (ed.selType === type && ed.selId === id) return true;
  const key = structSelKey(type, id);
  return key ? (ed.multiStructKeys || []).includes(key) : false;
}

function setCombinedMultiSelection(deskIds, structKeys, append = false) {
  const deskSet = append ? new Set(ed.multiDeskIds || []) : new Set();
  for (const id of (deskIds || [])) {
    if (id) deskSet.add(id);
  }
  const structSet = append ? new Set(ed.multiStructKeys || []) : new Set();
  for (const raw of (structKeys || [])) {
    const parsed = parseStructSelKey(raw);
    if (!parsed) continue;
    structSet.add(structSelKey(parsed.type, parsed.id));
  }
  ed.multiDeskIds = Array.from(deskSet);
  ed.multiStructKeys = Array.from(structSet);
  ed.selType = null;
  ed.selId = null;
  renderStructure();
  renderDesks();
  renderSelection();
  renderObjectList();
  showPropsFor(null, null);
}

function setMultiDeskSelection(ids, append = false, opts = {}) {
  const { keepStruct = false } = opts;
  const current = append ? new Set(ed.multiDeskIds || []) : new Set();
  for (const id of (ids || [])) {
    if (id) current.add(id);
  }
  ed.multiDeskIds = Array.from(current);
  if (!keepStruct) ed.multiStructKeys = [];
  ed.selType = null;
  ed.selId = null;
  renderStructure();
  renderDesks();
  renderSelection();
  renderObjectList();
  showPropsFor(null, null);
}

function setMultiStructSelection(keys, append = false, opts = {}) {
  const { keepDesk = false } = opts;
  const current = append ? new Set(ed.multiStructKeys || []) : new Set();
  for (const raw of (keys || [])) {
    const parsed = parseStructSelKey(raw);
    if (!parsed) continue;
    current.add(structSelKey(parsed.type, parsed.id));
  }
  ed.multiStructKeys = Array.from(current);
  ed.selType = null;
  ed.selId = null;
  if (!keepDesk) ed.multiDeskIds = [];
  renderStructure();
  renderDesks();
  renderSelection();
  renderObjectList();
  showPropsFor(null, null);
}

function toggleDeskMultiSelection(deskId, opts = {}) {
  const { keepStruct = true } = opts;
  if (!deskId) return;
  const next = new Set(ed.multiDeskIds || []);
  if (next.has(deskId)) next.delete(deskId);
  else next.add(deskId);
  setMultiDeskSelection(Array.from(next), false, { keepStruct });
}

function toggleStructMultiSelection(type, id, opts = {}) {
  const { keepDesk = true } = opts;
  const key = structSelKey(type, id);
  if (!key) return;
  const next = new Set(ed.multiStructKeys || []);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  setMultiStructSelection(Array.from(next), false, { keepDesk });
}

function getStructByTypeId(type, id) {
  const arr = structArrayByType(type);
  if (!Array.isArray(arr)) return null;
  return arr.find((x) => x.id === id) || null;
}

function isDeskLocked(desk) {
  return !!desk?.locked;
}

function isStructLocked(el) {
  return !!el?.locked;
}

function deskSelectionBounds(ids) {
  const selected = (ld?.desks || []).filter(d => ids.includes(d.id));
  if (!selected.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const d of selected) {
    x1 = Math.min(x1, d.x);
    y1 = Math.min(y1, d.y);
    x2 = Math.max(x2, d.x + d.w);
    y2 = Math.max(y2, d.y + d.h);
  }
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

function structSelectionBounds(keys) {
  if (!Array.isArray(keys) || !keys.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const raw of keys) {
    const parsed = parseStructSelKey(raw);
    if (!parsed) continue;
    const el = getStructByTypeId(parsed.type, parsed.id);
    if (!el || !Array.isArray(el.pts)) continue;
    for (const p of el.pts) {
      const px = Number(p?.[0] || 0);
      const py = Number(p?.[1] || 0);
      x1 = Math.min(x1, px);
      y1 = Math.min(y1, py);
      x2 = Math.max(x2, px);
      y2 = Math.max(y2, py);
    }
  }
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    return null;
  }
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

function structIntersectsRect(el, x1, y1, x2, y2) {
  let sx1 = Infinity;
  let sy1 = Infinity;
  let sx2 = -Infinity;
  let sy2 = -Infinity;
  for (const p of (el?.pts || [])) {
    const px = Number(p?.[0] || 0);
    const py = Number(p?.[1] || 0);
    sx1 = Math.min(sx1, px);
    sy1 = Math.min(sy1, py);
    sx2 = Math.max(sx2, px);
    sy2 = Math.max(sy2, py);
  }
  if (!Number.isFinite(sx1) || !Number.isFinite(sy1) || !Number.isFinite(sx2) || !Number.isFinite(sy2)) {
    return false;
  }
  return !(sx1 > x2 || sx2 < x1 || sy1 > y2 || sy2 < y1);
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const den = abx * abx + aby * aby;
  if (den <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / den));
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return Math.hypot(px - qx, py - qy);
}

function pointInPolygon(px, py, pts) {
  if (!Array.isArray(pts) || pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = Number(pts[i]?.[0] || 0);
    const yi = Number(pts[i]?.[1] || 0);
    const xj = Number(pts[j]?.[0] || 0);
    const yj = Number(pts[j]?.[1] || 0);
    const crosses = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / Math.max(1e-9, (yj - yi)) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function rectPointDistance(px, py, x, y, w, h) {
  const x1 = x;
  const y1 = y;
  const x2 = x + w;
  const y2 = y + h;
  const dx = px < x1 ? x1 - px : (px > x2 ? px - x2 : 0);
  const dy = py < y1 ? y1 - py : (py > y2 ? py - y2 : 0);
  return Math.hypot(dx, dy);
}

function findNearestObjectAtPoint(pt, thresholdPx = OBJECT_HIT_PX) {
  if (!ld || !pt) return null;
  const threshold = worldUnitsForScreenPx(Math.max(2, thresholdPx));
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const d of (ld.desks || [])) {
    const dist = rectPointDistance(pt.x, pt.y, d.x, d.y, d.w, d.h);
    if (dist <= threshold && dist < bestDist) {
      bestDist = dist;
      best = { type: 'desk', id: d.id };
    }
  }

  const scanStruct = (arr, type) => {
    for (const el of (arr || [])) {
      const pts = Array.isArray(el.pts) ? el.pts : [];
      if (pts.length < 2) continue;
      if (el.closed && pointInPolygon(pt.x, pt.y, pts)) {
        if (0 <= bestDist) {
          bestDist = 0;
          best = { type, id: el.id };
        }
        continue;
      }
      let minDist = Number.POSITIVE_INFINITY;
      const lim = el.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < lim; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const d = pointSegmentDistance(
          pt.x,
          pt.y,
          Number(a?.[0] || 0),
          Number(a?.[1] || 0),
          Number(b?.[0] || 0),
          Number(b?.[1] || 0),
        );
        if (d < minDist) minDist = d;
      }
      if (minDist <= threshold && minDist < bestDist) {
        bestDist = minDist;
        best = { type, id: el.id };
      }
    }
  };

  scanStruct(ld.boundaries, 'boundary');
  scanStruct(ld.walls, 'wall');
  scanStruct(ld.partitions, 'partition');
  scanStruct(ld.doors, 'door');
  return best;
}

async function syncCanvasToBackground() {
  if (!ld) { edToast('Сначала выберите этаж', 'error'); return; }
  const src = _bgSrc(ld.bg_url);
  if (!src) { edToast('Сначала загрузите фон', 'error'); return; }

  let dims;
  try {
    dims = await _readImageDimsFromUrl(src);
  } catch {
    edToast('Не удалось прочитать размер фона', 'error');
    return;
  }
  if (!dims?.w || !dims?.h) {
    edToast('Некорректный размер фона', 'error');
    return;
  }

  const bg = getBackgroundRect();
  const fit = _fitRectMeet(bg.w, bg.h, dims.w, dims.h);
  const imgX = bg.x + fit.x;
  const imgY = bg.y + fit.y;
  const imgW = Math.max(1e-6, fit.w);
  const imgH = Math.max(1e-6, fit.h);

  const mapX = (x) => ((Number(x || 0) - imgX) / imgW) * dims.w;
  const mapY = (y) => ((Number(y || 0) - imgY) / imgH) * dims.h;
  const mapW = (w) => (Number(w || 0) / imgW) * dims.w;
  const mapH = (h) => (Number(h || 0) / imgH) * dims.h;

  const mapPts = (pts) => (pts || []).map(p => [mapX(p?.[0]), mapY(p?.[1])]);

  ld.walls = (ld.walls || []).map(el => ({ ...el, pts: mapPts(el.pts) }));
  ld.boundaries = (ld.boundaries || []).map(el => ({ ...el, pts: mapPts(el.pts) }));
  ld.partitions = (ld.partitions || []).map(el => ({ ...el, pts: mapPts(el.pts) }));
  ld.doors = (ld.doors || []).map(el => ({ ...el, pts: mapPts(el.pts) }));
  ld.desks = (ld.desks || []).map(d => ({
    ...d,
    x: mapX(d.x),
    y: mapY(d.y),
    w: Math.max(1, mapW(d.w)),
    h: Math.max(1, mapH(d.h)),
  }));
  ld.vb = [0, 0, dims.w, dims.h];
  ld.bg_transform = { x: 0, y: 0, w: dims.w, h: dims.h };

  markDirty();
  fitToScreen();
  renderAll();
  if (ed.selType && ed.selId) showPropsFor(ed.selType, ed.selId);
  updateStatusBar();
  edToast(`SVG подогнан под фон: ${dims.w}×${dims.h}`, 'success');
}

async function clearBackground() {
  if (!ld) { edToast('Сначала выберите этаж', 'error'); return; }
  if (!ld.bg_url) { edToast('Фон уже удалён', 'info'); return; }
  if (!confirm('Удалить фоновое изображение с этого этажа?')) return;

  setBackgroundAdjustMode(false);
  ld.bg_url = null;
  ld.bg_transform = null;
  markDirty();
  renderAll();
  updateEditorUI();

  if (!ed.floorId) return;
  try {
    await fetch(`${API}/floors/${ed.floorId}`, {
      method: 'PATCH',
      headers: { ...ah(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_url: null }),
    });
  } catch (_) {
    // Layout background is already cleared locally; floor.plan_url cleanup is best-effort.
  }
  edToast('Фон удалён. Не забудьте сохранить и опубликовать.', 'success');
}

async function syncDesksFromLayout(opts = {}) {
  if (!ed.floorId) { edToast('Сначала выберите этаж', 'error'); return; }
  const src =
    opts.source === 'draft' || opts.source === 'published'
      ? opts.source
      : (ed.status === 'draft' ? 'draft' : 'published');
  const cleanup = opts.cleanup !== false;
  const quiet = !!opts.quiet;
  try {
    const resp = await fetch(`${API}/floors/${ed.floorId}/layout/sync-desks?source=${src}&cleanup=${cleanup ? 'true' : 'false'}`, {
      method: 'POST',
      headers: ah(),
    });
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      edToast('Ошибка синхронизации: ' + (b.detail || resp.status), 'error');
      return;
    }
    const result = await resp.json();
    const msg = `Синхронизация: +${result.created}, обновлено ${result.updated}, переименовано ${result.renamed}, удалено ${result.deleted}`;
    if (!quiet) edToast(msg, 'success');
    if (!quiet && result.protected_with_active_reservations > 0) {
      edToast(`Не удалено из-за активных броней: ${result.protected_with_active_reservations}`, 'info');
    }
    if (!quiet && src === 'draft') {
      edToast('Для бронирования на клиенте опубликуйте изменения.', 'info');
    }
    return result;
  } catch (ex) {
    edToast('Ошибка: ' + ex.message, 'error');
    return null;
  }
}

/* ── Render ─────────────────────────────────────────────────────────────────── */
function renderAll() {
  renderBackground();
  renderImportPreview();
  renderStructure();
  renderDesks();
  renderSelection();
  renderObjectList();
  updateEditorKpis();
}

function renderBackground() {
  const layer = _layer('bg');
  if (!layer) return;
  layer.innerHTML = '';
  if (!ld) return;

  const vb = getCanvasRect();
  const bg = getBackgroundRect();

  const base = document.createElementNS(NS, 'rect');
  base.setAttribute('x', String(vb.x));
  base.setAttribute('y', String(vb.y));
  base.setAttribute('width', String(vb.w));
  base.setAttribute('height', String(vb.h));
  base.setAttribute('fill', '#eef2f6');
  base.setAttribute('pointer-events', 'none');
  layer.appendChild(base);

  const src = _bgSrc(ld.bg_url);
  if (!src) return;

  const img = document.createElementNS(NS, 'image');
  img.setAttribute('id', 'ed-bg-image');
  img.setAttribute('href', src);
  img.setAttribute('x', String(bg.x));
  img.setAttribute('y', String(bg.y));
  img.setAttribute('width', String(bg.w));
  img.setAttribute('height', String(bg.h));
  img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  img.setAttribute('opacity', '0.92');
  img.setAttribute('pointer-events', ed.bgAdjust.active ? 'all' : 'none');
  if (ed.bgAdjust.active) img.style.cursor = ed.bgAdjust.dragging ? 'grabbing' : 'grab';
  layer.appendChild(img);
}

function updateEditorKpis() {
  const totalEl = $el('ed-kpi-total');
  const availableEl = $el('ed-kpi-available');
  const fixedEl = $el('ed-kpi-fixed');
  const disabledEl = $el('ed-kpi-disabled');
  if (!totalEl && !availableEl && !fixedEl && !disabledEl) return;

  const desks = ld?.desks || [];
  const total = desks.length;
  const available = desks.filter(d => d.status !== 'disabled' && d.status !== 'occupied' && d.bookable !== false && !d.fixed).length;
  const fixed = desks.filter(d => !!d.fixed).length;
  const disabled = desks.filter(d => d.status === 'disabled').length;

  if (totalEl) totalEl.textContent = String(total);
  if (availableEl) availableEl.textContent = String(available);
  if (fixedEl) fixedEl.textContent = String(fixed);
  if (disabledEl) disabledEl.textContent = String(disabled);
}

function _makePolyEl(tagName, pts, closed) {
  const el = document.createElementNS(NS, tagName);
  if (tagName === 'line' && pts.length >= 2) {
    el.setAttribute('x1', pts[0][0]); el.setAttribute('y1', pts[0][1]);
    el.setAttribute('x2', pts[1][0]); el.setAttribute('y2', pts[1][1]);
  } else {
    const pstr = pts.map(p => p[0] + ',' + p[1]).join(' ');
    if (tagName === 'polyline') el.setAttribute('points', pstr);
    if (tagName === 'polygon')  el.setAttribute('points', pstr);
  }
  return el;
}

function renderStructure() {
  const layers = { wall: _layer('wall'), boundary: _layer('boundary'), partition: _layer('partition'), door: _layer('door') };
  Object.values(layers).forEach(l => { if (l) l.innerHTML = ''; });
  if (!ld) return;
  const strokeScaleVb = Number(ld?.vb?.[2]) || Number(ed.vb.w) || 1000;

  function drawElements(arr, type) {
    const layer = layers[type];
    if (!layer) return;
    const defaultColor = STRUCT_COLORS[type];

    for (const el of arr) {
      if (!el.pts || el.pts.length < 2) continue;
      const isPrimarySel = ed.selType === type && ed.selId === el.id;
      const isSel = isStructSelected(type, el.id);
      const isLocked = isStructLocked(el);
      const col = type === 'boundary'
        ? normalizeHexColor(el.color, defaultColor)
        : defaultColor;
      const g = document.createElementNS(NS, 'g');
      g.dataset.id = el.id;
      g.dataset.type = type;

      const tagName = el.closed ? 'polygon' : 'polyline';
      const shape = _makePolyEl(tagName, el.pts, el.closed);
      const hitShape = _makePolyEl(tagName, el.pts, el.closed);
      const strokeW = layoutStrokeWidth(type, el.thick, strokeScaleVb);
      const hitStroke = Math.max(worldUnitsForScreenPx(OBJECT_HIT_PX), strokeW + worldUnitsForScreenPx(6));

      hitShape.setAttribute('fill', el.closed ? 'rgba(0,0,0,0)' : 'none');
      hitShape.setAttribute('stroke', 'rgba(0,0,0,0)');
      hitShape.setAttribute('stroke-width', String(hitStroke));
      hitShape.setAttribute('stroke-linecap', 'butt');
      hitShape.setAttribute('stroke-linejoin', 'round');
      hitShape.setAttribute('pointer-events', el.closed ? 'all' : 'stroke');
      if (ed.mode === 'select') {
        hitShape.setAttribute('cursor', isLocked ? 'not-allowed' : 'pointer');
      } else {
        hitShape.setAttribute('cursor', 'default');
      }
      hitShape.addEventListener('pointerdown', ev => onStructPointerDown(ev, type, el.id));
      g.appendChild(hitShape);

      if (type === 'boundary') {
        shape.setAttribute('fill', el.closed === false ? 'none' : col);
        shape.setAttribute('fill-opacity', '0.12');
        shape.setAttribute('stroke', col);
      } else {
        shape.setAttribute('fill', 'none');
        shape.setAttribute('stroke', col);
      }
      shape.setAttribute('stroke-width', String(strokeW));
      shape.setAttribute('stroke-linecap', 'butt');
      shape.setAttribute('stroke-linejoin', 'round');

      if (isSel) {
        shape.setAttribute('stroke', '#3b82f6');
        shape.setAttribute('stroke-dasharray', '6 3');
      }

      shape.setAttribute('pointer-events', 'none');
      g.appendChild(shape);

      if (type === 'boundary' && el.label) {
        const fontSize = zoneLabelSize(el);
        const c = zoneLabelAnchorPoint(el, fontSize);
        const angle = normalizeDeskRotation(el.label_angle || 0);
        const txt = document.createElementNS(NS, 'text');
        txt.setAttribute('x', String(c.x));
        txt.setAttribute('y', String(c.y));
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('dominant-baseline', 'middle');
        txt.setAttribute('font-size', String(fontSize));
        txt.setAttribute('font-family', 'system-ui, sans-serif');
        txt.setAttribute('font-weight', '700');
        txt.setAttribute('fill', isSel ? '#1e40af' : col);
        txt.setAttribute('stroke', '#ffffff');
        txt.setAttribute('stroke-width', String(Math.max(0.9, fontSize * 0.08)));
        txt.setAttribute('paint-order', 'stroke');
        txt.setAttribute('pointer-events', 'none');
        if (Math.abs(angle) > 1e-6) {
          txt.setAttribute('transform', `rotate(${angle} ${c.x} ${c.y})`);
        }
        txt.textContent = el.label;
        g.appendChild(txt);
      }

      // Vertex dots when selected
      if (isPrimarySel) {
        for (const pt of el.pts) {
          const c = document.createElementNS(NS, 'circle');
          c.setAttribute('cx', pt[0]); c.setAttribute('cy', pt[1]);
          c.setAttribute('r', String(Math.max(3, ed.vb.w * 0.004)));
          c.setAttribute('fill', '#fff'); c.setAttribute('stroke', '#3b82f6');
          c.setAttribute('stroke-width', '1.5'); c.setAttribute('pointer-events', 'none');
          g.appendChild(c);
        }
      }

      layer.appendChild(g);
    }
  }

  drawElements(ld.walls,      'wall');
  drawElements(ld.boundaries, 'boundary');
  drawElements(ld.partitions, 'partition');
  drawElements(ld.doors || [], 'door');
}

function renderDesks() {
  const layer = _layer('desk');
  if (!layer || !ld) return;
  layer.innerHTML = '';

  const swBase = Math.max(0.5, ed.vb.w * 0.0012);

  for (const desk of ld.desks) {
    const isSel = isDeskSelected(desk.id);
    const isLocked = isDeskLocked(desk);
    const isFixed    = desk.fixed;
    const isDisabled = desk.status === 'disabled';
    const isOccupied = desk.status === 'occupied';

    let colorKey = 'flex';
    if (isDisabled)    colorKey = 'disabled';
    else if (isOccupied) colorKey = 'occupied';
    else if (isFixed)  colorKey = 'fixed';

    const { fill, stroke } = DESK_COLORS[colorKey];

    const g = document.createElementNS(NS, 'g');
    g.dataset.id = desk.id;
    const cx = desk.x + desk.w / 2, cy = desk.y + desk.h / 2;

    if (desk.r) {
      g.setAttribute('transform', `rotate(${desk.r} ${cx} ${cy})`);
    }

    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', desk.x); rect.setAttribute('y', desk.y);
    rect.setAttribute('width', desk.w); rect.setAttribute('height', desk.h);
    rect.setAttribute('rx', String(Math.max(1, desk.h * 0.08)));
    rect.setAttribute('fill', fill);
    rect.setAttribute('stroke', isSel ? '#3b82f6' : stroke);
    rect.setAttribute('stroke-width', String(isSel ? swBase * 2 : swBase));
    if (isSel) rect.setAttribute('stroke-dasharray', '5 2');
    if (ed.mode === 'select') {
      rect.setAttribute('cursor', isLocked ? 'not-allowed' : 'pointer');
    } else {
      rect.setAttribute('cursor', 'crosshair');
    }
    g.appendChild(rect);

    // Label
    const txt = document.createElementNS(NS, 'text');
    txt.setAttribute('x', String(cx)); txt.setAttribute('y', String(cy));
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('dominant-baseline', 'middle');
    txt.setAttribute('font-size', String(Math.max(4, Math.min(desk.h * 0.38, desk.w * 0.18))));
    txt.setAttribute('fill', stroke);
    txt.setAttribute('pointer-events', 'none');
    txt.setAttribute('font-family', 'system-ui, sans-serif');
    txt.setAttribute('font-weight', '600');
    txt.textContent = desk.label;
    g.appendChild(txt);

    // Interaction — drag to move in select mode
    g.addEventListener('pointerdown', ev => onDeskPointerDown(ev, desk));
    layer.appendChild(g);
  }
}

function renderSelection() {
  const layer = _layer('sel');
  if (!layer) return;
  layer.innerHTML = '';
  if (!ld) return;

  const r = Math.max(4, ed.vb.w * 0.005);

  if (ed.selType === 'desk' && ed.selId) {
    const desk = ld.desks.find(d => d.id === ed.selId);
    if (desk) {
      const cx = desk.x + desk.w / 2;
      const cy = desk.y + desk.h / 2;
      const ang = _degToRad(desk.r || 0);
      const ux = Math.sin(ang);
      const uy = -Math.cos(ang);

      // 8 resize handles
      const handles = [
        [desk.x,             desk.y],
        [desk.x + desk.w/2,  desk.y],
        [desk.x + desk.w,    desk.y],
        [desk.x + desk.w,    desk.y + desk.h/2],
        [desk.x + desk.w,    desk.y + desk.h],
        [desk.x + desk.w/2,  desk.y + desk.h],
        [desk.x,             desk.y + desk.h],
        [desk.x,             desk.y + desk.h/2],
      ];
      const cursors = ['nw-resize','n-resize','ne-resize','e-resize','se-resize','s-resize','sw-resize','w-resize'];

      if (!isDeskLocked(desk)) {
        handles.forEach(([hx, hy], i) => {
          const circle = document.createElementNS(NS, 'circle');
          circle.setAttribute('cx', hx); circle.setAttribute('cy', hy);
          circle.setAttribute('r', String(r));
          circle.setAttribute('fill', '#fff'); circle.setAttribute('stroke', '#3b82f6');
          circle.setAttribute('stroke-width', '1.5');
          circle.setAttribute('cursor', cursors[i]);
          circle.setAttribute('pointer-events', 'all');
          circle.addEventListener('pointerdown', ev => onResizeHandleDown(ev, desk, i));
          layer.appendChild(circle);
        });

        const topCx = cx + ux * (desk.h / 2);
        const topCy = cy + uy * (desk.h / 2);
        const armLen = Math.max(r * 2.8, ed.vb.w * 0.028);
        const rotX = topCx + ux * armLen;
        const rotY = topCy + uy * armLen;

        const arm = document.createElementNS(NS, 'line');
        arm.setAttribute('x1', String(topCx));
        arm.setAttribute('y1', String(topCy));
        arm.setAttribute('x2', String(rotX));
        arm.setAttribute('y2', String(rotY));
        arm.setAttribute('stroke', '#3b82f6');
        arm.setAttribute('stroke-width', String(Math.max(1.2, ed.vb.w * 0.0014)));
        arm.setAttribute('pointer-events', 'none');
        layer.appendChild(arm);

        const rotateHandle = document.createElementNS(NS, 'circle');
        rotateHandle.setAttribute('cx', String(rotX));
        rotateHandle.setAttribute('cy', String(rotY));
        rotateHandle.setAttribute('r', String(Math.max(r * 0.9, ed.vb.w * 0.0044)));
        rotateHandle.setAttribute('fill', '#eff6ff');
        rotateHandle.setAttribute('stroke', '#1d4ed8');
        rotateHandle.setAttribute('stroke-width', '1.6');
        rotateHandle.setAttribute('cursor', 'grab');
        rotateHandle.setAttribute('pointer-events', 'all');
        rotateHandle.addEventListener('pointerdown', ev => onRotateHandleDown(ev, desk));
        layer.appendChild(rotateHandle);
      }
    }
  }

  if (hasMultiDeskSelection()) {
    const box = deskSelectionBounds(ed.multiDeskIds);
    if (box) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(box.x));
      rect.setAttribute('y', String(box.y));
      rect.setAttribute('width', String(box.w));
      rect.setAttribute('height', String(box.h));
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', '#2563eb');
      rect.setAttribute('stroke-width', String(Math.max(1.2, ed.vb.w * 0.0014)));
      rect.setAttribute('stroke-dasharray', '8 4');
      rect.setAttribute('pointer-events', 'none');
      layer.appendChild(rect);

      const movableIds = (ed.multiDeskIds || []).filter((id) => {
        const d = (ld.desks || []).find((x) => x.id === id);
        return !!d && !isDeskLocked(d);
      });
      if (movableIds.length) {
        const boxCx = box.x + box.w / 2;
        const topCy = box.y;
        const armLen = Math.max(r * 2.8, ed.vb.w * 0.03);
        const rotY = topCy - armLen;

        const arm = document.createElementNS(NS, 'line');
        arm.setAttribute('x1', String(boxCx));
        arm.setAttribute('y1', String(topCy));
        arm.setAttribute('x2', String(boxCx));
        arm.setAttribute('y2', String(rotY));
        arm.setAttribute('stroke', '#1d4ed8');
        arm.setAttribute('stroke-width', String(Math.max(1.2, ed.vb.w * 0.0014)));
        arm.setAttribute('pointer-events', 'none');
        layer.appendChild(arm);

        const rotateHandle = document.createElementNS(NS, 'circle');
        rotateHandle.setAttribute('cx', String(boxCx));
        rotateHandle.setAttribute('cy', String(rotY));
        rotateHandle.setAttribute('r', String(Math.max(r * 0.95, ed.vb.w * 0.0046)));
        rotateHandle.setAttribute('fill', '#eff6ff');
        rotateHandle.setAttribute('stroke', '#1d4ed8');
        rotateHandle.setAttribute('stroke-width', '1.7');
        rotateHandle.setAttribute('cursor', 'grab');
        rotateHandle.setAttribute('pointer-events', 'all');
        rotateHandle.addEventListener('pointerdown', (ev) => onMultiDeskRotateHandleDown(ev, movableIds));
        layer.appendChild(rotateHandle);
      }
    }
  }

  if (hasMultiStructSelection()) {
    const box = structSelectionBounds(ed.multiStructKeys);
    if (box) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(box.x));
      rect.setAttribute('y', String(box.y));
      rect.setAttribute('width', String(box.w));
      rect.setAttribute('height', String(box.h));
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', '#475569');
      rect.setAttribute('stroke-width', String(Math.max(1.1, ed.vb.w * 0.0013)));
      rect.setAttribute('stroke-dasharray', '7 4');
      rect.setAttribute('pointer-events', 'none');
      layer.appendChild(rect);
    }
  }

  if (ed.marquee?.start && ed.marquee?.current) {
    const x1 = Math.min(ed.marquee.start.x, ed.marquee.current.x);
    const y1 = Math.min(ed.marquee.start.y, ed.marquee.current.y);
    const x2 = Math.max(ed.marquee.start.x, ed.marquee.current.x);
    const y2 = Math.max(ed.marquee.start.y, ed.marquee.current.y);
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(x1));
    rect.setAttribute('y', String(y1));
    rect.setAttribute('width', String(Math.max(0.5, x2 - x1)));
    rect.setAttribute('height', String(Math.max(0.5, y2 - y1)));
    rect.setAttribute('fill', 'rgba(37,99,235,0.14)');
    rect.setAttribute('stroke', '#2563eb');
    rect.setAttribute('stroke-width', String(Math.max(1, ed.vb.w * 0.0012)));
    rect.setAttribute('stroke-dasharray', '4 3');
    rect.setAttribute('pointer-events', 'none');
    layer.appendChild(rect);
  }
}

function renderDrawing() {
  const layer = _layer('draw');
  if (!layer) return;
  layer.innerHTML = '';

  if (isDeskBlockMode() && ed.deskTool.preview?.desks?.length) {
    for (const rectData of ed.deskTool.preview.desks) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', rectData.x);
      rect.setAttribute('y', rectData.y);
      rect.setAttribute('width', rectData.w);
      rect.setAttribute('height', rectData.h);
      rect.setAttribute('rx', String(Math.max(1, rectData.h * 0.08)));
      rect.setAttribute('fill', rectData.conflict ? '#fee2e2' : '#dbeafe');
      rect.setAttribute('fill-opacity', rectData.conflict ? '0.92' : '0.86');
      rect.setAttribute('stroke', rectData.conflict ? '#dc2626' : '#2563eb');
      rect.setAttribute('stroke-width', String(Math.max(1, ed.vb.w * 0.0012)));
      rect.setAttribute('stroke-dasharray', '5 2');
      layer.appendChild(rect);
    }
    return;
  }

  const draw = ed.drawing;
  if (!draw || !draw.pts.length) return;

  const allPts = draw.rubberPt ? [...draw.pts, draw.rubberPt] : draw.pts;
  const col = STRUCT_COLORS[draw.type] || '#3b82f6';
  const sw = Math.max(1, ed.vb.w * 0.002);

  // Polyline
  if (allPts.length >= 2) {
    const pl = document.createElementNS(NS, 'polyline');
    pl.setAttribute('points', allPts.map(p => p[0] + ',' + p[1]).join(' '));
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', col);
    pl.setAttribute('stroke-width', String(sw));
    pl.setAttribute('stroke-dasharray', '6 3');
    pl.setAttribute('stroke-linecap', 'butt');
    layer.appendChild(pl);
  }

  // Vertex dots
  draw.pts.forEach((p, i) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]);
    c.setAttribute('r', String(Math.max(3, ed.vb.w * 0.004)));
    c.setAttribute('fill', i === 0 ? '#ef4444' : '#fff');
    c.setAttribute('stroke', col); c.setAttribute('stroke-width', '1.5');
    layer.appendChild(c);
  });

  // Close-distance indicator for boundary
  if (draw.type === 'boundary' && draw.pts.length >= 3 && draw.rubberPt) {
    const [fx, fy] = draw.pts[0];
    const [rx, ry] = draw.rubberPt;
    const closeR = worldUnitsForScreenPx(PX_CLOSE_THRESHOLD);
    if (Math.hypot(rx - fx, ry - fy) < closeR) {
      const snap = document.createElementNS(NS, 'circle');
      snap.setAttribute('cx', fx); snap.setAttribute('cy', fy);
      snap.setAttribute('r', String(closeR));
      snap.setAttribute('fill', 'none'); snap.setAttribute('stroke', '#22c55e');
      snap.setAttribute('stroke-width', '1.5'); snap.setAttribute('stroke-dasharray', '3 2');
      layer.appendChild(snap);
    }
  }
}

/* ── Minimap ────────────────────────────────────────────────────────────────── */
function updateMinimap() {
  if (!ld) return;
  const mmSvg = $el('ed-minimap-svg');
  const mmVp  = $el('ed-minimap-vp');
  const mm    = $el('ed-minimap');
  if (!mmSvg || !mm) return;

  const [vbx, vby, vbw, vbh] = ld.vb;
  mmSvg.setAttribute('viewBox', `${vbx} ${vby} ${vbw} ${vbh}`);

  // Redraw simplified walls/boundaries
  mmSvg.innerHTML = '';
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('x', vbx); bg.setAttribute('y', vby);
  bg.setAttribute('width', vbw); bg.setAttribute('height', vbh);
  bg.setAttribute('fill', '#eef2f6');
  mmSvg.appendChild(bg);

  function drawMM(arr, stroke, fill) {
    for (const el of arr) {
      if (!el.pts || el.pts.length < 2) continue;
      const shape = document.createElementNS(NS, el.closed ? 'polygon' : 'polyline');
      shape.setAttribute('points', el.pts.map(p => p[0]+','+p[1]).join(' '));
      shape.setAttribute('fill', fill || 'none');
      shape.setAttribute('stroke', stroke);
      shape.setAttribute('stroke-width', String(Math.max(1, vbw * 0.003)));
      mmSvg.appendChild(shape);
    }
  }
  drawMM(ld.boundaries, '#1d4ed8', 'rgba(29,78,216,0.15)');
  drawMM(ld.walls,      STRUCT_COLORS.wall, null);
  drawMM(ld.partitions, STRUCT_COLORS.partition, null);
  drawMM(ld.doors || [], STRUCT_COLORS.door, null);

  for (const desk of ld.desks) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', desk.x); rect.setAttribute('y', desk.y);
    rect.setAttribute('width', desk.w); rect.setAttribute('height', desk.h);
    rect.setAttribute('fill', '#1476d6'); rect.setAttribute('opacity', '.75');
    mmSvg.appendChild(rect);
  }

  // Viewport indicator
  const mmW = mm.clientWidth || 140, mmH = mm.clientHeight || 90;
  const scaleX = mmW / vbw, scaleY = mmH / vbh;
  const vp = ed.vb;
  const vpLeft = (vp.x - vbx) * scaleX;
  const vpTop  = (vp.y - vby) * scaleY;
  const vpW    = vp.w * scaleX;
  const vpH    = vp.h * scaleY;
  if (mmVp) {
    mmVp.style.left   = Math.max(0, vpLeft) + 'px';
    mmVp.style.top    = Math.max(0, vpTop)  + 'px';
    mmVp.style.width  = Math.min(mmW, vpW)  + 'px';
    mmVp.style.height = Math.min(mmH, vpH)  + 'px';
  }
}

/* ── Status bar ─────────────────────────────────────────────────────────────── */
function updateStatusBar() {
  const modeEl  = $el('ed-status-mode');
  const hintEl  = $el('ed-status-hint');
  const precEl  = $el('ed-status-precision');
  const zoomEl  = $el('ed-status-zoom');
  if (modeEl) modeEl.textContent = 'Режим: ' + modeLabel(ed.mode);
  if (hintEl) {
    if (ed.bgAdjust.active) {
      hintEl.textContent = 'Правка фона: drag — сдвиг, колесо — масштаб, кнопка "Правка фона" — выход';
    } else if (isDeskBlockMode()) {
      hintEl.textContent = 'Клик + drag — превью блока; клик — подтвердить; Esc — отменить';
    } else {
      hintEl.textContent = MODE_HINTS[ed.mode] || '';
    }
  }
  if (precEl) {
    const flags = [];
    if (ed.altSnapOff && ed.snapGrid) flags.push('NO SNAP');
    if (ed.shiftDown && isDrawMode(ed.mode)) flags.push(`ANGLE ${DRAW_ANGLE_STEP_DEG}°`);
    else if (ed.shiftFine) flags.push('FINE');
    precEl.textContent = flags.join(' · ');
  }
  if (zoomEl && ld) {
    const pct = Math.round(ld.vb[2] / ed.vb.w * 100);
    zoomEl.textContent = pct + '%';
  }
}

function modeLabel(m) {
  return { select:'Выбор', pan:'Рука', wall:'Стена', boundary:'Граница', partition:'Перегородка', door:'Дверь', desk:'Стол' }[m] || m;
}

/* ── Object list ────────────────────────────────────────────────────────────── */
function renderObjectList() {
  const list = $el('ed-obj-list');
  if (!list) return;
  if (!ld) { list.innerHTML = '<p style="color:#475569;font-size:12px;padding:8px 10px">Загрузите этаж</p>'; return; }

  const q = ($el('ed-obj-search')?.value || '').toLowerCase();

  function makeSection(title, items, type, colorFn) {
    if (!items.length) return '';
    const filtered = items.filter(it =>
      !q || (it.label || it.pts?.length?.toString() || '').toLowerCase().includes(q)
    );
    if (!filtered.length) return '';
    let html = `<div class="ed-obj-section-header">${title} (${filtered.length})</div>`;
    for (const it of filtered) {
      let active = false;
      if (type === 'desk') active = isDeskSelected(it.id);
      else active = isStructSelected(type, it.id);
      const lbl = it.label || `${title.slice(0,-1)} (${it.pts?.length || '?'} pts)`;
      const color = colorFn(it);
      const lockBadge = it.locked ? '<span class="ed-obj-lock" title="Закреплён">L</span>' : '';
      html += `<div class="ed-obj-item${active?' active':''}" data-id="${it.id}" data-type="${type}">
        <span class="ed-obj-dot" style="background:${color}"></span>
        <span class="ed-obj-label" title="${lbl}">${lbl}</span>
        ${lockBadge}
      </div>`;
    }
    return html;
  }

  list.innerHTML =
    makeSection('Столы',       ld.desks,      'desk',      d => d.fixed ? '#d97706' : '#2563eb') +
    makeSection('Стены',       ld.walls,      'wall',      () => STRUCT_COLORS.wall) +
    makeSection('Границы',     ld.boundaries, 'boundary',  b => normalizeHexColor(b.color, DEFAULT_ZONE_COLOR)) +
    makeSection('Перегородки', ld.partitions, 'partition', () => STRUCT_COLORS.partition) +
    makeSection('Двери',       ld.doors || [], 'door',     () => STRUCT_COLORS.door);

  list.querySelectorAll('.ed-obj-item').forEach(item => {
    item.addEventListener('click', (ev) => {
      const type = item.dataset.type;
      const id = item.dataset.id;
      if (ev.shiftKey) {
        if (type === 'desk') toggleDeskMultiSelection(id, { keepStruct: true });
        else if (isStructType(type)) toggleStructMultiSelection(type, id, { keepDesk: true });
        return;
      }
      selectObj(type, id);
    });
  });
}

/* ── Selection ──────────────────────────────────────────────────────────────── */
function selectObj(type, id) {
  ed.multiDeskIds = [];
  ed.multiStructKeys = [];
  ed.selType = type;
  ed.selId   = id;
  renderStructure();
  renderDesks();
  renderSelection();
  renderObjectList();
  showPropsFor(type, id);
}

function deselect() {
  clearSelectionState();
  renderStructure();
  renderDesks();
  renderSelection();
  renderObjectList();
  showPropsFor(null, null);
}

/* ── Properties panel ───────────────────────────────────────────────────────── */
function showPropsFor(type, id) {
  const empty  = $el('ed-props-empty');
  const deskP  = $el('ed-props-desk');
  const structP = $el('ed-props-struct');
  const zoneFields = $el('ep-zone-fields');
  const deskSingle = $el('ep-single-desk-fields');
  const deskMulti = $el('ep-multi-desk-panel');
  const deskMultiMode = type === null && hasMultiDeskSelection() && !hasMultiStructSelection();

  if (empty)   empty.classList.toggle('ed-hidden', type !== null || deskMultiMode);
  if (deskP)   deskP.classList.toggle('ed-hidden', !(type === 'desk' || deskMultiMode));
  if (structP) structP.classList.toggle('ed-hidden', !['wall','boundary','partition','door'].includes(type));
  if (zoneFields) zoneFields.classList.toggle('ed-hidden', type !== 'boundary');
  if (deskSingle) deskSingle.classList.toggle('ed-hidden', deskMultiMode);
  if (deskMulti) deskMulti.classList.toggle('ed-hidden', !deskMultiMode);

  if (deskMultiMode) {
    syncDeskBatchPanel();
    toggleStructLabelAngleField();
    return;
  }

  if (type === 'desk' && id && ld) {
    const d = ld.desks.find(x => x.id === id);
    if (!d) return;
    _v('ep-label', d.label);
    _v('ep-name',  d.name || '');
    _v('ep-team',  d.team || '');
    _v('ep-dept',  d.dept || '');
    _vc('ep-bookable', d.bookable !== false);
    _vc('ep-fixed',    !!d.fixed);
    _vc('ep-locked',   !!d.locked);
    _v('ep-assigned',  d.assigned_to || '');
    _v('ep-status',    d.status || 'available');
    _v('ep-x', Math.round(d.x));
    _v('ep-y', Math.round(d.y));
    _v('ep-w', Math.round(d.w));
    _v('ep-h', Math.round(d.h));
    _v('ep-r', Math.round(d.r || 0));
  }

  if (['wall','boundary','partition','door'].includes(type) && id && ld) {
    const arr = type === 'wall'
      ? ld.walls
      : type === 'boundary'
        ? ld.boundaries
        : type === 'partition'
          ? ld.partitions
          : (ld.doors || []);
    const el = arr.find(x => x.id === id);
    if (!el) return;
    _v('ep-struct-type',   type);
    _v('ep-struct-thick',  el.thick || 4);
    _vc('ep-struct-closed', !!el.closed);
    _vc('ep-struct-locked', !!el.locked);
    _v('ep-struct-label', type === 'boundary' ? (el.label || '') : '');
    _v('ep-struct-label-size', type === 'boundary' ? Math.round(zoneLabelSize(el)) : '');
    _v('ep-struct-color', normalizeHexColor(el.color, DEFAULT_ZONE_COLOR));
    if (type === 'boundary') {
      const labelPos = normalizeLabelPos(el.label_pos);
      const labelAngle = normalizeDeskRotation(el.label_angle || 0);
      _v('ep-struct-label-pos', labelPos);
      _v('ep-struct-label-angle', Math.round(labelAngle));
      _v('ep-struct-label-orient', labelOrientationFromAngle(labelAngle));
    }
    const ptCount = $el('ep-struct-pt-count');
    if (ptCount) ptCount.textContent = el.pts?.length || 0;
  }
  toggleStructLabelAngleField();
}

function _v(id, val) { const el = $el(id); if (el) el.value = val; }
function _vc(id, checked) { const el = $el(id); if (el) el.checked = checked; }

function _numOrNull(id) {
  const raw = String($el(id)?.value ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseBatchBool(id) {
  const raw = String($el(id)?.value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function selectedDeskIds(opts = {}) {
  const { includePrimary = true } = opts;
  const set = new Set(ed.multiDeskIds || []);
  if (includePrimary && ed.selType === 'desk' && ed.selId) set.add(ed.selId);
  return Array.from(set);
}

function selectedDeskRecords(opts = {}) {
  const { includePrimary = true, skipLocked = false } = opts;
  const ids = new Set(selectedDeskIds({ includePrimary }));
  let desks = (ld?.desks || []).filter((d) => ids.has(d.id));
  if (skipLocked) desks = desks.filter((d) => !isDeskLocked(d));
  return desks;
}

function syncDeskBatchPanel() {
  const countEl = $el('ep-multi-desk-count');
  const applyBtn = $el('ep-batch-apply');
  const selected = selectedDeskRecords({ includePrimary: false, skipLocked: false });
  const locked = selected.filter((d) => isDeskLocked(d)).length;
  const editable = selected.length - locked;
  if (countEl) {
    countEl.textContent = locked > 0
      ? `Выбрано мест: ${selected.length} (редактируемо: ${editable}, закреплено: ${locked})`
      : `Выбрано мест: ${selected.length}`;
  }
  if (applyBtn) applyBtn.disabled = editable <= 0;
}

function applyDeskBatchProps() {
  if (!ld || !hasMultiDeskSelection()) return;
  const targets = selectedDeskRecords({ includePrimary: false, skipLocked: true });
  const lockedSkipped = selectedDeskRecords({ includePrimary: false, skipLocked: false }).length - targets.length;
  if (!targets.length) {
    edToast('Выбранные места закреплены и недоступны для редактирования', 'info');
    return;
  }

  const statusRaw = String($el('ep-batch-status')?.value || '').trim();
  const status = ['available', 'occupied', 'disabled'].includes(statusRaw) ? statusRaw : null;
  const bookable = parseBatchBool('ep-batch-bookable');
  const fixed = parseBatchBool('ep-batch-fixed');
  const locked = parseBatchBool('ep-batch-locked');
  const w = _numOrNull('ep-batch-w');
  const h = _numOrNull('ep-batch-h');
  const r = _numOrNull('ep-batch-r');

  const hasAnyPatch =
    status !== null ||
    bookable !== null ||
    fixed !== null ||
    locked !== null ||
    w !== null ||
    h !== null ||
    r !== null;

  if (!hasAnyPatch) {
    edToast('Укажите хотя бы одно свойство для пакетного применения', 'info');
    return;
  }

  for (const d of targets) {
    if (status !== null) d.status = status;
    if (bookable !== null) d.bookable = bookable;
    if (fixed !== null) d.fixed = fixed;
    if (locked !== null) d.locked = locked;
    if (w !== null) d.w = Math.max(1, w);
    if (h !== null) d.h = Math.max(1, h);
    if (r !== null) d.r = normalizeDeskRotation(r);
  }

  markDirty();
  renderDesks();
  renderSelection();
  renderObjectList();
  syncDeskBatchPanel();

  if (lockedSkipped > 0) {
    edToast(`Обновлено мест: ${targets.length}. Закреплено и пропущено: ${lockedSkipped}`, 'info');
  } else {
    edToast(`Обновлено мест: ${targets.length}`, 'success');
  }
}

function rotateDeskSelectionBy(deltaDeg) {
  const delta = Number(deltaDeg);
  if (!ld || !Number.isFinite(delta) || Math.abs(delta) < 1e-6) return false;

  const selectedIds = selectedDeskIds({ includePrimary: true });
  if (!selectedIds.length) return false;

  const movable = selectedDeskRecords({ includePrimary: true, skipLocked: true });
  const lockedSkipped = selectedIds.length - movable.length;
  if (!movable.length) {
    edToast('Выбранные места закреплены и не могут быть повернуты', 'info');
    return false;
  }

  const box = deskSelectionBounds(selectedIds);
  if (!box) return false;

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rad = _degToRad(delta);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (const d of movable) {
    const deskCx = d.x + d.w / 2;
    const deskCy = d.y + d.h / 2;
    const vx = deskCx - cx;
    const vy = deskCy - cy;
    const nextCx = cx + vx * cos - vy * sin;
    const nextCy = cy + vx * sin + vy * cos;
    d.x = snapV(nextCx - d.w / 2);
    d.y = snapV(nextCy - d.h / 2);
    d.r = normalizeDeskRotation((d.r || 0) + delta);
  }

  markDirty();
  renderDesks();
  renderSelection();
  renderObjectList();

  if (ed.selType === 'desk' && ed.selId) {
    const active = ld.desks.find((d) => d.id === ed.selId);
    if (active) {
      _v('ep-x', Math.round(active.x));
      _v('ep-y', Math.round(active.y));
      _v('ep-r', Math.round(active.r || 0));
    }
  } else if (hasMultiDeskSelection()) {
    syncDeskBatchPanel();
  }

  if (lockedSkipped > 0) {
    edToast(`Повернуто мест: ${movable.length}. Закреплено и пропущено: ${lockedSkipped}`, 'info');
  }
  return true;
}

function toggleStructLabelAngleField() {
  const field = $el('ep-struct-label-angle-field');
  if (!field) return;
  const orient = String($el('ep-struct-label-orient')?.value || 'horizontal').trim().toLowerCase();
  field.classList.toggle('ed-hidden', orient !== 'angle');
}

function initPropsListeners() {
  const deskTextFields = ['ep-label','ep-name','ep-team','ep-dept','ep-assigned'];
  deskTextFields.forEach(fid => {
    $el(fid)?.addEventListener('input', () => applyDeskProps());
    $el(fid)?.addEventListener('change', () => applyDeskProps());
  });
  ['ep-status','ep-x','ep-y','ep-w','ep-h','ep-r'].forEach(fid => {
    $el(fid)?.addEventListener('change', () => applyDeskProps());
  });
  ['ep-bookable','ep-fixed','ep-locked'].forEach(fid => {
    $el(fid)?.addEventListener('change', () => applyDeskProps());
  });
  $el('ep-rot-left')?.addEventListener('click', () => rotateDeskSelectionBy(-15));
  $el('ep-rot-right')?.addEventListener('click', () => rotateDeskSelectionBy(15));
  $el('ep-rot-reset')?.addEventListener('click', () => {
    if (ed.selType !== 'desk' || !ed.selId || !ld) return;
    const d = ld.desks.find((x) => x.id === ed.selId);
    if (!d || isDeskLocked(d)) return;
    if (Math.abs(d.r || 0) < 1e-6) return;
    d.r = 0;
    _v('ep-r', 0);
    markDirty();
    renderDesks();
    renderSelection();
    renderObjectList();
  });
  $el('ep-batch-apply')?.addEventListener('click', () => applyDeskBatchProps());

  $el('ep-desk-del')?.addEventListener('click', () => {
    if (!ed.selId || ed.selType !== 'desk') return;
    const d = ld?.desks?.find((x) => x.id === ed.selId);
    if (isDeskLocked(d)) {
      edToast('Объект закреплён: удаление недоступно', 'info');
      return;
    }
    ld.desks = ld.desks.filter(d => d.id !== ed.selId);
    deselect();
    markDirty();
    renderAll();
  });

  // Struct props
  ['ep-struct-type','ep-struct-thick','ep-struct-closed','ep-struct-locked','ep-struct-color','ep-struct-label-size','ep-struct-label-pos','ep-struct-label-orient'].forEach(fid => {
    $el(fid)?.addEventListener('change', () => applyStructProps({ syncForm: true }));
  });
  $el('ep-struct-label-orient')?.addEventListener('change', () => toggleStructLabelAngleField());
  $el('ep-struct-label-angle')?.addEventListener('change', () => applyStructProps({ syncForm: true }));
  $el('ep-struct-label-angle')?.addEventListener('input', () => applyStructProps({ syncForm: false }));
  $el('ep-struct-label-size')?.addEventListener('input', () => applyStructProps({ syncForm: false }));
  $el('ep-struct-label')?.addEventListener('input', () => applyStructProps({ syncForm: false }));
  $el('ep-struct-label')?.addEventListener('change', () => applyStructProps({ syncForm: true }));
  $el('ep-struct-del')?.addEventListener('click', () => {
    if (!ed.selId) return;
    deleteStructEl(ed.selType, ed.selId);
  });
}

function applyDeskProps() {
  if (ed.selType !== 'desk' || !ed.selId || !ld) return;
  const d = ld.desks.find(x => x.id === ed.selId);
  if (!d) return;
  d.label       = $el('ep-label')?.value || d.label;
  d.name        = $el('ep-name')?.value || null;
  d.team        = $el('ep-team')?.value || null;
  d.dept        = $el('ep-dept')?.value || null;
  d.bookable    = !!$el('ep-bookable')?.checked;
  d.fixed       = !!$el('ep-fixed')?.checked;
  d.locked      = !!$el('ep-locked')?.checked;
  d.assigned_to = $el('ep-assigned')?.value || null;
  d.status      = $el('ep-status')?.value || 'available';
  const x = _numOrNull('ep-x');
  const y = _numOrNull('ep-y');
  const w = _numOrNull('ep-w');
  const h = _numOrNull('ep-h');
  const r = _numOrNull('ep-r');
  if (x !== null) d.x = x;
  if (y !== null) d.y = y;
  if (w !== null) d.w = Math.max(1, w);
  if (h !== null) d.h = Math.max(1, h);
  if (r !== null) d.r = normalizeDeskRotation(r);
  markDirty();
  renderDesks();
  renderSelection();
  renderObjectList();
}

function applyStructProps(opts = {}) {
  const { syncForm = true } = opts;
  if (!ed.selType || !ed.selId || !ld) return;
  const newType = $el('ep-struct-type')?.value;
  const closed  = !!$el('ep-struct-closed')?.checked;
  const locked  = !!$el('ep-struct-locked')?.checked;
  const zoneLabel = ($el('ep-struct-label')?.value || '').trim();
  const zoneColor = normalizeHexColor($el('ep-struct-color')?.value, DEFAULT_ZONE_COLOR);
  const zoneLabelPos = normalizeLabelPos($el('ep-struct-label-pos')?.value);
  const zoneLabelOrient = $el('ep-struct-label-orient')?.value || 'horizontal';
  const zoneLabelAngleRaw = _numOrNull('ep-struct-label-angle');
  toggleStructLabelAngleField();

  // Find in current array
  const srcArr = ed.selType === 'wall'
    ? ld.walls
    : ed.selType === 'boundary'
      ? ld.boundaries
      : ed.selType === 'partition'
        ? ld.partitions
        : (ld.doors || []);
  const idx = srcArr.findIndex(x => x.id === ed.selId);
  if (idx < 0) return;

  const el = srcArr[idx];
  const thickInput = _numOrNull('ep-struct-thick');
  const thickCurrent = Number(el?.thick);
  const thick = thickInput !== null
    ? Math.max(0.5, Math.min(40, thickInput))
    : (Number.isFinite(thickCurrent) ? thickCurrent : 4);
  const labelSizeInput = _numOrNull('ep-struct-label-size');
  const labelSizeCurrent = Number(el?.label_size);
  const zoneLabelSizeValue = labelSizeInput !== null
    ? Math.max(8, Math.min(120, labelSizeInput))
    : (Number.isFinite(labelSizeCurrent) ? Math.max(8, Math.min(120, labelSizeCurrent)) : defaultZoneLabelSize());
  const labelAngleCurrent = Number.isFinite(Number(el?.label_angle)) ? Number(el.label_angle) : 0;
  const zoneLabelAngle = labelAngleFromInputs(zoneLabelOrient, zoneLabelAngleRaw === null ? labelAngleCurrent : zoneLabelAngleRaw);
  if (syncForm) _v('ep-struct-label-angle', Math.round(zoneLabelAngle));

  el.thick  = thick;
  el.closed = closed;
  el.locked = locked;
  if (ed.selType === 'boundary') {
    el.label = zoneLabel || null;
    el.color = zoneColor;
    el.label_size = zoneLabelSizeValue;
    el.label_pos = zoneLabelPos;
    el.label_angle = zoneLabelAngle;
  } else {
    if (Object.prototype.hasOwnProperty.call(el, 'color')) delete el.color;
    if (Object.prototype.hasOwnProperty.call(el, 'label_size')) delete el.label_size;
    if (Object.prototype.hasOwnProperty.call(el, 'label_pos')) delete el.label_pos;
    if (Object.prototype.hasOwnProperty.call(el, 'label_angle')) delete el.label_angle;
  }

  // If type changed, move to different array
  if (newType && newType !== ed.selType) {
    srcArr.splice(idx, 1);
    const dstArr = newType === 'wall'
      ? ld.walls
      : newType === 'boundary'
        ? ld.boundaries
        : newType === 'partition'
          ? ld.partitions
          : (ld.doors || (ld.doors = []));
    if (newType === 'boundary') {
      el.color = zoneColor;
      el.label = zoneLabel || el.label || null;
      el.label_size = zoneLabelSizeValue;
      el.label_pos = zoneLabelPos;
      el.label_angle = zoneLabelAngle;
    } else {
      if (Object.prototype.hasOwnProperty.call(el, 'color')) delete el.color;
      if (Object.prototype.hasOwnProperty.call(el, 'label_size')) delete el.label_size;
      if (Object.prototype.hasOwnProperty.call(el, 'label_pos')) delete el.label_pos;
      if (Object.prototype.hasOwnProperty.call(el, 'label_angle')) delete el.label_angle;
    }
    dstArr.push(el);
    ed.selType = newType;
  }

  markDirty();
  renderStructure();
  renderObjectList();
  if (syncForm) showPropsFor(ed.selType, ed.selId);
}

function deleteStructEl(type, id) {
  if (!ld || !type || !id) return;
  const el = getStructByTypeId(type, id);
  if (isStructLocked(el)) {
    edToast('Объект закреплён: удаление недоступно', 'info');
    return;
  }
  if (type === 'wall')      ld.walls      = ld.walls.filter(x => x.id !== id);
  if (type === 'boundary')  ld.boundaries = ld.boundaries.filter(x => x.id !== id);
  if (type === 'partition') ld.partitions = ld.partitions.filter(x => x.id !== id);
  if (type === 'door')      ld.doors      = (ld.doors || []).filter(x => x.id !== id);
  deselect();
  markDirty();
  renderAll();
}

function deleteSelectedDesks() {
  if (!ld) return false;
  if (hasMultiDeskSelection()) {
    const ids = new Set(ed.multiDeskIds || []);
    let removed = 0;
    let lockedSkipped = 0;
    ld.desks = (ld.desks || []).filter((d) => {
      if (!ids.has(d.id)) return true;
      if (isDeskLocked(d)) {
        lockedSkipped += 1;
        return true;
      }
      removed += 1;
      return false;
    });
    clearSelectionState();
    if (removed > 0 || lockedSkipped > 0) {
      if (removed > 0) {
        markDirty();
        renderAll();
      } else {
        renderAll();
      }
      if (removed > 0 && lockedSkipped > 0) {
        edToast(`Удалено мест: ${removed}. Закреплено и пропущено: ${lockedSkipped}`, 'info');
      } else if (removed > 0) {
        edToast(`Удалено мест: ${removed}`, 'info');
      } else {
        edToast('Выбранные места закреплены и не могут быть удалены', 'info');
      }
      return removed > 0;
    }
    return false;
  }
  if (ed.selType === 'desk' && ed.selId) {
    const target = (ld.desks || []).find((d) => d.id === ed.selId);
    if (isDeskLocked(target)) {
      edToast('Объект закреплён: удаление недоступно', 'info');
      return false;
    }
    ld.desks = ld.desks.filter(d => d.id !== ed.selId);
    clearSelectionState();
    markDirty();
    renderAll();
    return true;
  }
  return false;
}

function deleteSelectedStructures() {
  if (!ld) return false;
  if (hasMultiStructSelection()) {
    const byType = { wall: new Set(), boundary: new Set(), partition: new Set(), door: new Set() };
    (ed.multiStructKeys || []).forEach((raw) => {
      const parsed = parseStructSelKey(raw);
      if (parsed) byType[parsed.type]?.add(parsed.id);
    });

    const out = { removed: 0, locked: 0, wall: 0, boundary: 0, partition: 0, door: 0 };
    const prune = (arr, type) => (arr || []).filter((el) => {
      if (!byType[type]?.has(el.id)) return true;
      if (isStructLocked(el)) {
        out.locked += 1;
        return true;
      }
      out.removed += 1;
      out[type] += 1;
      return false;
    });

    ld.walls = prune(ld.walls, 'wall');
    ld.boundaries = prune(ld.boundaries, 'boundary');
    ld.partitions = prune(ld.partitions, 'partition');
    ld.doors = prune(ld.doors, 'door');
    clearSelectionState();
    if (out.removed > 0 || out.locked > 0) {
      if (out.removed > 0) {
        markDirty();
        renderAll();
      } else {
        renderAll();
      }
      if (out.removed > 0 && out.locked > 0) {
        edToast(`Удалено: ${out.removed} (стен ${out.wall}, границ ${out.boundary}, перегородок ${out.partition}, дверей ${out.door}). Закреплено: ${out.locked}`, 'info');
      } else if (out.removed > 0) {
        edToast(`Удалено: ${out.removed} (стен ${out.wall}, границ ${out.boundary}, перегородок ${out.partition}, дверей ${out.door})`, 'info');
      } else {
        edToast('Выбранные элементы закреплены и не могут быть удалены', 'info');
      }
      return out.removed > 0;
    }
    return false;
  }
  if (isStructType(ed.selType) && ed.selId) {
    deleteStructEl(ed.selType, ed.selId);
    return true;
  }
  return false;
}

function deleteSelectedMultiObjects() {
  if (!ld) return false;
  const hasDesk = hasMultiDeskSelection();
  const hasStruct = hasMultiStructSelection();
  if (!hasDesk && !hasStruct) return false;

  const selectedDeskIds = new Set(ed.multiDeskIds || []);
  const selectedStructByType = { wall: new Set(), boundary: new Set(), partition: new Set(), door: new Set() };
  (ed.multiStructKeys || []).forEach((raw) => {
    const parsed = parseStructSelKey(raw);
    if (parsed) selectedStructByType[parsed.type]?.add(parsed.id);
  });

  let removedDesks = 0;
  let lockedDesks = 0;
  ld.desks = (ld.desks || []).filter((d) => {
    if (!selectedDeskIds.has(d.id)) return true;
    if (isDeskLocked(d)) {
      lockedDesks += 1;
      return true;
    }
    removedDesks += 1;
    return false;
  });

  const removedStruct = { wall: 0, boundary: 0, partition: 0, door: 0 };
  let lockedStruct = 0;
  const pruneStruct = (arr, type) => (arr || []).filter((el) => {
    if (!selectedStructByType[type]?.has(el.id)) return true;
    if (isStructLocked(el)) {
      lockedStruct += 1;
      return true;
    }
    removedStruct[type] += 1;
    return false;
  });
  ld.walls = pruneStruct(ld.walls, 'wall');
  ld.boundaries = pruneStruct(ld.boundaries, 'boundary');
  ld.partitions = pruneStruct(ld.partitions, 'partition');
  ld.doors = pruneStruct(ld.doors, 'door');

  const totalRemovedStruct = removedStruct.wall + removedStruct.boundary + removedStruct.partition + removedStruct.door;
  const totalRemoved = removedDesks + totalRemovedStruct;
  const totalLocked = lockedDesks + lockedStruct;
  clearSelectionState();
  if (totalRemoved > 0) {
    markDirty();
    renderAll();
  } else {
    renderAll();
  }

  if (totalRemoved > 0 && totalLocked > 0) {
    edToast(`Удалено: ${totalRemoved} (мест ${removedDesks}, стен ${removedStruct.wall}, границ ${removedStruct.boundary}, перегородок ${removedStruct.partition}, дверей ${removedStruct.door}). Закреплено: ${totalLocked}`, 'info');
  } else if (totalRemoved > 0) {
    edToast(`Удалено: ${totalRemoved} (мест ${removedDesks}, стен ${removedStruct.wall}, границ ${removedStruct.boundary}, перегородок ${removedStruct.partition}, дверей ${removedStruct.door})`, 'info');
  } else if (totalLocked > 0) {
    edToast('Выбранные объекты закреплены и не могут быть удалены', 'info');
  }
  return totalRemoved > 0;
}

function startBackgroundDrag(e, startPt) {
  if (!ld || !ed.bgAdjust.active || !ld.bg_url) return false;
  const bg = getBackgroundRect();
  ed.bgAdjust.dragging = true;
  ed.bgAdjust.start = {
    pointerId: e.pointerId,
    pt: startPt,
    x: bg.x,
    y: bg.y,
    changed: false,
  };
  _svg()?.setPointerCapture(e.pointerId);
  renderBackground();
  return true;
}

function updateBackgroundDrag(pt) {
  const drag = ed.bgAdjust.start;
  if (!drag || !ld) return;
  const dx = pt.x - drag.pt.x;
  const dy = pt.y - drag.pt.y;
  const bg = getBackgroundRect();
  bg.x = drag.x + dx;
  bg.y = drag.y + dy;
  setBackgroundRect(bg, { markDirty: false });
  drag.changed = drag.changed || Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2;
}

function endBackgroundDrag() {
  if (!ed.bgAdjust.dragging) return false;
  const changed = !!ed.bgAdjust.start?.changed;
  ed.bgAdjust.dragging = false;
  ed.bgAdjust.start = null;
  renderBackground();
  if (changed) {
    markDirty();
    return true;
  }
  return false;
}

function startMarqueeSelection(pointerId, startPt, append) {
  ed.marquee = {
    pointerId,
    start: { x: startPt.x, y: startPt.y },
    current: { x: startPt.x, y: startPt.y },
    append: !!append,
  };
  _svg()?.setPointerCapture(pointerId);
  renderSelection();
}

function updateMarqueeSelection(pt) {
  if (!ed.marquee) return;
  ed.marquee.current = { x: pt.x, y: pt.y };
  renderSelection();
}

function finishMarqueeSelection() {
  if (!ed.marquee || !ld) return false;
  const m = ed.marquee;
  const x1 = Math.min(m.start.x, m.current.x);
  const y1 = Math.min(m.start.y, m.current.y);
  const x2 = Math.max(m.start.x, m.current.x);
  const y2 = Math.max(m.start.y, m.current.y);
  ed.marquee = null;

  const dxPx = worldUnitsForScreenPx(MARQUEE_MIN_PX);
  const isClick = (x2 - x1) < dxPx && (y2 - y1) < dxPx;
  if (isClick) {
    const hit = findNearestObjectAtPoint(m.current || m.start);
    if (hit?.type && hit?.id) {
      if (m.append) {
        if (hit.type === 'desk') toggleDeskMultiSelection(hit.id, { keepStruct: true });
        else if (isStructType(hit.type)) toggleStructMultiSelection(hit.type, hit.id, { keepDesk: true });
      } else {
        selectObj(hit.type, hit.id);
      }
      return true;
    }
    if (!m.append) clearSelectionState();
    renderStructure();
    renderDesks();
    renderSelection();
    renderObjectList();
    showPropsFor(null, null);
    return true;
  }

  const deskIds = (ld.desks || [])
    .filter(d => !(d.x > x2 || d.x + d.w < x1 || d.y > y2 || d.y + d.h < y1))
    .map(d => d.id);
  const structKeys = [];
  STRUCT_TYPES.forEach((type) => {
    const arr = structArrayByType(type) || [];
    arr
      .filter(el => structIntersectsRect(el, x1, y1, x2, y2))
      .forEach((el) => {
        const key = structSelKey(type, el.id);
        if (key) structKeys.push(key);
      });
  });
  setCombinedMultiSelection(deskIds, structKeys, m.append);
  return true;
}

function startGroupDrag(pointerId, startPt) {
  if (!ld) return false;
  const deskIds = new Set(ed.multiDeskIds || []);
  const structKeys = new Set(ed.multiStructKeys || []);

  const desks = (ld.desks || [])
    .filter(d => deskIds.has(d.id) && !isDeskLocked(d))
    .map(d => ({ desk: d, x: d.x, y: d.y }));

  const structs = [];
  structKeys.forEach((raw) => {
    const parsed = parseStructSelKey(raw);
    if (!parsed) return;
    const el = getStructByTypeId(parsed.type, parsed.id);
    if (!el || !Array.isArray(el.pts) || isStructLocked(el)) return;
    structs.push({
      type: parsed.type,
      el,
      pts: el.pts.map(p => [Number(p?.[0] || 0), Number(p?.[1] || 0)]),
    });
  });

  if (!desks.length && !structs.length) {
    edToast('Выбранные объекты закреплены и не могут двигаться', 'info');
    return false;
  }

  ed.dragGroup = { pointerId, startPt, desks, structs, moved: false };
  _svg()?.setPointerCapture(pointerId);
  return true;
}

function updateGroupDrag(pt) {
  const g = ed.dragGroup;
  if (!g) return;
  const dx = pt.x - g.startPt.x;
  const dy = pt.y - g.startPt.y;
  for (const it of (g.desks || [])) {
    it.desk.x = snapV(it.x + dx);
    it.desk.y = snapV(it.y + dy);
  }
  for (const it of (g.structs || [])) {
    it.el.pts = it.pts.map(([x, y]) => [snapV(x + dx), snapV(y + dy)]);
  }
  g.moved = g.moved || Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2;
  if (g.structs?.length) renderStructure();
  if (g.desks?.length) renderDesks();
  renderSelection();
}

function endGroupDrag() {
  if (!ed.dragGroup) return false;
  const moved = !!ed.dragGroup.moved;
  ed.dragGroup = null;
  if (moved) markDirty();
  return moved;
}

function structArrayByType(type) {
  if (!ld) return null;
  if (type === 'wall') return ld.walls;
  if (type === 'boundary') return ld.boundaries;
  if (type === 'partition') return ld.partitions;
  if (type === 'door') return ld.doors || [];
  return null;
}

function startSingleStructDrag(type, id, startPt) {
  if (!ld || !id) return false;
  const arr = structArrayByType(type);
  if (!Array.isArray(arr)) return false;
  const el = arr.find(x => x.id === id);
  if (!el || !Array.isArray(el.pts) || el.pts.length < 2) return false;
  if (isStructLocked(el)) {
    edToast('Объект закреплён и не может быть перемещён', 'info');
    return false;
  }

  const basePts = el.pts.map(p => [Number(p?.[0] || 0), Number(p?.[1] || 0)]);
  let moved = false;

  const onMove = (ev) => {
    const p = svgPt(ev);
    const dx = p.x - startPt.x;
    const dy = p.y - startPt.y;
    el.pts = basePts.map(([x, y]) => [snapV(x + dx), snapV(y + dy)]);
    moved = moved || Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2;
    renderStructure();
    renderSelection();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (moved) markDirty();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  return true;
}

/* ── Input event handlers ───────────────────────────────────────────────────── */
function onSvgPointerDown(e) {
  const target = e.target;
  const inBackground = target === _svg() || target.closest('#ed-layer-bg') ||
                       target === document.getElementById('ed-grid-rect');
  const pt = svgPt(e);

  // Space + drag — pan regardless of mode
  if (ed.spaceDown) {
    e.preventDefault();
    ed.spacePanning = true;
    ed.spacePanStart = { svgPt: svgPt(e), vx: ed.vb.x, vy: ed.vb.y };
    _svg()?.setPointerCapture(e.pointerId);
    return;
  }

  if (ed.mode === 'pan') {
    ed.panning  = true;
    ed.panStart = { svgPt: pt, vx: ed.vb.x, vy: ed.vb.y };
    _svg()?.setPointerCapture(e.pointerId);
    document.getElementById('ed-canvas-wrap')?.classList.add('panning');
    return;
  }

  if (ed.bgAdjust.active && inBackground) {
    e.preventDefault();
    startBackgroundDrag(e, pt);
    return;
  }

  if (!inBackground) return;

  if (isDeskBlockMode()) {
    const preview = ed.deskTool.preview;
    if (preview?.awaitConfirm) return;
    e.preventDefault();
    startDeskBlockPreview(pt, e.pointerId);
    return;
  }

  if (['wall','boundary','partition','door'].includes(ed.mode)) {
    e.preventDefault();
    const pt = svgPt(e);
    const snapped = [snapV(pt.x), snapV(pt.y)];

    if (!ed.drawing) {
      ed.drawing = { type: ed.mode, pts: [snapped], rubberPt: snapped };
      renderDrawing();
    }
    return;
  }

  if (ed.mode === 'desk') {
    e.preventDefault();
    placeDeskAt(pt);
    return;
  }

  if (ed.mode === 'select' && inBackground) {
    e.preventDefault();
    startMarqueeSelection(e.pointerId, pt, !!e.shiftKey);
  }
}

function onSvgPointerMove(e) {
  const pt = svgPt(e);
  const coordEl = $el('ed-status-coords');
  if (coordEl) coordEl.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;

  if (ed.bgAdjust.dragging) {
    updateBackgroundDrag(pt);
    return;
  }

  if (ed.dragGroup) {
    updateGroupDrag(pt);
    return;
  }

  if (ed.marquee) {
    updateMarqueeSelection(pt);
    return;
  }

  // Space-pan
  if (ed.spacePanning && ed.spacePanStart) {
    const dx = pt.x - ed.spacePanStart.svgPt.x;
    const dy = pt.y - ed.spacePanStart.svgPt.y;
    setVb(ed.spacePanStart.vx - dx, ed.spacePanStart.vy - dy, ed.vb.w, ed.vb.h);
    return;
  }

  // Pan mode
  if (ed.panning && ed.panStart) {
    const dx = pt.x - ed.panStart.svgPt.x;
    const dy = pt.y - ed.panStart.svgPt.y;
    setVb(ed.panStart.vx - dx, ed.panStart.vy - dy, ed.vb.w, ed.vb.h);
    return;
  }

  if (isDeskBlockMode() && ed.deskTool.preview?.dragging) {
    rebuildDeskBlockPreview(pt);
    return;
  }

  // Drawing rubber band
  if (ed.drawing) {
    const last = ed.drawing.pts?.[ed.drawing.pts.length - 1];
    ed.drawing.rubberPt = getConstrainedDrawPoint(last, pt, {
      angleLock: !!e.shiftKey,
      angleStepDeg: DRAW_ANGLE_STEP_DEG,
    });
    renderDrawing();
  }
}

function onSvgPointerUp(e) {
  if (ed.bgAdjust.dragging) {
    endBackgroundDrag();
    return;
  }
  if (ed.dragGroup) {
    endGroupDrag();
    return;
  }
  if (ed.marquee && finishMarqueeSelection()) {
    return;
  }
  if (isDeskBlockMode() && finalizeDeskBlockPreview()) {
    return;
  }
  if (ed.spacePanning) {
    ed.spacePanning = false;
    ed.spacePanStart = null;
    return;
  }
  if (ed.panning) {
    ed.panning = false;
    ed.panStart = null;
    document.getElementById('ed-canvas-wrap')?.classList.remove('panning');
  }
}

function onSvgClick(e) {
  if (ed.spacePanning || ed.panning) return;

  const target = e.target;
  const inBackground = target === _svg() ||
    target.closest('#ed-layer-bg') ||
    target === document.getElementById('ed-grid-rect');

  if (!inBackground) return;

  if (isDeskBlockMode()) {
    const preview = ed.deskTool.preview;
    if (!preview) return;
    if (preview.justReleased) {
      preview.justReleased = false;
      return;
    }
    if (preview.awaitConfirm) {
      commitDeskBlockPreview();
    }
    return;
  }

  if (['wall','boundary','partition','door'].includes(ed.mode) && ed.drawing) {
    const pt = svgPt(e);
    const pts = ed.drawing.pts;
    const base = pts?.[pts.length - 1];
    const snapped = getConstrainedDrawPoint(base, pt, {
      angleLock: !!e.shiftKey,
      angleStepDeg: DRAW_ANGLE_STEP_DEG,
    });

    // Close boundary on click near first point
    if (ed.mode === 'boundary' && pts.length >= 3) {
      const [fx, fy] = pts[0];
      const closeR = worldUnitsForScreenPx(PX_CLOSE_THRESHOLD);
      if (Math.hypot(snapped[0] - fx, snapped[1] - fy) < closeR) {
        finishDrawing(true);
        return;
      }
    }

    pts.push(snapped);
    renderDrawing();
  }
}

function onSvgDblClick(e) {
  if (['wall','partition','door'].includes(ed.mode) && ed.drawing) {
    finishDrawing(false);
  }
}

function onWheelZoom(e) {
  e.preventDefault();
  const pt = svgPt(e);

  // Smooth wheel zoom:
  // - proportional to wheel delta (trackpad-friendly)
  // - clamped to avoid sudden jumps on large deltas
  const rawDelta = Number.isFinite(e.deltaY) ? e.deltaY : 0;
  const delta = Math.max(-120, Math.min(120, rawDelta));
  const speed = e.ctrlKey ? 0.00075 : 0.00115;
  const factor = Math.exp(delta * speed);

  if (ed.bgAdjust.active && ld?.bg_url) {
    const bg = getBackgroundRect();
    const rx = (pt.x - bg.x) / Math.max(1e-6, bg.w);
    const ry = (pt.y - bg.y) / Math.max(1e-6, bg.h);
    const nextW = Math.max(10, bg.w * factor);
    const nextH = Math.max(10, bg.h * factor);
    const nextX = pt.x - rx * nextW;
    const nextY = pt.y - ry * nextH;
    setBackgroundRect({ x: nextX, y: nextY, w: nextW, h: nextH }, { markDirty: true });
    return;
  }
  zoomBy(factor, pt.x, pt.y);
}

function onRotateHandleDown(e, desk) {
  if (ed.mode !== 'select') return;
  if (isDeskLocked(desk)) {
    edToast('Объект закреплён и не может быть изменён', 'info');
    return;
  }
  e.stopPropagation();
  e.preventDefault();
  const captureTarget = _svg();
  try { captureTarget?.setPointerCapture(e.pointerId); } catch {}

  const cx = desk.x + desk.w / 2;
  const cy = desk.y + desk.h / 2;
  const startPt = svgPt(e);
  const startPointerAngle = Math.atan2(startPt.y - cy, startPt.x - cx);
  const startDeskRotation = normalizeDeskRotation(desk.r || 0);
  let moved = false;

  const onMove = (ev) => {
    const p = svgPt(ev);
    const currentPointerAngle = Math.atan2(p.y - cy, p.x - cx);
    let delta = currentPointerAngle - startPointerAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    const step = ev.shiftKey ? 1 : 5;
    const raw = startDeskRotation + delta * (180 / Math.PI);
    const snapped = Math.round(raw / step) * step;
    const next = normalizeDeskRotation(snapped);
    if (Math.abs(next - (desk.r || 0)) > 1e-6) moved = true;
    desk.r = next;
    _v('ep-r', Math.round(next));
    renderDesks();
    renderSelection();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    try { captureTarget?.releasePointerCapture(e.pointerId); } catch {}
    if (moved) {
      markDirty();
      renderObjectList();
    }
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function onMultiDeskRotateHandleDown(e, deskIds) {
  if (ed.mode !== 'select' || !ld) return;
  const ids = Array.isArray(deskIds) ? deskIds.filter(Boolean) : [];
  if (!ids.length) return;

  const targets = (ld.desks || []).filter((d) => ids.includes(d.id) && !isDeskLocked(d));
  if (!targets.length) return;

  e.stopPropagation();
  e.preventDefault();
  const captureTarget = _svg();
  try { captureTarget?.setPointerCapture(e.pointerId); } catch {}

  const box = deskSelectionBounds(ids);
  if (!box) return;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const startPt = svgPt(e);
  const startPointerAngle = Math.atan2(startPt.y - cy, startPt.x - cx);
  const snapshots = targets.map((d) => ({
    desk: d,
    cx: d.x + d.w / 2,
    cy: d.y + d.h / 2,
    r: normalizeDeskRotation(d.r || 0),
  }));
  let moved = false;

  const onMove = (ev) => {
    const p = svgPt(ev);
    const currentPointerAngle = Math.atan2(p.y - cy, p.x - cx);
    let delta = currentPointerAngle - startPointerAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    const step = ev.shiftKey ? 1 : 5;
    const rawDeltaDeg = delta * (180 / Math.PI);
    const snappedDeltaDeg = Math.round(rawDeltaDeg / step) * step;
    const deltaRad = _degToRad(snappedDeltaDeg);
    const cos = Math.cos(deltaRad);
    const sin = Math.sin(deltaRad);
    moved = moved || Math.abs(snappedDeltaDeg) > 1e-6;

    for (const it of snapshots) {
      const vx = it.cx - cx;
      const vy = it.cy - cy;
      const nextCx = cx + vx * cos - vy * sin;
      const nextCy = cy + vx * sin + vy * cos;
      it.desk.x = snapV(nextCx - it.desk.w / 2);
      it.desk.y = snapV(nextCy - it.desk.h / 2);
      it.desk.r = normalizeDeskRotation(it.r + snappedDeltaDeg);
    }

    renderDesks();
    renderSelection();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    try { captureTarget?.releasePointerCapture(e.pointerId); } catch {}
    if (!moved) return;
    markDirty();
    renderObjectList();
    syncDeskBatchPanel();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function onDeskPointerDown(e, desk) {
  if (ed.mode !== 'select') return;
  e.stopPropagation();

  if (e.shiftKey) {
    toggleDeskMultiSelection(desk.id, { keepStruct: true });
    return;
  }

  if ((hasMultiDeskSelection() || hasMultiStructSelection()) && (ed.multiDeskIds || []).includes(desk.id)) {
    const startPt = svgPt(e);
    startGroupDrag(e.pointerId, startPt);
    return;
  }

  selectObj('desk', desk.id);
  if (isDeskLocked(desk)) {
    edToast('Объект закреплён и не может быть перемещён', 'info');
    return;
  }

  const startPt = svgPt(e);
  const sx = desk.x;
  const sy = desk.y;
  let moved = false;

  const onMove = ev => {
    const p = svgPt(ev);
    moved = moved || Math.abs(p.x - startPt.x) > 0.2 || Math.abs(p.y - startPt.y) > 0.2;
    desk.x = snapV(sx + p.x - startPt.x);
    desk.y = snapV(sy + p.y - startPt.y);
    _v('ep-x', Math.round(desk.x));
    _v('ep-y', Math.round(desk.y));
    renderDesks();
    renderSelection();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (moved) markDirty();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function onResizeHandleDown(e, desk, handleIdx) {
  if (isDeskLocked(desk)) {
    edToast('Объект закреплён и не может быть изменён', 'info');
    return;
  }
  e.stopPropagation();
  const startPt = svgPt(e);
  const sx = desk.x, sy = desk.y, sw2 = desk.w, sh = desk.h;

  const onMove = ev => {
    const p = svgPt(ev);
    const dx = snapV(p.x - startPt.x), dy = snapV(p.y - startPt.y);
    switch (handleIdx) {
      case 0: desk.x = sx+dx; desk.y = sy+dy; desk.w = sw2-dx; desk.h = sh-dy; break;
      case 1: desk.y = sy+dy; desk.h = sh-dy; break;
      case 2: desk.y = sy+dy; desk.w = sw2+dx; desk.h = sh-dy; break;
      case 3: desk.w = sw2+dx; break;
      case 4: desk.w = sw2+dx; desk.h = sh+dy; break;
      case 5: desk.h = sh+dy; break;
      case 6: desk.x = sx+dx; desk.w = sw2-dx; desk.h = sh+dy; break;
      case 7: desk.x = sx+dx; desk.w = sw2-dx; break;
    }
    desk.w = Math.max(5, desk.w); desk.h = Math.max(5, desk.h);
    _v('ep-x', Math.round(desk.x)); _v('ep-y', Math.round(desk.y));
    _v('ep-w', Math.round(desk.w)); _v('ep-h', Math.round(desk.h));
    renderDesks(); renderSelection();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    markDirty();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function onStructPointerDown(e, type, id) {
  if (ed.mode !== 'select') return;
  e.stopPropagation();
  if (e.shiftKey) {
    toggleStructMultiSelection(type, id, { keepDesk: true });
    return;
  }
  const key = structSelKey(type, id);
  if ((hasMultiDeskSelection() || hasMultiStructSelection()) && key && (ed.multiStructKeys || []).includes(key)) {
    const startPt = svgPt(e);
    startGroupDrag(e.pointerId, startPt);
    return;
  }
  selectObj(type, id);
  const el = getStructByTypeId(type, id);
  if (isStructLocked(el)) {
    edToast('Объект закреплён и не может быть перемещён', 'info');
    return;
  }
  startSingleStructDrag(type, id, svgPt(e));
}

/* ── Drawing finish ─────────────────────────────────────────────────────────── */
function finishDrawing(close) {
  if (!ed.drawing) return;
  const { type, pts } = ed.drawing;
  ed.drawing = null;
  const layer = _layer('draw');
  if (layer) layer.innerHTML = '';

  if (pts.length < 2) return;

  const el = {
    id: uid(),
    pts,
    thick: type === 'wall' ? 8 : type === 'partition' ? 3 : type === 'door' ? 2.2 : 2,
    closed: close || type === 'boundary',
    conf: 1.0,
    locked: false,
  };
  if (type === 'boundary') {
    el.label = null;
    el.color = DEFAULT_ZONE_COLOR;
    el.label_size = defaultZoneLabelSize();
    el.label_pos = 'center';
    el.label_angle = 0;
  }

  if (type === 'wall')      ld.walls.push(el);
  else if (type === 'boundary')  ld.boundaries.push(el);
  else if (type === 'partition') ld.partitions.push(el);
  else if (type === 'door') ld.doors = [...(ld.doors || []), el];

  markDirty();
  selectObj(type, el.id);
  renderStructure();
}

/* ── Desk placement ─────────────────────────────────────────────────────────── */
function buildDeskBlockRects(anchor, orientation, direction) {
  if (!ld) return [];
  const seatsPerRow = clampInt(ed.deskTool.seatsPerRow, 1, 100, 6);
  const rows = ed.deskTool.pattern === 'double'
    ? clampInt(ed.deskTool.pairCount, 1, 25, 1) * 2
    : clampInt(ed.deskTool.rowCount, 1, 50, 2);
  const { w, h } = defaultDeskSize();

  const seatStep = w * 1.22;
  const rowStep = h * 1.8;
  const aisleGap = h * 2.4;

  const sign = direction >= 0 ? 1 : -1;
  const ux = orientation === 'vertical' ? 0 : sign;
  const uy = orientation === 'vertical' ? sign : 0;
  const vx = orientation === 'vertical' ? 1 : 0;
  const vy = orientation === 'vertical' ? 0 : 1;

  const rects = [];
  for (let rIdx = 0; rIdx < rows; rIdx += 1) {
    let rowOffset = 0;
    if (ed.deskTool.pattern === 'double') {
      const pairIdx = Math.floor(rIdx / 2);
      const inPair = rIdx % 2;
      rowOffset = pairIdx * (rowStep * 2 + aisleGap) + inPair * rowStep;
    } else {
      rowOffset = rIdx * rowStep;
    }

    for (let cIdx = 0; cIdx < seatsPerRow; cIdx += 1) {
      const along = cIdx * seatStep;
      const cx = anchor.x + ux * along + vx * rowOffset;
      const cy = anchor.y + uy * along + vy * rowOffset;
      rects.push({
        x: snapV(cx - w / 2),
        y: snapV(cy - h / 2),
        w,
        h,
      });
    }
  }
  return rects;
}

function rebuildDeskBlockPreview(currentPt) {
  const preview = ed.deskTool.preview;
  if (!preview || !ld) return;
  preview.current = currentPt || preview.current || preview.anchor;

  const axis = ed.deskTool.axis === 'vertical' ? 'vertical' : 'horizontal';
  preview.orientation = axis;

  const dx = preview.current.x - preview.anchor.x;
  const dy = preview.current.y - preview.anchor.y;
  const dragMin = worldUnitsForScreenPx(8);

  const axisDelta = axis === 'vertical' ? dy : dx;
  if (Math.abs(axisDelta) > dragMin) {
    preview.direction = axisDelta >= 0 ? 1 : -1;
  }

  const rects = buildDeskBlockRects(preview.anchor, preview.orientation, preview.direction);
  const existing = ld.desks || [];

  let conflictCount = 0;
  const desks = rects.map(r => {
    const conflict = existing.some(d => rectsOverlap(r, d));
    if (conflict) conflictCount += 1;
    return { ...r, conflict };
  });

  preview.desks = desks;
  preview.conflicts = conflictCount;
  preview.overflow = existing.length + desks.length > MAX_LAYOUT_DESKS;

  syncDeskBulkControls();
  renderDrawing();
}

function startDeskBlockPreview(pt, pointerId) {
  const anchor = { x: snapV(pt.x), y: snapV(pt.y) };
  ed.deskTool.preview = {
    anchor,
    current: anchor,
    orientation: 'horizontal',
    direction: 1,
    dragging: true,
    awaitConfirm: false,
    justReleased: false,
    pointerId,
    desks: [],
    conflicts: 0,
    overflow: false,
  };
  rebuildDeskBlockPreview(anchor);
  _svg()?.setPointerCapture(pointerId);
}

function finalizeDeskBlockPreview() {
  const preview = ed.deskTool.preview;
  if (!preview || !preview.dragging) return false;
  preview.dragging = false;
  preview.awaitConfirm = true;
  preview.justReleased = true;
  syncDeskBulkControls();
  renderDrawing();
  return true;
}

function cancelDeskBlockPreview() {
  if (!ed.deskTool.preview) return false;
  ed.deskTool.preview = null;
  syncDeskBulkControls();
  renderDrawing();
  return true;
}

function commitDeskBlockPreview() {
  if (!ld) return false;
  const preview = ed.deskTool.preview;
  if (!preview || !preview.awaitConfirm) return false;
  if (!preview.desks.length) {
    cancelDeskBlockPreview();
    return true;
  }
  if (preview.overflow) {
    edToast(`Нельзя добавить блок: лимит ${MAX_LAYOUT_DESKS} мест на схему`, 'error');
    return true;
  }

  const used = collectDeskNumberSet();
  const inserted = preview.desks.map(r => makeDeskRecord(
    { x: r.x, y: r.y, w: r.w, h: r.h },
    takeNextDeskLabel(used),
  ));
  ld.desks.push(...inserted);
  markDirty();

  const conflicts = preview.conflicts;
  cancelDeskBlockPreview();
  renderAll();
  if (inserted[0]) selectObj('desk', inserted[0].id);
  edToast(
    `Добавлено мест: ${inserted.length}${conflicts ? ` (конфликтов: ${conflicts})` : ''}`,
    conflicts ? 'info' : 'success',
  );
  return true;
}

function placeDeskAt(pt) {
  if (!ld) return;
  if (ld.desks.length >= MAX_LAYOUT_DESKS) {
    edToast(`Достигнут лимит ${MAX_LAYOUT_DESKS} мест`, 'error');
    return;
  }
  const { w, h } = defaultDeskSize();
  const used = collectDeskNumberSet();
  const desk = makeDeskRecord(
    { x: snapV(pt.x - w / 2), y: snapV(pt.y - h / 2), w, h },
    takeNextDeskLabel(used),
  );
  ld.desks.push(desk);
  markDirty();
  selectObj('desk', desk.id);
  updateEditorKpis();
}

function setBackgroundAdjustMode(active) {
  const canUse = !!(ld?.bg_url);
  ed.bgAdjust.active = !!active && canUse;
  if (!ed.bgAdjust.active) {
    endBackgroundDrag();
  }
  const wrap = document.getElementById('ed-canvas-wrap');
  wrap?.classList.toggle('bg-adjust', ed.bgAdjust.active);
  $el('ed-bg-adjust-btn')?.classList.toggle('active', ed.bgAdjust.active);
  renderBackground();
  updateStatusBar();
}

function toggleBackgroundAdjustMode() {
  if (!ld?.bg_url) {
    edToast('Сначала загрузите фон', 'error');
    return;
  }
  setBackgroundAdjustMode(!ed.bgAdjust.active);
}

/* ── Mode switching ─────────────────────────────────────────────────────────── */
function setMode(mode) {
  // Cancel drawing when switching away
  if (ed.drawing && mode !== ed.mode) {
    ed.drawing = null;
    const l = _layer('draw'); if (l) l.innerHTML = '';
  }
  if (mode !== 'desk') {
    cancelDeskBlockPreview();
  }
  if (ed.bgAdjust.active) {
    setBackgroundAdjustMode(false);
  }
  ed.mode = mode;

  document.querySelectorAll('.ed-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const wrap = document.getElementById('ed-canvas-wrap');
  if (wrap) {
    wrap.className = wrap.className.replace(/\bmode-\w+/g, '');
    wrap.classList.add('mode-' + mode);
  }
  syncDeskBulkControls();
  updateStatusBar();
  renderDrawing();
}

/* ── Grid ───────────────────────────────────────────────────────────────────── */
function updateGridPattern() {
  const pat = document.getElementById('ed-grid-pat');
  const rect = document.getElementById('ed-grid-rect');
  if (!pat || !rect) return;
  pat.setAttribute('patternUnits', 'userSpaceOnUse');
  pat.setAttribute('width', String(ed.gridSize));
  pat.setAttribute('height', String(ed.gridSize));
  pat.removeAttribute('patternTransform');

  rect.setAttribute('x', String(ed.vb.x));
  rect.setAttribute('y', String(ed.vb.y));
  rect.setAttribute('width', String(ed.vb.w));
  rect.setAttribute('height', String(ed.vb.h));
}

/* ── Load floor ─────────────────────────────────────────────────────────────── */
async function edLoadFloor(floorId) {
  if (!floorId) {
    ld = null;
    ed = resetEd();
    renderAll();
    syncDeskBulkControls();
    updateStatusBar();
    updateEditorUI();
    updateLockUI();
    return;
  }

  cancelDeskBlockPreview();
  setBackgroundAdjustMode(false);
  ed.floorId = floorId;
  try {
    const resp = await fetch(`${API}/floors/${floorId}/layout`, { headers: ah() });
    if (resp.status === 404) {
      // No layout yet — create empty
      ld = { v: 2, vb: [0,0,1000,1000], bg_url: null, bg_transform: null, walls:[], boundaries:[], partitions:[], doors:[], desks:[] };
      ed.status  = null;
      ed.version = 0;
    } else if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      edToast('Ошибка загрузки: ' + (b.detail || resp.status), 'error');
      return;
    } else {
      const data = await resp.json();
      ld = ensureLayoutArrays(data.layout);
      ed.status  = data.status;
      ed.version = data.version;
      if (ld?.bg_url && !ld.bg_transform) {
        const vb = getCanvasRect();
        ld.bg_transform = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
      }
    }

    ed.dirty = false;
    updateEditorUI();
    fitToScreen();
    renderAll();

    // Check lock
    ed.locked = false;
    ed.lockOwner = null;
    updateLockUI();
    const lockResp = await fetch(`${API}/floors/${floorId}/lock`, { headers: ah() });
    if (lockResp.ok) {
      const lk = await lockResp.json();
      if (lk.locked) {
        ed.locked    = true;
        ed.lockOwner = lk.locked_by_username;
      }
      updateLockUI();
    }
  } catch (ex) {
    edToast('Ошибка: ' + ex.message, 'error');
  }
}

/* ── Lock ───────────────────────────────────────────────────────────────────── */
async function acquireLock() {
  if (!ed.floorId) return;
  try {
    const resp = await fetch(`${API}/floors/${ed.floorId}/lock`, { method: 'POST', headers: ah() });
    if (resp.status === 423) {
      const b = await resp.json();
      edToast('Заблокировано: ' + b.detail, 'error'); return;
    }
    if (!resp.ok) { edToast('Ошибка захвата', 'error'); return; }
    const lk = await resp.json();
    ed.locked = true;
    ed.lockOwner = lk.locked_by_username;
    ed.lockExpiresAt = lk.expires_at;
    startLockRenew();
    updateLockUI();
    edToast('Редактирование захвачено (10 мин)', 'success');
  } catch (ex) {
    edToast('Ошибка: ' + ex.message, 'error');
  }
}

async function releaseLock() {
  if (!ed.floorId || !ed.locked) return;
  stopLockRenew();
  await fetch(`${API}/floors/${ed.floorId}/lock`, { method: 'DELETE', headers: ah() }).catch(() => {});
  ed.locked = false; ed.lockOwner = null;
  updateLockUI();
}

function startLockRenew() {
  stopLockRenew();
  // Renew every 8 minutes (before 10 min expiry)
  ed.lockRenewInterval = setInterval(async () => {
    if (!ed.locked || !ed.floorId) return;
    await fetch(`${API}/floors/${ed.floorId}/lock`, { method: 'POST', headers: ah() }).catch(() => {});
  }, 8 * 60 * 1000);
}

function stopLockRenew() {
  if (ed.lockRenewInterval) { clearInterval(ed.lockRenewInterval); ed.lockRenewInterval = null; }
}

function isLockOwnedByMe() {
  if (!ed.locked) return false;
  const me = localStorage.getItem('admin_username');
  if (!ed.lockOwner || !me) return true;
  return ed.lockOwner === me;
}

function releaseLockOnExit() {
  if (!ed.floorId || !ed.locked || !isLockOwnedByMe()) return;
  try {
    fetch(`${API}/floors/${ed.floorId}/lock`, {
      method: 'DELETE',
      headers: ah(),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // no-op
  }
}

function updateLockUI() {
  const lockStatus = $el('ed-lock-status');
  const lockBtn    = $el('ed-lock-btn');
  if (!lockStatus || !lockBtn) return;

  if (!ed.floorId) {
    lockStatus.textContent = 'Выберите этаж для редактирования';
    lockStatus.className   = 'ed-lock-status';
    lockBtn.textContent    = 'Захватить';
    lockBtn.disabled = true;
    return;
  }

  if (ed.locked && isLockOwnedByMe()) {
    lockStatus.textContent = '🔒 Вы редактируете';
    lockStatus.className   = 'ed-lock-status locked-by-me';
    lockBtn.textContent    = 'Освободить';
    lockBtn.disabled = false;
  } else if (ed.locked) {
    lockStatus.textContent = '🔒 Занято: ' + (ed.lockOwner || 'другой админ');
    lockStatus.className   = 'ed-lock-status locked-by-other';
    lockBtn.textContent    = 'Занято';
    lockBtn.disabled = true;
  } else {
    lockStatus.textContent = '🔓 Свободно для редактирования';
    lockStatus.className   = 'ed-lock-status';
    lockBtn.textContent    = 'Захватить';
    lockBtn.disabled = false;
  }
}

/* ── Save / Publish / Discard ───────────────────────────────────────────────── */
function _parseExpectedVersion(detail) {
  const m = /expected\s+(\d+)/i.exec(String(detail || ''));
  return m ? parseInt(m[1], 10) : null;
}

async function edSaveDraft(opts = {}) {
  const quiet = !!opts.quiet;
  if (!ed.floorId || !ld) { edToast('Выберите этаж', 'error'); return false; }
  try {
    const sendSave = (version) => fetch(`${API}/floors/${ed.floorId}/layout/draft`, {
      method: 'PUT',
      headers: { ...ah(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, layout: ld }),
    });

    let sentVersion = ed.version;
    let resp = await sendSave(sentVersion);
    if (resp.status === 409) {
      const b = await resp.json().catch(() => ({}));
      const expected = _parseExpectedVersion(b.detail);
      if (Number.isFinite(expected) && expected !== sentVersion) {
        sentVersion = expected;
        resp = await sendSave(sentVersion);
      } else {
        edToast('Конфликт версий — перезагрузите этаж', 'error');
        return false;
      }
    }

    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      edToast('Ошибка: ' + (b.detail || resp.status), 'error');
      return false;
    }

    const data = await resp.json();
    ed.version = data.version;
    ed.status  = data.status;
    ed.dirty   = false;
    updateEditorUI();
    if (!quiet) edToast('Черновик сохранён', 'success');
    return true;
  } catch (ex) {
    edToast('Ошибка: ' + ex.message, 'error');
    return false;
  }
}

async function edPublish() {
  if (!ed.floorId) return;
  if (!ed.dirty && ed.status !== 'draft') {
    edToast('Нет черновика для публикации. Внесите изменения и сохраните.', 'info');
    return;
  }
  if (!confirm('Опубликовать план? Клиенты увидят изменения.')) return;
  try {
    // Save first and stop if save failed.
    if (ed.dirty || ed.status !== 'draft') {
      const ok = await edSaveDraft({ quiet: true });
      if (!ok) return;
    }

    const resp = await fetch(`${API}/floors/${ed.floorId}/layout/publish`, { method:'POST', headers: ah() });
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      const detail = String(b.detail || '');
      if (/no draft to publish/i.test(detail)) {
        edToast('Нет черновика для публикации. Сначала нажмите "Сохранить".', 'error');
      } else {
        edToast('Ошибка: ' + (b.detail || resp.status), 'error');
      }
      return;
    }
    const data = await resp.json();
    ed.version = data.version;
    ed.status  = data.status;
    ed.dirty   = false;
    updateEditorUI();
    edToast('Опубликовано ✓', 'success');
    const syncResult = await syncDesksFromLayout({ source: 'published', cleanup: true, quiet: true });
    if (syncResult) {
      edToast(
        `Места синхронизированы: +${syncResult.created}, обновлено ${syncResult.updated}, удалено ${syncResult.deleted}`,
        'info'
      );
    }
  } catch (ex) { edToast('Ошибка: ' + ex.message, 'error'); }
}

async function edDiscard() {
  if (!ed.floorId) return;
  if (!confirm('Отменить черновик? Несохранённые изменения будут потеряны.')) return;
  try {
    await fetch(`${API}/floors/${ed.floorId}/layout/draft`, { method: 'DELETE', headers: ah() });
    await edLoadFloor(ed.floorId);
    edToast('Черновик отменён', 'info');
  } catch (ex) { edToast('Ошибка: ' + ex.message, 'error'); }
}

/* ── Import ─────────────────────────────────────────────────────────────────── */
let _importResult = null;
let _importItems = [];
let _importOverrides = {};
let _importApplied = new Set();
let _importSelected = new Set();
let _importReviewMode = false;
let _importFilters = { conf: 'all', type: 'all', geom: 'all' };
let _importAppliedCounts = { wall: 0, boundary: 0, partition: 0, door: 0, skip: 0 };
const IMPORT_AUTO_THRESHOLD = 70;

function importDefaultType(el) {
  if (!el) return 'skip';
  // uncertain defaults to boundary, but low confidence stays in review flow.
  if (el._type === 'uncertain') return 'boundary';
  return el._type || 'skip';
}

function importTypeLabel(type) {
  if (type === 'wall') return 'Стена';
  if (type === 'boundary') return 'Граница';
  if (type === 'partition') return 'Перегородка';
  if (type === 'door') return 'Дверь';
  return 'Пропуск';
}

function importKindClass(type) {
  return type === 'wall' || type === 'boundary' || type === 'partition' || type === 'door' ? type : 'skip';
}

function importConfColor(confPct) {
  return confPct >= 70 ? '#22c55e' : confPct >= 40 ? '#f59e0b' : '#ef4444';
}

function resetImportState() {
  _importResult = null;
  _importItems = [];
  _importOverrides = {};
  _importApplied = new Set();
  _importSelected = new Set();
  _importReviewMode = false;
  _importFilters = { conf: 'all', type: 'all', geom: 'all' };
  _importAppliedCounts = { wall: 0, boundary: 0, partition: 0, door: 0, skip: 0 };
}

function importPtsLength(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    total += Math.hypot(Number(b?.[0] || 0) - Number(a?.[0] || 0), Number(b?.[1] || 0) - Number(a?.[1] || 0));
  }
  return total;
}

function importReason(el) {
  const closed = !!el?.closed;
  const len = Math.round(importPtsLength(el?.pts || []));
  const thick = Number(el?.thick);
  const rawFill = String(el?.color || '').trim().toLowerCase();
  const hasFill = !!rawFill
    && rawFill !== 'none'
    && rawFill !== 'transparent'
    && rawFill !== '#00000000'
    && !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/.test(rawFill);
  const thickTxt = Number.isFinite(thick) ? `толщина ${thick.toFixed(1)}` : 'толщина n/a';
  const geomTxt = closed ? 'замкнутый контур (зона/fill)' : 'открытая линия';
  const fillTxt = closed ? (hasFill ? 'fill есть' : 'fill нет') : 'fill n/a';
  return `${geomTxt} · ${fillTxt} · ${thickTxt} · длина ${len}`;
}

function buildImportItems(res) {
  const all = [
    ...((res.walls || []).map(e => ({ ...e, _type: 'wall' }))),
    ...((res.boundaries || []).map(e => ({ ...e, _type: 'boundary' }))),
    ...((res.partitions || []).map(e => ({ ...e, _type: 'partition' }))),
    ...((res.doors || []).map(e => ({ ...e, _type: 'door' }))),
    ...((res.uncertain || []).map(e => ({ ...e, _type: 'uncertain' }))),
  ];
  return all.map((el, idx) => {
    const confPct = Math.max(0, Math.min(100, Math.round(Number(el?.conf || 0) * 100)));
    return {
      ...el,
      _idx: idx,
      _confPct: confPct,
      _len: importPtsLength(el?.pts || []),
      _reason: importReason(el),
    };
  });
}

function importCurrentType(idx) {
  const el = _importItems[idx];
  return _importOverrides[idx] || importDefaultType(el);
}

function importAutoIndices() {
  return _importItems
    .filter(el => Number(el?._confPct || 0) >= IMPORT_AUTO_THRESHOLD)
    .map(el => el._idx);
}

function importReviewIndices() {
  return _importItems
    .filter(el => Number(el?._confPct || 0) < IMPORT_AUTO_THRESHOLD)
    .map(el => el._idx);
}

function importVisibleIndices() {
  const base = (_importReviewMode ? importReviewIndices() : _importItems.map(el => el._idx))
    .filter(idx => !_importApplied.has(idx));
  return base.filter((idx) => {
    const el = _importItems[idx];
    if (!el) return false;
    const conf = Number(el._confPct || 0);
    if (_importFilters.conf === 'lt40' && !(conf < 40)) return false;
    if (_importFilters.conf === '40to69' && !(conf >= 40 && conf < 70)) return false;
    if (_importFilters.conf === 'gte70' && !(conf >= 70)) return false;
    const type = importCurrentType(idx);
    if (_importFilters.type !== 'all' && _importFilters.type !== type) return false;
    if (_importFilters.geom === 'open' && el.closed) return false;
    if (_importFilters.geom === 'closed' && !el.closed) return false;
    return true;
  });
}

function syncImportSummary() {
  const summaryEl = $el('ed-import-summary');
  if (!summaryEl || !_importItems.length) return;
  const autoTotal = importAutoIndices().length;
  const autoPending = importAutoIndices().filter(idx => !_importApplied.has(idx)).length;
  const reviewTotal = importReviewIndices().length;
  const reviewPending = importReviewIndices().filter(idx => !_importApplied.has(idx)).length;
  summaryEl.textContent =
    `Авто (≥${IMPORT_AUTO_THRESHOLD}%): ${autoTotal - autoPending}/${autoTotal} применено · ` +
    `Review (<${IMPORT_AUTO_THRESHOLD}%): ${reviewPending}/${reviewTotal} осталось` +
    (_importSelected.size ? ` · Выделено: ${_importSelected.size}` : '');
}

function updateImportActionButtons() {
  const autoBtn = $el('ed-import-apply-auto');
  const reviewBtn = $el('ed-import-review');
  const applyReviewBtn = $el('ed-import-apply-review');
  const reviewControls = $el('ed-import-review-controls');
  const hasData = !!_importResult && _importItems.length > 0;

  [autoBtn, reviewBtn, applyReviewBtn].forEach((btn) => {
    if (!btn) return;
    btn.classList.toggle('ed-hidden', !hasData);
  });
  if (!hasData) {
    reviewControls?.classList.add('ed-hidden');
    return;
  }

  const autoPending = importAutoIndices().filter(idx => !_importApplied.has(idx)).length;
  const reviewPending = importReviewIndices().filter(idx => !_importApplied.has(idx)).length;
  if (autoBtn) {
    autoBtn.textContent = `Применить авто (${autoPending})`;
    autoBtn.disabled = autoPending === 0;
  }
  if (reviewBtn) {
    reviewBtn.textContent = `Проверить спорные (${reviewPending})`;
    reviewBtn.disabled = reviewPending === 0;
  }
  if (applyReviewBtn) {
    applyReviewBtn.disabled = reviewPending === 0;
    applyReviewBtn.classList.toggle('ed-hidden', !_importReviewMode);
  }
  reviewControls?.classList.toggle('ed-hidden', !_importReviewMode);
}

function renderImportRows() {
  const itemsEl = $el('ed-import-items');
  if (!itemsEl) return;
  const visible = importVisibleIndices();
  if (!visible.length) {
    itemsEl.innerHTML = '<div class="ed-history-empty">Нет элементов по текущим фильтрам.</div>';
    return;
  }
  itemsEl.innerHTML = visible.map((idx) => {
    const el = _importItems[idx];
    const type = importCurrentType(idx);
    const confPct = Number(el?._confPct || 0);
    const confColor = importConfColor(confPct);
    const lowClass = confPct < IMPORT_AUTO_THRESHOLD ? ' low' : '';
    const selectedClass = _importSelected.has(idx) ? ' selected' : '';
    const kindClass = importKindClass(type);
    const ptsCount = Array.isArray(el?.pts) ? el.pts.length : 0;
    return `<div class="ed-import-row${lowClass}${selectedClass}" data-import-idx="${idx}">
      <input type="checkbox" class="ed-import-check" data-import-check="${idx}" ${_importSelected.has(idx) ? 'checked' : ''}>
      <select data-import-idx="${idx}" class="ed-import-type">
        <option value="wall"      ${type === 'wall' ? 'selected' : ''}>Стена</option>
        <option value="boundary"  ${type === 'boundary' ? 'selected' : ''}>Граница</option>
        <option value="partition" ${type === 'partition' ? 'selected' : ''}>Перегородка</option>
        <option value="door"      ${type === 'door' ? 'selected' : ''}>Дверь</option>
        <option value="skip"      ${type === 'skip' ? 'selected' : ''}>Пропустить</option>
      </select>
      <div class="ed-import-meta">
        <span class="ed-import-kind ${kindClass}" data-import-kind="${idx}">${importTypeLabel(type)}</span>
        <span class="ed-import-pts">${ptsCount} pts · ${Math.round(el._len || 0)} u</span>
        <span class="ed-import-reason">${el._reason}</span>
      </div>
      <span class="ed-import-conf" style="color:${confColor}">${confPct}%</span>
      <div class="ed-conf-bar"><div class="ed-conf-fill" style="width:${confPct}%;background:${confColor}"></div></div>
    </div>`;
  }).join('');
}

function applyImportItems(indices) {
  if (!_importResult || !ld || !Array.isArray(indices) || !indices.length) {
    return { wall: 0, boundary: 0, partition: 0, door: 0, skip: 0, added: 0 };
  }

  const before = _importApplied.size;
  if (_importResult.vb && before === 0) ld.vb = _importResult.vb;
  if (!Array.isArray(ld.walls)) ld.walls = [];
  if (!Array.isArray(ld.boundaries)) ld.boundaries = [];
  if (!Array.isArray(ld.partitions)) ld.partitions = [];
  if (!Array.isArray(ld.doors)) ld.doors = [];

  const out = { wall: 0, boundary: 0, partition: 0, door: 0, skip: 0, added: 0 };
  indices.forEach((idx) => {
    if (_importApplied.has(idx)) return;
    const el = _importItems[idx];
    if (!el) return;
    const type = importCurrentType(idx);
    _importApplied.add(idx);
    if (type === 'skip') {
      out.skip += 1;
      _importAppliedCounts.skip += 1;
      return;
    }
    const item = {
      id: uid(),
      pts: el.pts,
      thick: el.thick || 4,
      closed: !!el.closed,
      conf: el.conf,
      label: el.label || null,
      locked: false,
    };
    if (type === 'boundary') {
      item.color = normalizeHexColor(el.color, DEFAULT_ZONE_COLOR);
      item.label_size = Number.isFinite(Number(el.label_size))
        ? Math.max(8, Math.min(120, Number(el.label_size)))
        : defaultZoneLabelSize();
    }
    if (type === 'wall')      { ld.walls.push(item); out.wall += 1; out.added += 1; _importAppliedCounts.wall += 1; }
    if (type === 'boundary')  { ld.boundaries.push(item); out.boundary += 1; out.added += 1; _importAppliedCounts.boundary += 1; }
    if (type === 'partition') { ld.partitions.push(item); out.partition += 1; out.added += 1; _importAppliedCounts.partition += 1; }
    if (type === 'door')      { ld.doors.push(item); out.door += 1; out.added += 1; _importAppliedCounts.door += 1; }
  });
  return out;
}

function renderImportPreview() {
  const layer = _layer('import-preview');
  if (!layer) return;
  layer.innerHTML = '';

  const overlay = $el('ed-import-overlay');
  if (!_importResult || !overlay || overlay.classList.contains('ed-hidden') || !_importItems.length) return;
  const sw = Math.max(1.05, ed.vb.w * 0.0011);

  for (let i = 0; i < _importItems.length; i += 1) {
    if (_importApplied.has(i)) continue;
    const el = _importItems[i];
    const pts = Array.isArray(el?.pts) ? el.pts : [];
    if (pts.length < 2) continue;

    const type = importCurrentType(i);
    const confPct = Number(el?._confPct || 0);
    const lowConf = confPct < IMPORT_AUTO_THRESHOLD;
    const tag = el.closed ? 'polygon' : 'polyline';
    const shape = _makePolyEl(tag, pts, !!el.closed);

    shape.setAttribute('pointer-events', 'none');
    shape.setAttribute('stroke-linecap', 'butt');
    shape.setAttribute('stroke-linejoin', 'round');

    if (type === 'wall') {
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', STRUCT_COLORS.wall);
      shape.setAttribute('stroke-width', String(sw * 1.35));
    } else if (type === 'boundary') {
      shape.setAttribute('fill', el.closed ? '#1d4ed8' : 'none');
      shape.setAttribute('fill-opacity', el.closed ? '0.08' : '0');
      shape.setAttribute('stroke', '#1d4ed8');
      shape.setAttribute('stroke-width', String(sw));
    } else if (type === 'partition') {
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', STRUCT_COLORS.partition);
      shape.setAttribute('stroke-width', String(sw * 0.95));
      shape.setAttribute('stroke-dasharray', '7 4');
    } else if (type === 'door') {
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', STRUCT_COLORS.door);
      shape.setAttribute('stroke-width', String(sw));
    } else {
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', '#94a3b8');
      shape.setAttribute('stroke-width', String(sw * 0.85));
      shape.setAttribute('stroke-dasharray', '4 4');
    }

    if (lowConf) {
      shape.setAttribute('opacity', type === 'skip' ? '0.72' : '0.88');
      if (type !== 'skip' && !shape.getAttribute('stroke-dasharray')) {
        shape.setAttribute('stroke-dasharray', '4 3');
      }
    } else {
      shape.setAttribute('opacity', type === 'skip' ? '0.56' : '0.95');
    }

    layer.appendChild(shape);
  }
}

function applyImportAuto(opts = {}) {
  const pending = importAutoIndices().filter(idx => !_importApplied.has(idx));
  if (!pending.length) {
    if (!opts.silent) edToast('Авто-элементы уже применены', 'info');
    return;
  }
  const before = _importApplied.size;
  const out = applyImportItems(pending);
  if (out.added > 0) {
    markDirty();
    if (before === 0) fitToScreen();
    renderAll();
  }
  if (!opts.silent) {
    edToast(`Авто применено: ${out.wall} стен, ${out.boundary} границ, ${out.partition} перегородок, ${out.door} дверей`, 'success');
  }
  syncImportSummary();
  updateImportActionButtons();
  renderImportRows();
  renderImportPreview();
}

function openImportReview() {
  _importReviewMode = true;
  _importSelected.clear();
  _importFilters.conf = 'all';
  const confSel = $el('ed-import-filter-conf');
  if (confSel) confSel.value = _importFilters.conf;
  syncImportSummary();
  updateImportActionButtons();
  renderImportRows();
  renderImportPreview();
}

function applyImportReview() {
  if (!_importResult || !ld) return;
  if (importAutoIndices().some(idx => !_importApplied.has(idx))) {
    applyImportAuto({ silent: true });
  }
  const pending = importReviewIndices().filter(idx => !_importApplied.has(idx));
  if (!pending.length) {
    closeImportModal();
    edToast('Спорных элементов не осталось', 'info');
    return;
  }
  const before = _importApplied.size;
  const out = applyImportItems(pending);
  if (out.added > 0) {
    markDirty();
    if (before === 0) fitToScreen();
    renderAll();
  }
  const totalApplied = _importAppliedCounts.wall + _importAppliedCounts.boundary + _importAppliedCounts.partition + _importAppliedCounts.door;
  closeImportModal();
  edToast(
    `Импорт завершён: применено ${totalApplied} элементов (${_importAppliedCounts.wall} стен, ${_importAppliedCounts.boundary} границ, ${_importAppliedCounts.partition} перегородок, ${_importAppliedCounts.door} дверей)`,
    'success',
  );
}

function setImportFilter(key, value) {
  if (!['conf', 'type', 'geom'].includes(key)) return;
  _importFilters[key] = value;
  _importSelected.clear();
  syncImportSummary();
  renderImportRows();
  renderImportPreview();
}

function selectVisibleImportRows() {
  importVisibleIndices().forEach(idx => _importSelected.add(idx));
  syncImportSummary();
  renderImportRows();
}

function clearImportSelection() {
  _importSelected.clear();
  syncImportSummary();
  renderImportRows();
}

function bulkAssignImportType(type) {
  const visible = importVisibleIndices().filter(idx => !_importApplied.has(idx));
  const target = (_importSelected.size ? [..._importSelected] : visible).filter(idx => !_importApplied.has(idx));
  if (!target.length) {
    edToast('Нет элементов для пакетного назначения', 'info');
    return;
  }
  target.forEach((idx) => { _importOverrides[idx] = type; });
  syncImportSummary();
  renderImportRows();
  renderImportPreview();
  edToast(`Назначено "${importTypeLabel(type)}" для ${target.length} элементов`, 'info');
}

function bindImportListEvents() {
  const itemsEl = $el('ed-import-items');
  if (!itemsEl || itemsEl._importEventsBound) return;
  itemsEl.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-import-idx]');
    if (sel) {
      const idx = Number(sel.dataset.importIdx);
      if (Number.isFinite(idx)) _importOverrides[idx] = sel.value;
      syncImportSummary();
      renderImportRows();
      renderImportPreview();
      return;
    }
    const chk = e.target.closest('input[data-import-check]');
    if (!chk) return;
    const idx = Number(chk.dataset.importCheck);
    if (!Number.isFinite(idx)) return;
    if (chk.checked) _importSelected.add(idx); else _importSelected.delete(idx);
    syncImportSummary();
    renderImportRows();
  });
  itemsEl.addEventListener('click', (e) => {
    if (e.target.closest('select') || e.target.closest('input[data-import-check]')) return;
    const row = e.target.closest('.ed-import-row[data-import-idx]');
    if (!row) return;
    const idx = Number(row.dataset.importIdx);
    if (!Number.isFinite(idx)) return;
    if (_importSelected.has(idx)) _importSelected.delete(idx); else _importSelected.add(idx);
    syncImportSummary();
    renderImportRows();
  });
  itemsEl._importEventsBound = true;
}

async function handleImportFile(file) {
  if (!ed.floorId) { edToast('Сначала выберите этаж', 'error'); return; }

  const name = String(file.name || '').toLowerCase();
  const isRaster =
    (file.type && file.type.startsWith('image/')) ||
    /\.(png|jpg|jpeg|webp)$/i.test(name);
  const isSvg = file.type === 'image/svg+xml' || name.endsWith('.svg');

  if (isRaster && !isSvg) {
    // Raster background — upload as plan image
    const rasterDims = await _readRasterDims(file).catch(() => null);
    const fd = new FormData(); fd.append('file', file);
    try {
      const resp = await fetch(`${API}/floors/${ed.floorId}/plan`, {
        method: 'POST',
        headers: ah(),
        body: fd,
      });
      if (!resp.ok) { const b = await resp.json().catch(()=>({})); edToast('Ошибка: '+(b.detail||resp.status),'error'); return; }
      const data = await resp.json();
      if (!ld) ld = { v:2, vb:[0,0,1000,1000], bg_url:null, bg_transform:null, walls:[], boundaries:[], partitions:[], doors:[], desks:[] };
      const canAdaptVb = !_layoutHasGeometry(ld);
      ld.bg_url = data.plan_url || null;
      if (canAdaptVb && rasterDims && rasterDims.w > 0 && rasterDims.h > 0) {
        ld.vb = [0, 0, rasterDims.w, rasterDims.h];
        ld.bg_transform = { x: 0, y: 0, w: rasterDims.w, h: rasterDims.h };
      } else {
        const vb = getCanvasRect();
        ld.bg_transform = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
      }
      markDirty();
      closeImportModal();
      if (canAdaptVb) fitToScreen();
      renderAll();
      edToast('Фон загружен', 'success');
    } catch (ex) { edToast('Ошибка: ' + ex.message, 'error'); }
    return;
  }

  // SVG — send to classifier
  try {
    const text = await file.text();
    const resp = await fetch(`${API}/floors/${ed.floorId}/layout/import`, {
      method: 'POST',
      headers: { ...ah(), 'Content-Type': 'image/svg+xml' },
      body: text,
    });
    if (!resp.ok) { const b = await resp.json().catch(()=>({})); edToast('SVG ошибка: '+(b.detail||resp.status),'error'); return; }
    _importResult = await resp.json();
    showImportResult(_importResult);
  } catch (ex) { edToast('Ошибка: ' + ex.message, 'error'); }
}

function showImportResult(res) {
  const statsEl = $el('ed-import-stats');
  const resultEl = $el('ed-import-result');

  if (statsEl) {
    statsEl.innerHTML = [
      { n: res.stats.walls,      l: 'Стены'       },
      { n: res.stats.boundaries, l: 'Границы'     },
      { n: res.stats.partitions, l: 'Перегородки' },
      { n: res.stats.doors || 0, l: 'Двери'       },
      { n: res.stats.uncertain,  l: 'Неопределено'},
      { n: res.stats.skipped,    l: 'Пропущено'   },
      { n: res.stats.total_elements, l: 'Всего'   },
    ].map(s =>
      `<div class="ed-stat-card"><span class="num">${s.n}</span><span class="lbl">${s.l}</span></div>`
    ).join('');
  }

  _importItems = buildImportItems(res);
  _importOverrides = {};
  _importItems.forEach((el) => {
    _importOverrides[el._idx] = importDefaultType(el);
  });
  _importApplied = new Set();
  _importSelected = new Set();
  _importReviewMode = false;
  _importFilters = { conf: 'all', type: 'all', geom: 'all' };
  _importAppliedCounts = { wall: 0, boundary: 0, partition: 0, door: 0, skip: 0 };

  if (resultEl) resultEl.classList.remove('ed-hidden');
  const confSel = $el('ed-import-filter-conf'); if (confSel) confSel.value = _importFilters.conf;
  const typeSel = $el('ed-import-filter-type'); if (typeSel) typeSel.value = _importFilters.type;
  const geomSel = $el('ed-import-filter-geom'); if (geomSel) geomSel.value = _importFilters.geom;
  bindImportListEvents();
  syncImportSummary();
  updateImportActionButtons();
  renderImportRows();
  renderImportPreview();
}

function closeImportModal() {
  $el('ed-import-overlay')?.classList.add('ed-hidden');
  resetImportState();
  const resultEl = $el('ed-import-result');
  if (resultEl) resultEl.classList.add('ed-hidden');
  ['ed-import-review', 'ed-import-apply-auto', 'ed-import-apply-review'].forEach((id) => {
    const btn = $el(id);
    if (btn) btn.classList.add('ed-hidden');
  });
  $el('ed-import-review-controls')?.classList.add('ed-hidden');
  const itemsEl = $el('ed-import-items');
  if (itemsEl) itemsEl.innerHTML = '';
  const summaryEl = $el('ed-import-summary');
  if (summaryEl) summaryEl.textContent = '';
  renderImportPreview();
}

/* ── History ────────────────────────────────────────────────────────────────── */
let _historyRevisions = [];

function closeHistoryModal() {
  $el('ed-history-overlay')?.classList.add('ed-hidden');
}

function _histStatusLabel(status) {
  if (status === 'published') return 'Опубликовано';
  if (status === 'draft') return 'Черновик';
  return 'Архив';
}

function _fmtHistDate(dt) {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleString('ru');
  } catch {
    return dt;
  }
}

function renderHistoryList() {
  const list = $el('ed-history-list');
  if (!list) return;

  if (!_historyRevisions.length) {
    list.innerHTML = '<div class="ed-history-empty">История пока пуста.</div>';
    return;
  }

  list.innerHTML = _historyRevisions.map(r => {
    const chips = [
      `<span class="ed-hist-chip ${r.status}">${_histStatusLabel(r.status)}</span>`,
      r.is_current_published ? '<span class="ed-hist-chip published">Текущая публикация</span>' : '',
      r.is_current_draft ? '<span class="ed-hist-chip draft">Текущий черновик</span>' : '',
    ].filter(Boolean).join('');

    const actor = r.created_by_username ? ` · ${r.created_by_username}` : '';
    return `<div class="ed-hist-item">
      <div class="ed-hist-top">
        <span class="ed-hist-action">Версия ${r.version} · rev ${r.revision_id}</span>
        <span class="ed-hist-meta">${_fmtHistDate(r.updated_at || r.created_at)}${actor}</span>
      </div>
      <div class="ed-hist-chips">${chips}</div>
      <div class="ed-hist-actions">
        <button class="ed-btn ed-btn-primary" data-history-restore="${r.revision_id}">Переключить на эту версию</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('button[data-history-restore]').forEach(btn => {
    btn.addEventListener('click', () => {
      const revisionId = parseInt(btn.dataset.historyRestore, 10);
      if (Number.isFinite(revisionId)) edRestoreRevision(revisionId);
    });
  });
}

async function edRestoreRevision(revisionId) {
  if (!ed.floorId || !revisionId) return;
  const rev = _historyRevisions.find(x => x.revision_id === revisionId);
  const revLabel = rev ? `версию ${rev.version}` : `rev ${revisionId}`;

  if (!confirm(`Переключить редактор на ${revLabel}? Текущий черновик будет перезаписан.`)) return;

  try {
    const resp = await fetch(`${API}/floors/${ed.floorId}/layout/revisions/${revisionId}/restore`, {
      method: 'POST',
      headers: ah(),
    });
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      edToast('Ошибка восстановления: ' + (b.detail || resp.status), 'error');
      return;
    }
    const data = await resp.json();
    ld = ensureLayoutArrays(data.layout);
    ed.status = data.status;
    ed.version = data.version;
    ed.dirty = false;
    deselect();
    updateEditorUI();
    fitToScreen();
    renderAll();
    closeHistoryModal();
    edToast(`Переключено на ${revLabel}`, 'success');
  } catch (ex) {
    edToast('Ошибка: ' + ex.message, 'error');
  }
}

async function edShowHistory() {
  if (!ed.floorId) return;
  $el('ed-history-overlay')?.classList.remove('ed-hidden');
  const list = $el('ed-history-list');
  if (list) list.innerHTML = '<div class="ed-history-empty">Загрузка истории…</div>';

  try {
    const resp = await fetch(`${API}/floors/${ed.floorId}/layout/revisions?limit=100`, { headers: ah() });
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      edToast('Ошибка истории: ' + (b.detail || resp.status), 'error');
      closeHistoryModal();
      return;
    }
    _historyRevisions = await resp.json();
    renderHistoryList();
  } catch (ex) {
    closeHistoryModal();
    edToast('Ошибка: ' + ex.message, 'error');
  }
}

/* ── UI update ──────────────────────────────────────────────────────────────── */
function updateEditorUI() {
  const badge   = $el('ed-status-badge');
  const saveBtn = $el('ed-save-btn');
  const pubBtn  = $el('ed-publish-btn');
  const discBtn = $el('ed-discard-btn');
  const bgAdjustBtn = $el('ed-bg-adjust-btn');
  const clearBgBtn = $el('ed-clear-bg-btn');
  const syncDesksBtn = $el('ed-sync-desks-btn');

  if (badge) {
    badge.className = 'ed-status-badge';
    if (ed.status === 'draft') {
      badge.textContent = 'ЧЕРНОВИК';
      badge.classList.add('draft');
    } else if (ed.status === 'published') {
      badge.textContent = 'ОПУБЛИКОВАНО';
      badge.classList.add('published');
    } else {
      badge.textContent = 'НЕТ КАРТЫ';
    }
  }

  const hasFloor = !!ed.floorId;
  if (saveBtn) saveBtn.disabled = !hasFloor;
  if (pubBtn)  pubBtn.disabled  = !hasFloor;
  if (discBtn) discBtn.disabled = !hasFloor || ed.status !== 'draft';
  if (bgAdjustBtn) bgAdjustBtn.disabled = !hasFloor || !ld?.bg_url;
  if (clearBgBtn) clearBgBtn.disabled = !hasFloor || !ld?.bg_url;
  if (syncDesksBtn) syncDesksBtn.disabled = !hasFloor;
  bgAdjustBtn?.classList.toggle('active', !!ed.bgAdjust.active);

  if ((!hasFloor || !ld?.bg_url) && ed.bgAdjust.active) {
    setBackgroundAdjustMode(false);
  }

  if (ed.dirty && saveBtn) {
    saveBtn.textContent = 'Сохранить *';
  } else if (saveBtn) {
    saveBtn.textContent = 'Сохранить';
  }
}

function markDirty() {
  ed.dirty = true;
  updateEditorUI();
}

/* ── Toast ──────────────────────────────────────────────────────────────────── */
function edToast(text, type) {
  if (typeof showToast === 'function') { showToast(text, type); return; }
  console.log('[editor]', type, text);
}

/* ── Keyboard shortcuts ─────────────────────────────────────────────────────── */
function initEditorKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Alt') {
      if (!ed.altSnapOff) {
        ed.altSnapOff = true;
        if (isDeskBlockMode() && ed.deskTool.preview) {
          rebuildDeskBlockPreview(ed.deskTool.preview.current || ed.deskTool.preview.anchor);
        }
        updateStatusBar();
      }
      return;
    }
    if (e.key === 'Shift') {
      if (!ed.shiftDown) ed.shiftDown = true;
      if (!isDrawMode(ed.mode) && !ed.shiftFine) {
        ed.shiftFine = true;
        if (isDeskBlockMode() && ed.deskTool.preview) {
          rebuildDeskBlockPreview(ed.deskTool.preview.current || ed.deskTool.preview.anchor);
        }
      }
      updateStatusBar();
      return;
    }

    // Don't steal input focus
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    // Only handle when editor tab is active
    const tab = document.getElementById('tab-editor');
    if (!tab || tab.classList.contains('hidden')) return;

    if (e.code === 'Space') { e.preventDefault(); ed.spaceDown = true; return; }

    switch (e.key) {
      case 'v': case 'V': setMode('select');    break;
      case 'h': case 'H': setMode('pan');       break;
      case 'w': case 'W': setMode('wall');      break;
      case 'b': case 'B': setMode('boundary');  break;
      case 'p': case 'P': setMode('partition'); break;
      case 'o': case 'O': setMode('door');      break;
      case 'd': case 'D': setMode('desk');      break;
      case 'f': case 'F': fitToScreen();         break;
      case 'q': case 'Q':
        if (rotateDeskSelectionBy(e.shiftKey ? -1 : -5)) e.preventDefault();
        break;
      case 'e': case 'E':
        if (rotateDeskSelectionBy(e.shiftKey ? 1 : 5)) e.preventDefault();
        break;
      case 'g': case 'G':
        ed.snapGrid = !ed.snapGrid;
        document.getElementById('ed-grid-rect')?.style.setProperty('display', ed.snapGrid ? '' : 'none');
        edToast('Сетка: ' + (ed.snapGrid ? 'вкл' : 'выкл'), 'info');
        if (isDeskBlockMode() && ed.deskTool.preview) {
          rebuildDeskBlockPreview(ed.deskTool.preview.current || ed.deskTool.preview.anchor);
        }
        updateStatusBar();
        break;
      case 'Escape':
        if (!$el('ed-import-overlay')?.classList.contains('ed-hidden')) {
          closeImportModal();
          break;
        }
        if (!$el('ed-history-overlay')?.classList.contains('ed-hidden')) {
          closeHistoryModal();
          break;
        }
        if (ed.bgAdjust.active) {
          setBackgroundAdjustMode(false);
          break;
        }
        if (cancelDeskBlockPreview()) break;
        if (ed.drawing) { ed.drawing = null; const l = _layer('draw'); if (l) l.innerHTML = ''; }
        else if (ed.marquee) { ed.marquee = null; renderSelection(); }
        else deselect();
        break;
      case 'Enter':
        if (commitDeskBlockPreview()) break;
        if (ed.drawing) finishDrawing(ed.mode === 'boundary');
        break;
      case 'Delete': case 'Backspace':
        if (hasMultiDeskSelection() && hasMultiStructSelection()) {
          deleteSelectedMultiObjects();
          break;
        }
        if (hasMultiDeskSelection()) {
          deleteSelectedDesks();
          break;
        }
        if (hasMultiStructSelection()) {
          deleteSelectedStructures();
          break;
        }
        if (ed.selType === 'desk') {
          deleteSelectedDesks();
          break;
        }
        if (isStructType(ed.selType)) {
          deleteStructEl(ed.selType, ed.selId);
        }
        break;
    }
  });

  document.addEventListener('keyup', e => {
    if (e.key === 'Alt') {
      ed.altSnapOff = false;
      if (isDeskBlockMode() && ed.deskTool.preview) {
        rebuildDeskBlockPreview(ed.deskTool.preview.current || ed.deskTool.preview.anchor);
      }
      updateStatusBar();
      return;
    }
    if (e.key === 'Shift') {
      ed.shiftDown = false;
      ed.shiftFine = false;
      if (isDeskBlockMode() && ed.deskTool.preview) {
        rebuildDeskBlockPreview(ed.deskTool.preview.current || ed.deskTool.preview.anchor);
      }
      updateStatusBar();
      return;
    }
    if (e.code === 'Space') {
      ed.spaceDown = false;
      if (ed.spacePanning) { ed.spacePanning = false; ed.spacePanStart = null; }
    }
  });

  window.addEventListener('blur', () => {
    if (!ed.altSnapOff && !ed.shiftFine && !ed.shiftDown) return;
    ed.altSnapOff = false;
    ed.shiftFine = false;
    ed.shiftDown = false;
    if (isDeskBlockMode() && ed.deskTool.preview) {
      rebuildDeskBlockPreview(ed.deskTool.preview.current || ed.deskTool.preview.anchor);
    }
    updateStatusBar();
  });
}

/* ── Collapse panels ────────────────────────────────────────────────────────── */
function initCollapsePanels() {
  const body = $el('ed-body');
  const left = $el('ed-left');
  const right = $el('ed-right');
  const leftBtn = $el('ed-left-collapse');
  const rightBtn = $el('ed-right-collapse');
  const leftExpand = $el('ed-left-expand');
  const rightExpand = $el('ed-right-expand');

  const state = {
    left: localStorage.getItem(PANEL_LEFT_KEY) === '1',
    right: localStorage.getItem(PANEL_RIGHT_KEY) === '1',
  };

  const apply = (persist) => {
    left?.classList.toggle('collapsed', state.left);
    right?.classList.toggle('collapsed', state.right);
    body?.classList.toggle('left-collapsed', state.left);
    body?.classList.toggle('right-collapsed', state.right);

    leftExpand?.classList.toggle('ed-hidden', !state.left);
    rightExpand?.classList.toggle('ed-hidden', !state.right);

    if (leftBtn) {
      leftBtn.textContent = '◀';
      leftBtn.setAttribute('aria-expanded', String(!state.left));
      leftBtn.title = 'Скрыть инвентарь';
    }
    if (rightBtn) {
      rightBtn.textContent = '▶';
      rightBtn.setAttribute('aria-expanded', String(!state.right));
      rightBtn.title = 'Скрыть свойства';
    }
    if (leftExpand) leftExpand.setAttribute('aria-expanded', String(!state.left));
    if (rightExpand) rightExpand.setAttribute('aria-expanded', String(!state.right));

    if (persist !== false) {
      localStorage.setItem(PANEL_LEFT_KEY, state.left ? '1' : '0');
      localStorage.setItem(PANEL_RIGHT_KEY, state.right ? '1' : '0');
    }
  };

  leftBtn?.addEventListener('click', () => {
    state.left = true;
    apply(true);
  });
  rightBtn?.addEventListener('click', () => {
    state.right = true;
    apply(true);
  });
  leftExpand?.addEventListener('click', () => {
    state.left = false;
    apply(true);
  });
  rightExpand?.addEventListener('click', () => {
    state.right = false;
    apply(true);
  });

  window.addEventListener('resize', () => apply(false));
  document.addEventListener('admin:tab-change', e => {
    if (e?.detail?.tab === 'editor') apply(false);
  });

  apply(false);
}

/* ── Floor select population ────────────────────────────────────────────────── */
function populateEdFloorSelect(floors, offices) {
  const sel = $el('ed-floor-select');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Выберите этаж…</option>';
  for (const f of (floors || [])) {
    const o = (offices || []).find(x => x.id === f.office_id);
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name + (o ? ' — ' + o.name : '');
    sel.appendChild(opt);
  }
  if (cur) sel.value = cur;
}

function initDeskBulkControls() {
  const apply = () => {
    const nextPlaceMode = $el('ed-desk-place-mode')?.value === 'block' ? 'block' : 'single';
    const wasBlock = ed.deskTool.placeMode === 'block';
    const baseSize = baseDeskSize();
    const maxW = Math.max(120, baseSize.w * 8);
    const maxH = Math.max(90, baseSize.h * 8);

    ed.deskTool.placeMode = nextPlaceMode;
    ed.deskTool.pattern = $el('ed-desk-block-pattern')?.value === 'double' ? 'double' : 'rows';
    ed.deskTool.axis = $el('ed-desk-block-axis')?.value === 'vertical' ? 'vertical' : 'horizontal';
    ed.deskTool.deskW = clampNum($el('ed-desk-width')?.value, 4, maxW, ed.deskTool.deskW ?? baseSize.w);
    ed.deskTool.deskH = clampNum($el('ed-desk-height')?.value, 4, maxH, ed.deskTool.deskH ?? baseSize.h);
    ed.deskTool.seatsPerRow = clampInt($el('ed-desk-seats-per-row')?.value, 1, 100, ed.deskTool.seatsPerRow || 6);
    ed.deskTool.rowCount = clampInt($el('ed-desk-row-count')?.value, 1, 50, ed.deskTool.rowCount || 2);
    ed.deskTool.pairCount = clampInt($el('ed-desk-pair-count')?.value, 1, 25, ed.deskTool.pairCount || 1);

    if (wasBlock && ed.deskTool.placeMode !== 'block') {
      cancelDeskBlockPreview();
    } else if (ed.deskTool.placeMode === 'block' && ed.deskTool.preview) {
      rebuildDeskBlockPreview(ed.deskTool.preview.current || ed.deskTool.preview.anchor);
    }

    syncDeskBulkControls();
    updateStatusBar();
    renderDrawing();
  };

  ['ed-desk-place-mode', 'ed-desk-block-pattern', 'ed-desk-block-axis', 'ed-desk-width', 'ed-desk-height', 'ed-desk-seats-per-row', 'ed-desk-row-count', 'ed-desk-pair-count']
    .forEach(id => {
      $el(id)?.addEventListener('change', apply);
      $el(id)?.addEventListener('input', apply);
    });

  syncDeskBulkControls();
}

/* ── Main init ──────────────────────────────────────────────────────────────── */
function initFloorEditor() {
  // Floor select
  $el('ed-floor-select')?.addEventListener('change', function() {
    edLoadFloor(this.value || null);
  });

  // Mode buttons
  document.querySelectorAll('.ed-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Toolbar actions
  $el('ed-lock-btn')?.addEventListener('click', () => {
    if (ed.locked) {
      if (isLockOwnedByMe()) releaseLock();
      return;
    }
    acquireLock();
  });
  $el('ed-fit-btn')?.addEventListener('click', fitToScreen);
  $el('ed-sync-bg-btn')?.addEventListener('click', syncCanvasToBackground);
  $el('ed-bg-adjust-btn')?.addEventListener('click', toggleBackgroundAdjustMode);
  $el('ed-clear-bg-btn')?.addEventListener('click', clearBackground);
  $el('ed-sync-desks-btn')?.addEventListener('click', syncDesksFromLayout);
  $el('ed-grid-btn')?.addEventListener('click', () => {
    ed.snapGrid = !ed.snapGrid;
    document.getElementById('ed-grid-rect')?.style.setProperty('display', ed.snapGrid ? '' : 'none');
    $el('ed-grid-btn')?.classList.toggle('active', ed.snapGrid);
    if (isDeskBlockMode() && ed.deskTool.preview) {
      rebuildDeskBlockPreview(ed.deskTool.preview.current || ed.deskTool.preview.anchor);
    }
    updateStatusBar();
  });
  $el('ed-save-btn')?.addEventListener('click', edSaveDraft);
  $el('ed-publish-btn')?.addEventListener('click', edPublish);
  $el('ed-discard-btn')?.addEventListener('click', edDiscard);
  $el('ed-import-btn')?.addEventListener('click', () => $el('ed-import-overlay')?.classList.remove('ed-hidden'));
  $el('ed-history-btn')?.addEventListener('click', edShowHistory);

  // Zoom buttons
  $el('ed-zoom-in')?.addEventListener('click',    () => zoomBy(0.9));
  $el('ed-zoom-out')?.addEventListener('click',   () => zoomBy(1 / 0.9));
  $el('ed-zoom-reset')?.addEventListener('click', fitToScreen);

  // SVG canvas
  const svg = _svg();
  if (svg) {
    svg.addEventListener('pointerdown', onSvgPointerDown);
    svg.addEventListener('pointermove', onSvgPointerMove);
    svg.addEventListener('pointerup',   onSvgPointerUp);
    svg.addEventListener('click',       onSvgClick);
    svg.addEventListener('dblclick',    onSvgDblClick);
    svg.addEventListener('wheel',       onWheelZoom, { passive: false });
  }

  // Object search
  $el('ed-obj-search')?.addEventListener('input', renderObjectList);

  // Import modal
  $el('ed-import-close')?.addEventListener('click',  closeImportModal);
  $el('ed-import-cancel')?.addEventListener('click', closeImportModal);
  $el('ed-import-apply-auto')?.addEventListener('click', applyImportAuto);
  $el('ed-import-review')?.addEventListener('click', openImportReview);
  $el('ed-import-apply-review')?.addEventListener('click', applyImportReview);
  $el('ed-import-filter-conf')?.addEventListener('change', (e) => setImportFilter('conf', e.target.value));
  $el('ed-import-filter-type')?.addEventListener('change', (e) => setImportFilter('type', e.target.value));
  $el('ed-import-filter-geom')?.addEventListener('change', (e) => setImportFilter('geom', e.target.value));
  $el('ed-import-select-visible')?.addEventListener('click', selectVisibleImportRows);
  $el('ed-import-clear-selection')?.addEventListener('click', clearImportSelection);
  $el('ed-import-bulk-wall')?.addEventListener('click', () => bulkAssignImportType('wall'));
  $el('ed-import-bulk-boundary')?.addEventListener('click', () => bulkAssignImportType('boundary'));
  $el('ed-import-bulk-partition')?.addEventListener('click', () => bulkAssignImportType('partition'));
  $el('ed-import-bulk-door')?.addEventListener('click', () => bulkAssignImportType('door'));
  $el('ed-import-bulk-skip')?.addEventListener('click', () => bulkAssignImportType('skip'));
  $el('ed-import-browse')?.addEventListener('click', () => $el('ed-import-file')?.click());
  $el('ed-import-file')?.addEventListener('change', function() {
    if (this.files[0]) { handleImportFile(this.files[0]); this.value = ''; }
  });

  const dropZone = $el('ed-import-drop');
  if (dropZone) {
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (file) handleImportFile(file);
    });
  }

  // History modal
  $el('ed-history-close')?.addEventListener('click', closeHistoryModal);
  $el('ed-history-cancel')?.addEventListener('click', closeHistoryModal);
  $el('ed-history-overlay')?.addEventListener('click', e => {
    if (e.target?.id === 'ed-history-overlay') closeHistoryModal();
  });

  // Warn user before closing tab if draft changes are not saved.
  window.addEventListener('beforeunload', (e) => {
    if (!ed?.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
  // Release lock only when page is actually being hidden/unloaded.
  window.addEventListener('pagehide', releaseLockOnExit);

  initPropsListeners();
  initDeskBulkControls();
  initEditorKeyboard();
  initCollapsePanels();
  updateEditorUI();
  updateStatusBar();
  updateEditorKpis();
  updateLockUI();
}
