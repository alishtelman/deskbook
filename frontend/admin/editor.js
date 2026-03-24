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
  door:      '#c2410c',   // orange-700 — visually distinct from gray walls/partitions
};
const DEFAULT_ZONE_COLOR = STRUCT_COLORS.boundary;
const STRUCT_OPACITY = { wall: 1, boundary: 0.15, partition: 0.7, door: 1 };
const MAX_LAYOUT_DESKS = 2000;
const PX_CLOSE_THRESHOLD = 14;
const MARQUEE_MIN_PX = 4;
const OBJECT_HIT_PX = 14;
const DEFAULT_ZONE_LABEL_SIZE = 18;
const DEFAULT_ZONE_OPACITY    = 0.15;
const DEFAULT_ZONE_TYPE       = 'open_space';
const ZONE_TYPES = ['open_space','meeting_room','kitchen','reception','corridor','custom'];
const ZONE_TYPE_LABELS = {
  open_space:   'Open Space',
  meeting_room: 'Переговорная',
  kitchen:      'Кухня',
  reception:    'Ресепшн',
  corridor:     'Коридор',
  custom:       'Произвольная',
};
const DRAW_ANGLE_STEP_DEG = 45;
const DOOR_WIDTH = 50;          // SVG units for door segment length
const ENDPOINT_SNAP_PX = 12;   // screen px radius for endpoint snap
const DOOR_SNAP_PX = 22;       // screen px radius to snap click onto wall for door
const OBJECT_SNAP_PX = 9;      // screen px threshold for snap-to-objects/walls
const PANEL_LEFT_KEY = 'editor_left_collapsed';
const PANEL_RIGHT_KEY = 'editor_right_collapsed';

const DESK_COLORS = {
  flex:     { fill: '#dbeafe', stroke: '#2563eb' },
  fixed:    { fill: '#fef3c7', stroke: '#d97706' },
  disabled: { fill: '#f1f5f9', stroke: '#94a3b8' },
  occupied: { fill: '#fee2e2', stroke: '#dc2626' },
};

const MODE_HINTS = {
  select:    'Клик — выбор · Shift+клик/рамка — мультивыбор · тащи — перемещение · круглая ручка — поворот · Q/E — шаг поворота · Пробел+тащи — рука',
  pan:       'Тащи для панорамирования · колесо — зум',
  // Line tools — idle state (no drawing in progress)
  wall:      'Кликните, чтобы начать стену · Shift — угол 45° · Esc — выйти',
  partition: 'Кликните, чтобы начать перегородку · Shift — угол 45° · Esc — выйти',
  // Area tool — idle state (no drag in progress)
  boundary:  'Тащите мышью, чтобы нарисовать прямоугольную зону · Esc — выйти',
  // Object tools — handled dynamically in updateStatusBar
  door:      'Наведите на стену и кликните · R — сменить направление · Esc — выйти',
  desk:      'Кликните, чтобы поставить стол · для блока выберите «Блок» в панели ниже · Esc — выйти',
};
const STRUCT_TYPES = ['wall', 'boundary', 'partition', 'door'];
// Interaction model classification
const LINE_TOOLS  = ['wall', 'partition'];   // click-click segment drawing, Enter to finish
const AREA_TOOLS  = ['boundary'];            // drag-to-rectangle
const OBJECT_TOOLS = ['door', 'desk'];       // hover preview + click to place, no accumulation

/* ── State ──────────────────────────────────────────────────────────────────── */
let ld = null;        // LayoutDocument (canonical)
let ed = resetEd();

/* ── Undo / Redo ─────────────────────────────────────────────────────────────
 *  Snapshot-based: we clone the mutable arrays of ld before any mutation.
 *  histSnapshot()  — instant actions (create, delete, property change, etc.)
 *  histPushSnap()  — drag-end: caller captures pre-drag state and pushes only
 *                    if the drag actually moved something.
 * ────────────────────────────────────────────────────────────────────────── */
const HIST_MAX = 60;
let _histUndo = [];
let _histRedo = [];

function _snapLd() {
  if (!ld) return null;
  return JSON.parse(JSON.stringify({
    desks:       ld.desks,
    walls:       ld.walls,
    boundaries:  ld.boundaries,
    partitions:  ld.partitions,
    doors:       ld.doors,
  }));
}

function histPushSnap(snap) {
  if (!snap) return;
  _histUndo.push(snap);
  if (_histUndo.length > HIST_MAX) _histUndo.shift();
  _histRedo = [];
  _updateHistBtns();
}

function histSnapshot() {
  histPushSnap(_snapLd());
}

function histUndo() {
  if (!_histUndo.length) return;
  _histRedo.push(_snapLd());
  if (_histRedo.length > HIST_MAX) _histRedo.shift();
  _histApply(_histUndo.pop());
}

function histRedo() {
  if (!_histRedo.length) return;
  _histUndo.push(_snapLd());
  if (_histUndo.length > HIST_MAX) _histUndo.shift();
  _histApply(_histRedo.pop());
}

function _histApply(snap) {
  if (!ld || !snap) return;
  ld.desks       = snap.desks;
  ld.walls       = snap.walls;
  ld.boundaries  = snap.boundaries;
  ld.partitions  = snap.partitions;
  ld.doors       = snap.doors;
  // Clear selection — the previously-selected object may no longer exist
  ed.selType = null; ed.selId = null;
  ed.multiDeskIds = []; ed.multiStructKeys = [];
  markDirty();
  renderAll();
  renderObjectList();
  showPropsFor(null, null);
  _updateHistBtns();
}

function histReset() {
  _histUndo = [];
  _histRedo = [];
  _updateHistBtns();
}

function _updateHistBtns() {
  const u = document.getElementById('ed-undo-btn');
  const r = document.getElementById('ed-redo-btn');
  if (u) { u.disabled = _histUndo.length === 0; u.title = `Отменить (Ctrl+Z)${_histUndo.length ? ' · ' + _histUndo.length : ''}`; }
  if (r) { r.disabled = _histRedo.length === 0; r.title = `Вернуть (Ctrl+Shift+Z)${_histRedo.length ? ' · ' + _histRedo.length : ''}`; }
}
/* ─────────────────────────────────────────────────────────────────────────── */

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
    snapToObjects: true,   // snap to other desks' edges/centers
    snapToWalls: true,     // snap to wall/partition vertices
    snapGuides: [],        // active guide lines [{type:'v'|'h', pos}]
    altSnapOff: false,
    shiftFine: false,
    shiftDown: false,
    deskTool: {
      placeMode: 'single',   // single | row | block
      axis: 'horizontal',    // horizontal | vertical
      deskW: null,
      deskH: null,
      colCount: 6,           // desks in primary direction
      rowCount: 2,           // rows perpendicular (block mode only)
      deskGap: null,         // gap between desks in px (null = auto: w*0.22)
      rowGap: null,          // gap between rows in px (null = auto: h*0.8)
      groupLabel: '',        // optional label for batch insert
      preview: null,         // float preview { anchor, desks, conflicts, overflow, _cursorPt }
      // Autonumbering
      numScheme: 'D-N',   // 'D-N' | 'A-N' | 'N' | 'Rm-N' | 'custom'
      numPrefix: '',      // custom prefix (only when numScheme === 'custom')
      numStart:  null,    // null = auto-detect next available, or integer
    },

    // Drawing (wall/partition)
    drawing: null,       // { type, pts: [[x,y],...], rubberPt: [x,y] }

    // Boundary drag-to-rect
    boundaryDrag: null,  // { pointerId, start:[x,y], current:[x,y] }

    // Door tool
    doorFlip: false,
    doorPreview: null,   // { proj:[x,y], angle:number }

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
  // Only line tools use point-accumulation drawing; area/object tools excluded
  return LINE_TOOLS.includes(mode);
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

  // Endpoint snap takes priority over grid/angle snap
  if (!opts.skipEndpointSnap) {
    const ep = snapToEndpoints(ptr);
    if (ep) return ep;
  }

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

/* ── Endpoint snap (wall/partition drawing) ─────────────────────────────────── */
function snapToEndpoints(ptr) {
  if (!ld) return null;
  const threshold = worldUnitsForScreenPx(ENDPOINT_SNAP_PX);
  let best = null, bestDist = threshold;
  const check = (arr) => {
    for (const el of (arr || [])) {
      for (const ep of (el.pts || [])) {
        const d = Math.hypot(ptr.x - ep[0], ptr.y - ep[1]);
        if (d < bestDist) { bestDist = d; best = ep; }
      }
    }
  };
  check(ld.walls);
  check(ld.partitions);
  return best; // [x, y] or null
}

/* ── Smart snap (objects + walls) ───────────────────────────────────────────── */
/**
 * Computes snapped position for a rect being dragged, checking:
 *  1. Object snap: aligns rect edges/center to other desks' edges/centers
 *  2. Wall snap: aligns rect edges to wall/partition vertex coordinates
 *  3. Grid snap: fallback if object snap doesn't fire
 * Returns { x, y, guides: [{type:'v'|'h', pos}] }
 */
function computeSnapForRect(rawX, rawY, w, h, excludeIds) {
  const guides = [];
  if (ed.altSnapOff || (!ed.snapToObjects && !ed.snapToWalls)) {
    return { x: snapV(rawX), y: snapV(rawY), guides };
  }

  const threshold = worldUnitsForScreenPx(OBJECT_SNAP_PX);
  const excludeSet = new Set(excludeIds || []);

  // Candidate snap values: left / center-x / right of moving rect
  const testX = [rawX, rawX + w / 2, rawX + w];
  const testY = [rawY, rawY + h / 2, rawY + h];

  let bestX = null; // { delta, snapTo }
  let bestY = null;

  function tryX(tgt) {
    for (const tx of testX) {
      const d = Math.abs(tx - tgt);
      if (d < threshold && (!bestX || d < Math.abs(bestX.delta))) {
        bestX = { delta: tgt - tx, snapTo: tgt };
      }
    }
  }
  function tryY(tgt) {
    for (const ty of testY) {
      const d = Math.abs(ty - tgt);
      if (d < threshold && (!bestY || d < Math.abs(bestY.delta))) {
        bestY = { delta: tgt - ty, snapTo: tgt };
      }
    }
  }

  if (ed.snapToObjects) {
    for (const d of (ld?.desks || [])) {
      if (excludeSet.has(d.id)) continue;
      tryX(d.x); tryX(d.x + d.w / 2); tryX(d.x + d.w);
      tryY(d.y); tryY(d.y + d.h / 2); tryY(d.y + d.h);
    }
    for (const b of (ld?.boundaries || [])) {
      const bounds = pointsBounds(b.pts);
      if (!bounds) continue;
      tryX(bounds.minX); tryX(bounds.cx); tryX(bounds.maxX);
      tryY(bounds.minY); tryY(bounds.cy); tryY(bounds.maxY);
    }
  }

  if (ed.snapToWalls) {
    for (const el of [...(ld?.walls || []), ...(ld?.partitions || [])]) {
      for (const pt of el.pts || []) {
        tryX(pt[0]); tryY(pt[1]);
      }
    }
  }

  // Compare with grid snap, take whichever is tighter per axis
  const gridX = snapV(rawX);
  const gridY = snapV(rawY);
  const gridDx = Math.abs(gridX - rawX);
  const gridDy = Math.abs(gridY - rawY);

  let finalX, finalY;
  if (bestX !== null && Math.abs(bestX.delta) <= gridDx) {
    finalX = rawX + bestX.delta;
    guides.push({ type: 'v', pos: bestX.snapTo });
  } else {
    finalX = gridX;
  }
  if (bestY !== null && Math.abs(bestY.delta) <= gridDy) {
    finalY = rawY + bestY.delta;
    guides.push({ type: 'h', pos: bestY.snapTo });
  } else {
    finalY = gridY;
  }
  return { x: finalX, y: finalY, guides };
}

/* ── Door helpers ────────────────────────────────────────────────────────────── */
function findNearestWallSegment(pt) {
  if (!ld) return null;
  const threshold = worldUnitsForScreenPx(DOOR_SNAP_PX);
  let best = null, bestDist = threshold;
  const check = (arr, type) => {
    for (const el of (arr || [])) {
      const pts = el.pts || [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const ddx = bx - ax, ddy = by - ay;
        const len2 = ddx * ddx + ddy * ddy;
        if (len2 < 1e-9) continue;
        let t = ((pt.x - ax) * ddx + (pt.y - ay) * ddy) / len2;
        t = Math.max(0, Math.min(1, t));
        const px = ax + t * ddx, py = ay + t * ddy;
        const d = Math.hypot(pt.x - px, pt.y - py);
        if (d < bestDist) {
          bestDist = d;
          best = { el, type, segIdx: i, proj: [px, py], angle: Math.atan2(ddy, ddx) };
        }
      }
    }
  };
  check(ld.walls, 'wall');
  check(ld.partitions, 'partition');
  return best;
}

function doorPtsFromWall(proj, wallAngle, flip) {
  const half = DOOR_WIDTH / 2;
  const dir = flip ? -1 : 1;
  return [
    [snapV(proj[0] - Math.cos(wallAngle) * half * dir), snapV(proj[1] - Math.sin(wallAngle) * half * dir)],
    [snapV(proj[0] + Math.cos(wallAngle) * half * dir), snapV(proj[1] + Math.sin(wallAngle) * half * dir)],
  ];
}

function isNewDoor(d) {
  return !!(d && d.type === 'door' && Number.isFinite(d.cx));
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

/* ── Desk autonumbering engine ───────────────────────────────────────────────
 *  Schemes: 'D-N' → D-1, 'A-N' → A-1, 'N' → 1, 'Rm-N' → Rm-1, 'custom'
 * ────────────────────────────────────────────────────────────────────────── */
/** Returns a function (n: int) → label string for the given scheme. */
function _numFmt(scheme, prefix) {
  if (scheme === 'N') return n => String(n);
  if (scheme === 'custom') {
    const pfx = (prefix || '').trim() || 'D';
    return n => `${pfx}-${n}`;
  }
  const pfx = scheme.replace(/-N$/i, '');
  return n => `${pfx}-${n}`;
}

/** Returns a RegExp matching labels for this scheme; capture group 1 = number. */
function _numRe(scheme, prefix) {
  if (scheme === 'N') return /^(\d+)$/;
  const pfx = scheme === 'custom'
    ? ((prefix || '').trim() || 'D')
    : scheme.replace(/-N$/i, '');
  const esc = pfx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}-(\\d+)$`, 'i');
}

/** Collect the set of numbers already occupied for a numbering scheme. */
function collectUsedForScheme(scheme, prefix) {
  const re = _numRe(scheme, prefix);
  const used = new Set();
  for (const d of (ld?.desks || [])) {
    const m = re.exec(String(d.label || '').trim());
    if (m) used.add(parseInt(m[1], 10));
  }
  return used;
}

/** Find the next available integer for this scheme (skipping occupied numbers). */
function nextAutoStart(scheme, prefix) {
  const used = collectUsedForScheme(scheme, prefix);
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * Generate `count` sequential labels.
 * If `start` is null  → auto-detect next available number (gaps skipped).
 * If `start` is given → start from that exact number (may overwrite existing).
 */
function generateSequentialLabels(count, scheme, prefix, start) {
  const fmt = _numFmt(scheme, prefix);
  const hasExplicitStart = (start !== null && Number.isFinite(Number(start)) && Number(start) >= 1);

  if (hasExplicitStart) {
    // Explicit start: simple consecutive sequence (user accepts potential overwrites)
    const n0 = Math.round(Number(start));
    return Array.from({ length: count }, (_, i) => fmt(n0 + i));
  }

  // Auto-detect: skip numbers already in use to avoid duplicates
  const used = collectUsedForScheme(scheme, prefix);
  const labels = [];
  let n = 1;
  while (labels.length < count) {
    if (!used.has(n)) {
      labels.push(fmt(n));
      used.add(n); // reserve within this batch too
    }
    n++;
  }
  return labels;
}

/**
 * Renumber selected desks spatially (left→right, top→bottom).
 * Uses current deskTool numbering settings.
 */
function renumberSelected() {
  if (!ld) return;
  const desks = selectedDeskRecords({ includePrimary: true })
    .filter(d => !isDeskLocked(d));
  if (desks.length === 0) {
    edToast('Нет редактируемых мест для перенумерации', 'info');
    return;
  }
  // Sort spatially: band by Y (±half avg height), then X within band
  const avgH = desks.reduce((s, d) => s + d.h, 0) / desks.length;
  const band = Math.max(1, avgH * 0.6);
  desks.sort((a, b) => {
    const ra = Math.round(a.y / band), rb = Math.round(b.y / band);
    return ra !== rb ? ra - rb : a.x - b.x;
  });
  histSnapshot();
  const { numScheme: scheme, numPrefix: prefix, numStart: start } = ed.deskTool;
  const labels = generateSequentialLabels(desks.length, scheme, prefix, start);
  desks.forEach((d, i) => { d.label = labels[i]; });
  markDirty();
  renderDesks();
  renderObjectList();
  if (ed.selType === 'desk' && ed.selId) showPropsFor('desk', ed.selId);
  edToast(`Перенумеровано: ${desks.length} мест`, 'success');
}
/* ─────────────────────────────────────────────────────────────────────────── */

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

function makeDeskRecord(rect, label, groupId = null, groupLabel = null) {
  return {
    id: uid(), label, name: null, team: null, dept: null,
    bookable: true, fixed: false, assigned_to: null, status: 'available',
    x: rect.x, y: rect.y, w: rect.w, h: rect.h, r: 0, locked: false,
    group_id: groupId || null,
    group_label: groupLabel || null,
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

function isDeskBlockMode() {
  return ed.mode === 'desk' && ed.deskTool.placeMode === 'block';
}
function isDeskMultiMode() {
  return ed.mode === 'desk' && (ed.deskTool.placeMode === 'row' || ed.deskTool.placeMode === 'block');
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
  ed.deskTool.colCount = clampInt(ed.deskTool.colCount, 1, 100, 6);
  ed.deskTool.rowCount = clampInt(ed.deskTool.rowCount, 1, 50, 2);
  if (!['single', 'row', 'block'].includes(ed.deskTool.placeMode)) ed.deskTool.placeMode = 'single';
  if (!['horizontal', 'vertical'].includes(ed.deskTool.axis)) ed.deskTool.axis = 'horizontal';

  _v('ed-desk-place-mode', ed.deskTool.placeMode);
  _v('ed-desk-block-axis', ed.deskTool.axis);
  _vIfNotFocused('ed-desk-width', Math.round(ed.deskTool.deskW * 10) / 10);
  _vIfNotFocused('ed-desk-height', Math.round(ed.deskTool.deskH * 10) / 10);
  _vIfNotFocused('ed-desk-col-count', ed.deskTool.colCount);
  _vIfNotFocused('ed-desk-row-count', ed.deskTool.rowCount);
  if (ed.deskTool.deskGap !== null) _v('ed-desk-gap', ed.deskTool.deskGap);
  if (ed.deskTool.rowGap !== null) _v('ed-desk-row-gap', ed.deskTool.rowGap);
  _v('ed-desk-group-label', ed.deskTool.groupLabel || '');

  // Numbering controls
  const validSchemes = ['D-N', 'A-N', 'N', 'Rm-N', 'custom'];
  if (!validSchemes.includes(ed.deskTool.numScheme)) ed.deskTool.numScheme = 'D-N';
  _v('ed-desk-num-scheme', ed.deskTool.numScheme);
  _v('ed-desk-num-prefix', ed.deskTool.numPrefix || '');
  if (ed.deskTool.numStart !== null) _v('ed-desk-num-start', ed.deskTool.numStart);
  else { const el = $el('ed-desk-num-start'); if (el) el.value = ''; }
  $el('ed-desk-num-prefix-field')?.classList.toggle('ed-hidden', ed.deskTool.numScheme !== 'custom');

  const isMulti = isDeskMultiMode();
  const isBlock = isDeskBlockMode();
  $el('ed-desk-col-count-field')?.classList.toggle('ed-hidden', !isMulti);
  $el('ed-desk-row-count-field')?.classList.toggle('ed-hidden', !isBlock);
  $el('ed-desk-gap-field')?.classList.toggle('ed-hidden', !isMulti);
  $el('ed-desk-row-gap-field')?.classList.toggle('ed-hidden', !isBlock);
  $el('ed-desk-group-label-field')?.classList.toggle('ed-hidden', !isMulti);

  const note = $el('ed-desk-bulk-note');
  if (note) {
    const { w, h } = defaultDeskSize();
    const sizeNote = `(${Math.round(w)}×${Math.round(h)})`;
    if (ed.deskTool.placeMode === 'single') {
      note.textContent = `Одиночный режим: клик ставит одно место ${sizeNote}`;
    } else {
      const cols = ed.deskTool.colCount;
      const rows = isBlock ? ed.deskTool.rowCount : 1;
      const total = cols * rows;
      note.textContent = `${isBlock ? 'Блок' : 'Ряд'} ${cols}×${rows} (${total} мест) — наведите курсор, клик ставит · R — повернуть`;
    }
  }

  const preview = ed.deskTool.preview;
  const conflictEl = $el('ed-desk-bulk-conflicts');
  if (conflictEl) {
    conflictEl.classList.remove('ok');
    if (!isMulti || !preview) {
      conflictEl.textContent = '';
    } else if (preview.overflow) {
      conflictEl.textContent = `Превышение лимита: максимум ${MAX_LAYOUT_DESKS} мест`;
    } else if (preview.conflicts > 0) {
      conflictEl.textContent = `Конфликтов: ${preview.conflicts}`;
    } else if (preview.desks?.length) {
      conflictEl.textContent = `Без конфликтов (${preview.desks.length})`;
      conflictEl.classList.add('ok');
    } else {
      conflictEl.textContent = '';
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

function normalizeZoneType(value) {
  return ZONE_TYPES.includes(value) ? value : DEFAULT_ZONE_TYPE;
}

function boundaryFillOpacity(el) {
  const v = Number(el?.opacity);
  return Number.isFinite(v) && v >= 0.05 && v <= 1 ? v : DEFAULT_ZONE_OPACITY;
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
  if (isNewDoor(el)) {
    const r = (el.width || DOOR_WIDTH) * 0.6;
    return el.cx + r > x1 && el.cx - r < x2 && el.cy + r > y1 && el.cy - r < y2;
  }
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

  // New-style doors (no pts, use center distance)
  for (const door of (ld.doors || [])) {
    if (!isNewDoor(door)) continue;
    const d = Math.hypot(pt.x - door.cx, pt.y - door.cy);
    if (d <= threshold && d < bestDist) {
      bestDist = d;
      best = { type: 'door', id: door.id };
    }
  }

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
        shape.setAttribute('fill-opacity', String(boundaryFillOpacity(el)));
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

  function drawDoorsNew(doors, doorLayer) {
    if (!doorLayer) return;
    // Minimum screen-pixel sizes so door stays readable at any zoom
    const px1  = worldUnitsForScreenPx(1);
    const vbSw = layoutStrokeWidth('door', 2.2, strokeScaleVb);
    // Stroke sizes guaranteed to be ≥ N screen pixels
    const leafSw  = Math.max(px1 * 3,   vbSw * 2.2);  // thick panel — primary element
    const arcSw   = Math.max(px1 * 1.5, vbSw * 1.0);  // arc — secondary
    const jambSw  = Math.max(px1 * 1.5, vbSw * 1.0);  // jamb ticks
    const gapSw   = Math.max(px1 * 10,  vbSw * 5.5);  // gap must cover the wall

    for (const door of doors) {
      const w     = door.width || DOOR_WIDTH;
      const cosA  = Math.cos(door.angle);
      const sinA  = Math.sin(door.angle);
      const perp  = door.flip ? [sinA, -cosA] : [-sinA, cosA];
      const hx = door.cx - cosA * w / 2,  hy = door.cy - sinA * w / 2;  // hinge
      const fx = door.cx + cosA * w / 2,  fy = door.cy + sinA * w / 2;  // free jamb
      const lx = hx + perp[0] * w,        ly = hy + perp[1] * w;        // leaf-open pos

      const isSel    = ed.selType === 'door' && ed.selId === door.id;
      const isLocked = isStructLocked(door);
      const doorCol  = isSel ? '#2563eb' : '#c2410c';   // blue when selected, orange otherwise
      const sweepFlag = door.flip ? 0 : 1;
      const jambLen  = Math.max(px1 * 6, w * 0.16);    // length of jamb tick

      const g = document.createElementNS(NS, 'g');
      g.dataset.id = door.id;
      g.dataset.type = 'door';

      /* ─ 1. Gap fill: erase the wall line behind the opening ──────────────── */
      const gap = document.createElementNS(NS, 'line');
      gap.setAttribute('x1', String(hx)); gap.setAttribute('y1', String(hy));
      gap.setAttribute('x2', String(fx)); gap.setAttribute('y2', String(fy));
      gap.setAttribute('stroke', '#ffffff');             // white gap — cleanly breaks the wall line
      gap.setAttribute('stroke-width', String(gapSw));
      gap.setAttribute('stroke-linecap', 'butt');
      gap.setAttribute('pointer-events', 'none');
      g.appendChild(gap);

      /* ─ 2. Swing zone: filled quarter-pie sector ─────────────────────────── */
      // Path: hinge → free → arc → leafOpen → back to hinge
      const sectorD = `M ${hx},${hy} L ${fx},${fy} A ${w},${w} 0 0 ${sweepFlag} ${lx},${ly} Z`;
      const sector = document.createElementNS(NS, 'path');
      sector.setAttribute('d', sectorD);
      sector.setAttribute('fill', isSel ? 'rgba(37,99,235,0.12)' : 'rgba(194,65,12,0.10)');
      sector.setAttribute('stroke', 'none');
      sector.setAttribute('pointer-events', 'none');
      g.appendChild(sector);

      /* ─ 3. Swing arc (solid, secondary thickness) ────────────────────────── */
      const arc = document.createElementNS(NS, 'path');
      arc.setAttribute('d', `M ${fx},${fy} A ${w},${w} 0 0 ${sweepFlag} ${lx},${ly}`);
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', doorCol);
      arc.setAttribute('stroke-width', String(arcSw));
      arc.setAttribute('stroke-linecap', 'round');
      arc.setAttribute('opacity', '0.75');
      arc.setAttribute('pointer-events', 'none');
      g.appendChild(arc);

      /* ─ 4. Door leaf: thick solid panel (primary visual) ─────────────────── */
      const leaf = document.createElementNS(NS, 'line');
      leaf.setAttribute('x1', String(hx)); leaf.setAttribute('y1', String(hy));
      leaf.setAttribute('x2', String(lx)); leaf.setAttribute('y2', String(ly));
      leaf.setAttribute('stroke', doorCol);
      leaf.setAttribute('stroke-width', String(leafSw));
      leaf.setAttribute('stroke-linecap', 'round');
      leaf.setAttribute('pointer-events', 'none');
      g.appendChild(leaf);

      /* ─ 5. Jamb marks: short perpendicular lines at opening edges ─────────── */
      // Extend from wall-interior side (−perp * 0.3) to swing side (+perp * 0.7)
      [[hx, hy], [fx, fy]].forEach(([jx, jy]) => {
        const jt = document.createElementNS(NS, 'line');
        jt.setAttribute('x1', String(jx - perp[0] * jambLen * 0.3));
        jt.setAttribute('y1', String(jy - perp[1] * jambLen * 0.3));
        jt.setAttribute('x2', String(jx + perp[0] * jambLen * 0.7));
        jt.setAttribute('y2', String(jy + perp[1] * jambLen * 0.7));
        jt.setAttribute('stroke', doorCol);
        jt.setAttribute('stroke-width', String(jambSw * 1.3));
        jt.setAttribute('stroke-linecap', 'square');
        jt.setAttribute('pointer-events', 'none');
        g.appendChild(jt);
      });

      /* ─ 6. Hinge pivot dot ───────────────────────────────────────────────── */
      const hingeR = Math.max(px1 * 2.5, w * 0.05);
      const hinge = document.createElementNS(NS, 'circle');
      hinge.setAttribute('cx', String(hx)); hinge.setAttribute('cy', String(hy));
      hinge.setAttribute('r', String(hingeR));
      hinge.setAttribute('fill', doorCol);
      hinge.setAttribute('stroke', '#fff');
      hinge.setAttribute('stroke-width', String(Math.max(px1, w * 0.015)));
      hinge.setAttribute('pointer-events', 'none');
      g.appendChild(hinge);

      /* ─ 7. Hit area ──────────────────────────────────────────────────────── */
      const hitRadius = Math.max(worldUnitsForScreenPx(OBJECT_HIT_PX), w * 0.7);
      const hitShape = document.createElementNS(NS, 'circle');
      hitShape.setAttribute('cx', String(door.cx)); hitShape.setAttribute('cy', String(door.cy));
      hitShape.setAttribute('r', String(hitRadius));
      hitShape.setAttribute('fill', 'rgba(0,0,0,0)');
      hitShape.setAttribute('stroke', 'none');
      hitShape.setAttribute('pointer-events', 'all');
      hitShape.setAttribute('cursor', isLocked ? 'not-allowed' : (ed.mode === 'select' ? 'pointer' : 'default'));
      hitShape.addEventListener('pointerdown', ev => onStructPointerDown(ev, 'door', door.id));
      g.appendChild(hitShape);

      /* ─ 8. Selected state: rotated bounding box + hinge handle ──────────── */
      if (isSel) {
        // Rotated bounding quad aligned to the door geometry
        const m = w * 0.12;
        // 4 corners in door-local space (origin = door center, x = wall dir, y = swing dir)
        const localCorners = [
          [-w / 2 - m, -m],
          [ w / 2 + m, -m],
          [ w / 2 + m,  w + m],
          [-w / 2 - m,  w + m],
        ];
        const worldPts = localCorners.map(([lc, ls]) => [
          door.cx + lc * cosA + ls * perp[0],
          door.cy + lc * sinA + ls * perp[1],
        ]);
        const selBox = document.createElementNS(NS, 'polygon');
        selBox.setAttribute('points', worldPts.map(([wx, wy]) => `${wx},${wy}`).join(' '));
        selBox.setAttribute('fill', 'rgba(37,99,235,0.05)');
        selBox.setAttribute('stroke', '#2563eb');
        selBox.setAttribute('stroke-width', String(Math.max(px1 * 1.5, vbSw * 0.6)));
        selBox.setAttribute('stroke-dasharray', `${px1 * 5} ${px1 * 3}`);
        selBox.setAttribute('stroke-linejoin', 'round');
        selBox.setAttribute('pointer-events', 'none');
        g.appendChild(selBox);

        // Hinge handle (larger, white ring)
        const hingeHandle = document.createElementNS(NS, 'circle');
        hingeHandle.setAttribute('cx', String(hx)); hingeHandle.setAttribute('cy', String(hy));
        hingeHandle.setAttribute('r', String(Math.max(px1 * 4, w * 0.08)));
        hingeHandle.setAttribute('fill', '#2563eb');
        hingeHandle.setAttribute('stroke', '#fff');
        hingeHandle.setAttribute('stroke-width', String(Math.max(px1 * 1.5, vbSw * 0.7)));
        hingeHandle.setAttribute('pointer-events', 'none');
        g.appendChild(hingeHandle);
      }

      doorLayer.appendChild(g);
    }
  }

  drawElements(ld.walls,      'wall');
  drawElements(ld.boundaries, 'boundary');
  drawElements(ld.partitions, 'partition');
  const legacyDoors = (ld.doors || []).filter(d => !isNewDoor(d));
  const archDoors   = (ld.doors || []).filter(isNewDoor);
  if (legacyDoors.length) drawElements(legacyDoors, 'door');
  if (archDoors.length)   drawDoorsNew(archDoors, layers.door);
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

  // Boundary resize handles — 8 handles aligned to bounding box
  if (ed.selType === 'boundary' && ed.selId) {
    const el = (ld.boundaries || []).find(b => b.id === ed.selId);
    if (el && !isStructLocked(el)) {
      const bounds = pointsBounds(el.pts);
      if (bounds) {
        const handles = [
          [bounds.minX, bounds.minY],
          [bounds.cx,   bounds.minY],
          [bounds.maxX, bounds.minY],
          [bounds.maxX, bounds.cy  ],
          [bounds.maxX, bounds.maxY],
          [bounds.cx,   bounds.maxY],
          [bounds.minX, bounds.maxY],
          [bounds.minX, bounds.cy  ],
        ];
        const cursors = ['nw-resize','n-resize','ne-resize','e-resize','se-resize','s-resize','sw-resize','w-resize'];
        handles.forEach(([hx, hy], i) => {
          const circle = document.createElementNS(NS, 'circle');
          circle.setAttribute('cx', String(hx));
          circle.setAttribute('cy', String(hy));
          circle.setAttribute('r', String(r));
          circle.setAttribute('fill', '#fff');
          circle.setAttribute('stroke', '#1d4ed8');
          circle.setAttribute('stroke-width', '1.5');
          circle.setAttribute('cursor', cursors[i]);
          circle.setAttribute('pointer-events', 'all');
          circle.addEventListener('pointerdown', ev => onBoundaryResizeHandleDown(ev, el, i));
          layer.appendChild(circle);
        });
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

  // Snap guide lines
  for (const guide of (ed.snapGuides || [])) {
    const sw = Math.max(0.6, ed.vb.w * 0.0007);
    const line = document.createElementNS(NS, 'line');
    if (guide.type === 'v') {
      line.setAttribute('x1', String(guide.pos));
      line.setAttribute('y1', String(ed.vb.y - 5000));
      line.setAttribute('x2', String(guide.pos));
      line.setAttribute('y2', String(ed.vb.y + ed.vb.h + 5000));
    } else {
      line.setAttribute('x1', String(ed.vb.x - 5000));
      line.setAttribute('y1', String(guide.pos));
      line.setAttribute('x2', String(ed.vb.x + ed.vb.w + 5000));
      line.setAttribute('y2', String(guide.pos));
    }
    line.setAttribute('stroke', '#06b6d4');
    line.setAttribute('stroke-width', String(sw));
    line.setAttribute('stroke-dasharray', `${sw * 5} ${sw * 3}`);
    line.setAttribute('pointer-events', 'none');
    layer.appendChild(line);
  }
}

function renderDrawing() {
  const layer = _layer('draw');
  if (!layer) return;
  layer.innerHTML = '';

  if (isDeskMultiMode() && ed.deskTool.preview?.desks?.length) {
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

  // Boundary drag-to-rect preview
  if (ed.boundaryDrag) {
    const [x1, y1] = ed.boundaryDrag.start;
    const [x2, y2] = ed.boundaryDrag.current;
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(Math.min(x1, x2)));
    rect.setAttribute('y', String(Math.min(y1, y2)));
    rect.setAttribute('width', String(Math.abs(x2 - x1)));
    rect.setAttribute('height', String(Math.abs(y2 - y1)));
    rect.setAttribute('fill', STRUCT_COLORS.boundary);
    rect.setAttribute('fill-opacity', '0.12');
    rect.setAttribute('stroke', STRUCT_COLORS.boundary);
    rect.setAttribute('stroke-width', String(Math.max(1, ed.vb.w * 0.002)));
    rect.setAttribute('stroke-dasharray', '6 3');
    layer.appendChild(rect);
    return;
  }

  // Door preview — matches placed door visual exactly (slightly dimmed + green snap dot)
  if (ed.mode === 'door' && ed.doorPreview) {
    const { proj, angle } = ed.doorPreview;
    const w = DOOR_WIDTH;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const perp = ed.doorFlip ? [sinA, -cosA] : [-sinA, cosA];
    const hx = proj[0] - cosA * w / 2, hy = proj[1] - sinA * w / 2;
    const fx = proj[0] + cosA * w / 2, fy = proj[1] + sinA * w / 2;
    const lx = hx + perp[0] * w, ly = hy + perp[1] * w;
    const px1 = worldUnitsForScreenPx(1);
    const leafSw = Math.max(px1 * 3,   ed.vb.w * 0.0025 * 2.2);
    const arcSw  = Math.max(px1 * 1.5, ed.vb.w * 0.0025);
    const gapSw  = Math.max(px1 * 10,  ed.vb.w * 0.0025 * 5.5);
    const col = '#c2410c';
    const sweepFlag = ed.doorFlip ? 0 : 1;
    const jambLen = Math.max(px1 * 6, w * 0.16);

    // gap
    const gap = document.createElementNS(NS, 'line');
    gap.setAttribute('x1', hx); gap.setAttribute('y1', hy);
    gap.setAttribute('x2', fx); gap.setAttribute('y2', fy);
    gap.setAttribute('stroke', '#ffffff'); gap.setAttribute('stroke-width', String(gapSw));
    gap.setAttribute('stroke-linecap', 'butt'); gap.setAttribute('opacity', '0.85');
    gap.setAttribute('pointer-events', 'none');
    layer.appendChild(gap);

    // sector fill
    const sector = document.createElementNS(NS, 'path');
    sector.setAttribute('d', `M ${hx},${hy} L ${fx},${fy} A ${w},${w} 0 0 ${sweepFlag} ${lx},${ly} Z`);
    sector.setAttribute('fill', 'rgba(194,65,12,0.12)');
    sector.setAttribute('stroke', 'none'); sector.setAttribute('pointer-events', 'none');
    layer.appendChild(sector);

    // arc
    const arc = document.createElementNS(NS, 'path');
    arc.setAttribute('d', `M ${fx},${fy} A ${w},${w} 0 0 ${sweepFlag} ${lx},${ly}`);
    arc.setAttribute('fill', 'none'); arc.setAttribute('stroke', col);
    arc.setAttribute('stroke-width', String(arcSw));
    arc.setAttribute('stroke-linecap', 'round'); arc.setAttribute('opacity', '0.75');
    arc.setAttribute('pointer-events', 'none');
    layer.appendChild(arc);

    // leaf
    const leaf = document.createElementNS(NS, 'line');
    leaf.setAttribute('x1', hx); leaf.setAttribute('y1', hy);
    leaf.setAttribute('x2', lx); leaf.setAttribute('y2', ly);
    leaf.setAttribute('stroke', col); leaf.setAttribute('stroke-width', String(leafSw));
    leaf.setAttribute('stroke-linecap', 'round'); leaf.setAttribute('pointer-events', 'none');
    layer.appendChild(leaf);

    // jamb marks
    [[hx, hy], [fx, fy]].forEach(([jx, jy]) => {
      const jt = document.createElementNS(NS, 'line');
      jt.setAttribute('x1', String(jx - perp[0] * jambLen * 0.3));
      jt.setAttribute('y1', String(jy - perp[1] * jambLen * 0.3));
      jt.setAttribute('x2', String(jx + perp[0] * jambLen * 0.7));
      jt.setAttribute('y2', String(jy + perp[1] * jambLen * 0.7));
      jt.setAttribute('stroke', col); jt.setAttribute('stroke-width', String(arcSw * 1.3));
      jt.setAttribute('stroke-linecap', 'square'); jt.setAttribute('pointer-events', 'none');
      layer.appendChild(jt);
    });

    // hinge dot
    const hingeR = Math.max(px1 * 2.5, w * 0.05);
    const hinge = document.createElementNS(NS, 'circle');
    hinge.setAttribute('cx', hx); hinge.setAttribute('cy', hy);
    hinge.setAttribute('r', String(hingeR));
    hinge.setAttribute('fill', col); hinge.setAttribute('stroke', '#fff');
    hinge.setAttribute('stroke-width', String(Math.max(px1, w * 0.015)));
    hinge.setAttribute('pointer-events', 'none');
    layer.appendChild(hinge);

    // green snap indicator (center)
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', proj[0]); dot.setAttribute('cy', proj[1]);
    dot.setAttribute('r', String(Math.max(px1 * 3, w * 0.04)));
    dot.setAttribute('fill', '#22c55e'); dot.setAttribute('stroke', '#fff');
    dot.setAttribute('stroke-width', String(Math.max(px1, w * 0.012)));
    dot.setAttribute('pointer-events', 'none');
    layer.appendChild(dot);
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
    } else if (isDeskMultiMode()) {
      hintEl.textContent = 'Наведите курсор — появится превью · Клик — вставить · R — повернуть · Esc — отменить';
    } else if (ed.mode === 'desk') {
      hintEl.textContent = 'Клик — поставить одно место · D — переключить режим';
    } else if (LINE_TOOLS.includes(ed.mode) && ed.drawing) {
      // Line tool: in-progress state — show point count and completion keys
      const ptCount = ed.drawing.pts?.length || 0;
      const noun = ptCount === 1 ? 'точка' : 'точек';
      hintEl.textContent = `${ptCount} ${noun} · Shift — угол 45° · Enter / двойной клик — завершить · Esc — отменить`;
    } else if (ed.mode === 'boundary' && ed.boundaryDrag) {
      // Area tool: drag in progress
      hintEl.textContent = 'Тащите для задания прямоугольника зоны · Esc — отменить';
    } else if (ed.mode === 'door') {
      // Object tool: hover-to-snap, click-to-place
      hintEl.textContent = ed.doorPreview
        ? `Кликните, чтобы вставить дверь · R — сменить сторону (${ed.doorFlip ? '←' : '→'})`
        : 'Наведите на стену или перегородку · R — сменить направление · Esc — выйти';
    } else {
      hintEl.textContent = MODE_HINTS[ed.mode] || '';
    }
  }
  if (precEl) {
    const flags = [];
    if (ed.altSnapOff && (ed.snapGrid || ed.snapToObjects || ed.snapToWalls)) flags.push('NO SNAP');
    if (!ed.altSnapOff && ed.snapToObjects) flags.push('⊟OBJ');
    if (!ed.altSnapOff && ed.snapToWalls)   flags.push('⊣WALL');
    if (ed.shiftDown && isDrawMode(ed.mode)) flags.push(`ANGLE ${DRAW_ANGLE_STEP_DEG}°`);
    else if (ed.shiftFine) flags.push('FINE');
    precEl.textContent = flags.join(' ');
  }
  if (zoomEl && ld) {
    const pct = Math.round(ld.vb[2] / ed.vb.w * 100);
    zoomEl.textContent = pct + '%';
  }
}

function modeLabel(m) {
  return { select:'Выбор', pan:'Рука', wall:'Стена', boundary:'Граница', partition:'Перегородка', door:'Дверь', desk:'Стол' }[m] || m;
}

/* ── Object list helpers ────────────────────────────────────────────────────── */
function polylineLength(pts) {
  if (!pts || pts.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return Math.round(total);
}

function deskStatusMeta(desk) {
  if (desk.fixed && desk.assigned_to) return { text: `фикс. · ${desk.assigned_to}`, cls: 'meta-fixed' };
  if (desk.fixed) return { text: 'фикс.', cls: 'meta-fixed' };
  if (desk.status === 'disabled') return { text: 'откл.', cls: 'meta-off' };
  if (desk.status === 'occupied') return { text: 'занято', cls: 'meta-occ' };
  return { text: 'своб.', cls: 'meta-free' };
}

// SVG icon definitions (12×10 px viewbox)
const INV_ICON = {
  desk:      `<svg viewBox="0 0 13 10" width="13" height="10" aria-hidden="true"><rect x="0.5" y="0.5" width="12" height="9" rx="1.5" fill="currentColor" opacity=".18"/><rect x="0.5" y="0.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  desk_fixed:`<svg viewBox="0 0 13 10" width="13" height="10" aria-hidden="true"><rect x="0.5" y="0.5" width="12" height="9" rx="1.5" fill="currentColor" opacity=".35"/><rect x="0.5" y="0.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="5" x2="9" y2="5" stroke="currentColor" stroke-width="1.2"/></svg>`,
  wall:      `<svg viewBox="0 0 14 6" width="14" height="6" aria-hidden="true"><rect x="0" y="1.5" width="14" height="3" rx="1" fill="currentColor"/></svg>`,
  partition: `<svg viewBox="0 0 14 6" width="14" height="6" aria-hidden="true"><rect x="0" y="1.5" width="14" height="3" rx="1" fill="currentColor" opacity=".55"/><line x1="0" y1="3" x2="14" y2="3" stroke="currentColor" stroke-width="1" stroke-dasharray="3 2"/></svg>`,
  door:      `<svg viewBox="0 0 10 12" width="10" height="12" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="11" rx="1" fill="currentColor" opacity=".15"/><rect x="0.5" y="0.5" width="9" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5 11 Q5 4 9 2" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
  zone:      `<svg viewBox="0 0 14 10" width="14" height="10" aria-hidden="true"><rect x="0.5" y="0.5" width="13" height="9" rx="1" fill="currentColor" opacity=".25"/><rect x="0.5" y="0.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="3 2"/></svg>`,
};

function doorInventoryLabel(door, idx) {
  if (!isNewDoor(door)) {
    // Legacy pts-based door
    return door.label || `Дверь (${door.pts?.length ?? '?'} pts)`;
  }
  const num = idx + 1;
  const w = Math.round(door.width || DOOR_WIDTH);
  const dir = door.flip ? '←' : '→';
  const wallRef = door.wallId
    ? (door.wallType === 'wall' ? ' · стена' : door.wallType === 'partition' ? ' · пер.' : '')
    : '';
  return `Дверь #${num} · ${w} ед · ${dir}${wallRef}`;
}

function renderObjectList() {
  const list = $el('ed-obj-list');
  if (!list) return;
  if (!ld) { list.innerHTML = '<p style="color:#475569;font-size:12px;padding:8px 10px">Загрузите этаж</p>'; return; }

  const q = ($el('ed-obj-search')?.value || '').toLowerCase();

  // ── Item builder ─────────────────────────────────────────────────────────
  function item(type, id, name, meta, iconHtml, iconColor, active, locked, extraClass = '') {
    const lock = locked ? '<span class="ed-obj-lock" title="Закреплён">L</span>' : '';
    return `<div class="ed-obj-item${active ? ' active' : ''}${extraClass ? ' ' + extraClass : ''}" data-id="${id}" data-type="${type}">
      <span class="ed-obj-icon" style="color:${iconColor}">${iconHtml}</span>
      <span class="ed-obj-body">
        <span class="ed-obj-name">${name}</span>${meta ? `<span class="ed-obj-meta">${meta}</span>` : ''}
      </span>${lock}
    </div>`;
  }

  function sectionHeader(title, count) {
    return count ? `<div class="ed-obj-section-header">${title}<span class="ed-obj-section-count">${count}</span></div>` : '';
  }

  // ── Desks ─────────────────────────────────────────────────────────────────
  function makeDeskSection(desks) {
    const groups = {};
    const ungrouped = [];
    for (const d of desks) {
      if (d.group_id) (groups[d.group_id] = groups[d.group_id] || []).push(d);
      else ungrouped.push(d);
    }

    function matchDesk(d) {
      if (!q) return true;
      return (d.label || '').toLowerCase().includes(q)
        || (d.name || '').toLowerCase().includes(q)
        || (d.group_label || '').toLowerCase().includes(q);
    }

    const visibleUngrouped = ungrouped.filter(matchDesk);
    const visibleGroups = Object.entries(groups).filter(([, gd]) => gd.some(matchDesk));
    const total = visibleUngrouped.length + visibleGroups.reduce((s, [, gd]) => s + gd.filter(matchDesk).length, 0);
    if (!total) return '';

    let html = sectionHeader('Места', total);

    for (const [gid, gDesks] of visibleGroups) {
      const filteredG = gDesks.filter(matchDesk);
      if (!filteredG.length) continue;
      const groupLabel = gDesks[0]?.group_label || `Группа`;
      html += `<div class="ed-obj-group-header" data-group-id="${gid}">
        <span class="ed-obj-group-icon">⊞</span>
        <span class="ed-obj-group-label">${groupLabel}</span>
        <span class="ed-obj-group-count">${filteredG.length} мест</span>
        <button class="ed-obj-ungroup-btn" data-group-id="${gid}" title="Разгруппировать">✕</button>
      </div>`;
      for (const d of filteredG) {
        const sm = deskStatusMeta(d);
        const iconKey = d.fixed ? 'desk_fixed' : 'desk';
        const color = d.fixed ? '#d97706' : '#2563eb';
        html += item('desk', d.id, d.label, `<span class="inv-status ${sm.cls}">${sm.text}</span>`,
          INV_ICON[iconKey], color, isDeskSelected(d.id), d.locked, 'ed-obj-item-grouped');
      }
    }
    for (const d of visibleUngrouped) {
      const sm = deskStatusMeta(d);
      const iconKey = d.fixed ? 'desk_fixed' : 'desk';
      const color = d.fixed ? '#d97706' : '#2563eb';
      html += item('desk', d.id, d.label, `<span class="inv-status ${sm.cls}">${sm.text}</span>`,
        INV_ICON[iconKey], color, isDeskSelected(d.id), d.locked);
    }
    return html;
  }

  // ── Walls ─────────────────────────────────────────────────────────────────
  function makeWallSection(walls) {
    const entries = walls.map((w, i) => {
      const len = polylineLength(w.pts);
      const segs = (w.pts?.length ?? 1) - 1;
      const name = w.label || `Стена #${i + 1}`;
      const meta = len ? (segs > 1 ? `дл. ${len} · ${segs} сег.` : `дл. ${len}`) : '';
      const searchText = name + ' ' + meta;
      return { w, name, meta, searchText };
    }).filter(({ searchText }) => !q || searchText.toLowerCase().includes(q));
    if (!entries.length) return '';
    let html = sectionHeader('Стены', entries.length);
    for (const { w, name, meta } of entries) {
      html += item('wall', w.id, name, meta, INV_ICON.wall, STRUCT_COLORS.wall, isStructSelected('wall', w.id), w.locked);
    }
    return html;
  }

  // ── Partitions ────────────────────────────────────────────────────────────
  function makePartitionSection(partitions) {
    const entries = partitions.map((p, i) => {
      const len = polylineLength(p.pts);
      const segs = (p.pts?.length ?? 1) - 1;
      const name = p.label || `Перегородка #${i + 1}`;
      const meta = len ? (segs > 1 ? `дл. ${len} · ${segs} сег.` : `дл. ${len}`) : '';
      const searchText = name + ' ' + meta;
      return { p, name, meta, searchText };
    }).filter(({ searchText }) => !q || searchText.toLowerCase().includes(q));
    if (!entries.length) return '';
    let html = sectionHeader('Перегородки', entries.length);
    for (const { p, name, meta } of entries) {
      html += item('partition', p.id, name, meta, INV_ICON.partition, STRUCT_COLORS.partition,
        isStructSelected('partition', p.id), p.locked);
    }
    return html;
  }

  // ── Doors ─────────────────────────────────────────────────────────────────
  function makeDoorSection(doors) {
    const entries = doors.map((door, i) => {
      let name, meta;
      if (isNewDoor(door)) {
        name = door.label || `Дверь #${i + 1}`;
        const w = Math.round(door.width || DOOR_WIDTH);
        const wall = door.wallType === 'wall' ? 'стена' : door.wallType === 'partition' ? 'пер.' : '';
        meta = [w ? `${w} ед.` : '', wall].filter(Boolean).join(' · ');
      } else {
        name = door.label || `Дверь #${i + 1}`;
        meta = '';
      }
      return { door, name, meta, searchText: name + ' ' + meta };
    }).filter(({ searchText }) => !q || searchText.toLowerCase().includes(q));
    if (!entries.length) return '';
    let html = sectionHeader('Двери', entries.length);
    for (const { door, name, meta } of entries) {
      html += item('door', door.id, name, meta, INV_ICON.door, STRUCT_COLORS.door,
        isStructSelected('door', door.id), door.locked);
    }
    return html;
  }

  // ── Zones / Boundaries ────────────────────────────────────────────────────
  function makeBoundarySection(boundaries) {
    const entries = boundaries.map((b, i) => {
      const bounds = pointsBounds(b.pts);
      const w = bounds ? Math.round(bounds.w) : null;
      const h = bounds ? Math.round(bounds.h) : null;
      const typeLabel = ZONE_TYPE_LABELS[normalizeZoneType(b.zone_type)] || 'Зона';
      const name = b.label || `Зона #${i + 1}`;
      const meta = [typeLabel, w && h ? `${w}×${h}` : ''].filter(Boolean).join(' · ');
      return { b, name, meta, searchText: name + ' ' + meta };
    }).filter(({ searchText }) => !q || searchText.toLowerCase().includes(q));
    if (!entries.length) return '';
    let html = sectionHeader('Зоны', entries.length);
    for (const { b, name, meta } of entries) {
      const color = normalizeHexColor(b.color, DEFAULT_ZONE_COLOR);
      html += item('boundary', b.id, name, meta, INV_ICON.zone, color,
        isStructSelected('boundary', b.id), b.locked);
    }
    return html;
  }

  list.innerHTML =
    makeDeskSection(ld.desks || []) +
    makeWallSection(ld.walls || []) +
    makePartitionSection(ld.partitions || []) +
    makeDoorSection(ld.doors || []) +
    makeBoundarySection(ld.boundaries || []);

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

  // Ungroup buttons
  list.querySelectorAll('.ed-obj-ungroup-btn').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      ungroupDesks(btn.dataset.groupId);
    });
  });
  // Group header click — select all in group
  list.querySelectorAll('.ed-obj-group-header').forEach(hdr => {
    hdr.addEventListener('click', ev => {
      if (ev.target.classList.contains('ed-obj-ungroup-btn')) return;
      const gid = hdr.dataset.groupId;
      if (!gid || !ld) return;
      const gDesks = ld.desks.filter(d => d.group_id === gid);
      if (!gDesks.length) return;
      ed.selType = 'desk';
      ed.selId = gDesks[0].id;
      ed.multiDeskIds = gDesks.slice(1).map(d => d.id);
      ed.multiStructKeys = [];
      renderDesks();
      renderSelection();
      renderObjectList();
      showPropsFor('desk', gDesks[0].id);
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
  const doorP  = $el('ed-props-door');
  const zoneFields = $el('ep-zone-fields');
  const deskSingle = $el('ep-single-desk-fields');
  const deskMulti = $el('ep-multi-desk-panel');
  const deskMultiMode = type === null && hasMultiDeskSelection() && !hasMultiStructSelection();

  const el_door = type === 'door' ? (ld?.doors || []).find(x => x.id === id) : null;
  const isDoorNewStyle = isNewDoor(el_door);

  if (empty)   empty.classList.toggle('ed-hidden', type !== null || deskMultiMode);
  if (deskP)   deskP.classList.toggle('ed-hidden', !(type === 'desk' || deskMultiMode));
  if (doorP)   doorP.classList.toggle('ed-hidden', !(type === 'door' && isDoorNewStyle));
  if (structP) structP.classList.toggle('ed-hidden', !(['wall','boundary','partition'].includes(type) || (type === 'door' && !isDoorNewStyle)));
  if (zoneFields) zoneFields.classList.toggle('ed-hidden', type !== 'boundary');
  const wallFields = $el('ep-wall-fields');
  if (wallFields) wallFields.classList.toggle('ed-hidden', type === 'boundary');
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

  if (['wall','boundary','partition','door'].includes(type) && id && ld && !(type === 'door' && isDoorNewStyle)) {
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
      _v('ep-zone-type', normalizeZoneType(el.zone_type));
      const opVal = boundaryFillOpacity(el);
      _v('ep-zone-opacity', opVal);
      const opPct = $el('ep-zone-opacity-pct');
      if (opPct) opPct.textContent = Math.round(opVal * 100) + '%';
      // hide "closed" checkbox — boundary is always closed
      const closedRow = $el('ep-struct-closed')?.closest('.ed-prop-row');
      if (closedRow) closedRow.style.display = 'none';
    } else {
      const closedRow = $el('ep-struct-closed')?.closest('.ed-prop-row');
      if (closedRow) closedRow.style.display = '';
    }
    const ptCount = $el('ep-struct-pt-count');
    if (ptCount) ptCount.textContent = el.pts?.length || 0;
    // Length input for wall/partition
    const lenEl = $el('ep-struct-length');
    if (lenEl) {
      if (type !== 'boundary') {
        const len = polylineLength(el.pts || []);
        lenEl.value = len;
        lenEl.disabled = false;
      } else {
        lenEl.value = '';
        lenEl.disabled = true;
      }
    }
    // Angle input for wall/partition (angle of first segment)
    const angleEl = $el('ep-struct-angle');
    if (angleEl) {
      if (type !== 'boundary' && el.pts && el.pts.length >= 2) {
        const [ax, ay] = el.pts[0];
        const [bx, by] = el.pts[1];
        const angleDeg = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
        angleEl.value = Math.round(angleDeg);
        angleEl.disabled = false;
      } else {
        angleEl.value = '';
        angleEl.disabled = true;
      }
    }
    // Zone geometry (read-only bounds)
    if (type === 'boundary') {
      const b = pointsBounds(el.pts || []);
      const setInfo = (id, v) => { const e = $el(id); if (e) e.textContent = v != null ? Math.round(v) : '—'; };
      setInfo('ep-zone-x', b?.minX);
      setInfo('ep-zone-y', b?.minY);
      setInfo('ep-zone-w', b != null ? b.maxX - b.minX : null);
      setInfo('ep-zone-h', b != null ? b.maxY - b.minY : null);
    }
  }
  toggleStructLabelAngleField();

  if (type === 'door' && isDoorNewStyle && el_door) {
    _v('ep-door-width', Math.round(el_door.width || DOOR_WIDTH));
    _v('ep-door-angle', Math.round((el_door.angle || 0) * 180 / Math.PI));
    _vc('ep-door-flip', !!el_door.flip);
    _vc('ep-door-locked', !!el_door.locked);
    const wallInfo = $el('ep-door-wall-info');
    if (wallInfo) {
      const wt = el_door.wallType === 'wall' ? 'Стена' : el_door.wallType === 'partition' ? 'Перегородка' : '—';
      wallInfo.textContent = el_door.wallId ? `${wt} (${el_door.wallId.slice(0, 8)}…)` : '—';
    }
  }
}

function _v(id, val) { const el = $el(id); if (el) el.value = val; }
function _vIfNotFocused(id, val) { const el = $el(id); if (el && document.activeElement !== el) el.value = val; }
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
  histSnapshot();
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
  histSnapshot();

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

  // Align buttons
  document.querySelectorAll('[data-align]').forEach(btn => {
    btn.addEventListener('click', () => alignSelected(btn.dataset.align));
  });
  document.querySelectorAll('[data-distribute]').forEach(btn => {
    btn.addEventListener('click', () => distributeSelected(btn.dataset.distribute));
  });
  $el('ep-group-btn')?.addEventListener('click', () => groupSelectedDesks());
  $el('ep-ungroup-btn')?.addEventListener('click', () => ungroupSelected());
  $el('ep-duplicate-btn')?.addEventListener('click', () => duplicateSelected());

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
  $el('ep-struct-label-angle')?.addEventListener('input', () => applyStructProps({ syncForm: false, skipHistory: true }));
  $el('ep-struct-label-size')?.addEventListener('input', () => applyStructProps({ syncForm: false, skipHistory: true }));
  $el('ep-struct-label')?.addEventListener('input', () => applyStructProps({ syncForm: false, skipHistory: true }));
  $el('ep-struct-label')?.addEventListener('change', () => applyStructProps({ syncForm: true }));
  $el('ep-struct-angle')?.addEventListener('change', () => applyStructProps({ syncForm: true }));
  $el('ep-struct-length')?.addEventListener('change', () => applyStructProps({ syncForm: true }));
  $el('ep-struct-del')?.addEventListener('click', () => {
    if (!ed.selId) return;
    deleteStructEl(ed.selType, ed.selId);
  });

  // Zone (boundary) extra props
  $el('ep-zone-type')?.addEventListener('change', () => applyStructProps({ syncForm: true }));
  $el('ep-zone-opacity')?.addEventListener('input', () => {
    const v = Number($el('ep-zone-opacity')?.value);
    const pct = $el('ep-zone-opacity-pct');
    if (pct) pct.textContent = Math.round(v * 100) + '%';
    applyStructProps({ syncForm: false, skipHistory: true });
  });
  $el('ep-zone-opacity')?.addEventListener('change', () => applyStructProps({ syncForm: true }));

  // Door object props
  $el('ep-door-width')?.addEventListener('change', () => applyDoorProps());
  $el('ep-door-angle')?.addEventListener('change', () => applyDoorProps());
  $el('ep-door-flip')?.addEventListener('change', () => {
    applyDoorProps();
    ed.doorFlip = !!$el('ep-door-flip')?.checked;
  });
  $el('ep-door-locked')?.addEventListener('change', () => applyDoorProps());
  $el('ep-door-del')?.addEventListener('click', () => {
    if (!ed.selId || ed.selType !== 'door') return;
    const door = (ld?.doors || []).find(x => x.id === ed.selId);
    if (isStructLocked(door)) { edToast('Объект закреплён', 'info'); return; }
    ld.doors = ld.doors.filter(d => d.id !== ed.selId);
    deselect(); markDirty(); renderAll();
  });
}

function applyDeskProps() {
  if (ed.selType !== 'desk' || !ed.selId || !ld) return;
  const d = ld.desks.find(x => x.id === ed.selId);
  if (!d) return;
  histSnapshot();
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
  const { syncForm = true, skipHistory = false } = opts;
  if (!ed.selType || !ed.selId || !ld) return;
  if (!skipHistory) histSnapshot();
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

  // Wall/partition angle rotation
  if (ed.selType !== 'boundary' && ed.selType !== 'door' && el.pts && el.pts.length >= 2) {
    const angleInput = _numOrNull('ep-struct-angle');
    if (angleInput !== null) {
      const [ax, ay] = el.pts[0];
      const [bx, by] = el.pts[1];
      const currentAngle = Math.atan2(by - ay, bx - ax);
      const targetAngle = angleInput * Math.PI / 180;
      const delta = targetAngle - currentAngle;
      if (Math.abs(delta) > 0.0005) {
        const cx = el.pts[0][0], cy = el.pts[0][1];
        el.pts = el.pts.map(([x, y]) => {
          const dx = x - cx, dy = y - cy;
          return [
            cx + dx * Math.cos(delta) - dy * Math.sin(delta),
            cy + dx * Math.sin(delta) + dy * Math.cos(delta),
          ];
        });
      }
    }
    // Wall/partition length scaling (from first point)
    const lenInput = _numOrNull('ep-struct-length');
    if (lenInput !== null && lenInput > 0) {
      const currentLen = polylineLength(el.pts);
      if (currentLen > 0) {
        const scale = lenInput / currentLen;
        const [ox, oy] = el.pts[0];
        el.pts = el.pts.map(([x, y]) => [
          ox + (x - ox) * scale,
          oy + (y - oy) * scale,
        ]);
      }
    }
  }

  if (ed.selType === 'boundary') {
    el.label = zoneLabel || null;
    el.color = zoneColor;
    el.label_size = zoneLabelSizeValue;
    el.label_pos = zoneLabelPos;
    el.label_angle = zoneLabelAngle;
    el.zone_type = normalizeZoneType($el('ep-zone-type')?.value);
    const opInput = Number($el('ep-zone-opacity')?.value);
    el.opacity = Number.isFinite(opInput) && opInput >= 0.05 && opInput <= 1 ? opInput : DEFAULT_ZONE_OPACITY;
  } else {
    if (Object.prototype.hasOwnProperty.call(el, 'color')) delete el.color;
    if (Object.prototype.hasOwnProperty.call(el, 'label_size')) delete el.label_size;
    if (Object.prototype.hasOwnProperty.call(el, 'label_pos')) delete el.label_pos;
    if (Object.prototype.hasOwnProperty.call(el, 'label_angle')) delete el.label_angle;
  }

  // If type changed, move to different array (door reclassification not allowed via this panel)
  if (newType && newType !== ed.selType && ['wall', 'boundary', 'partition'].includes(newType)) {
    srcArr.splice(idx, 1);
    const dstArr = newType === 'wall'
      ? ld.walls
      : newType === 'boundary'
        ? ld.boundaries
        : ld.partitions;
    if (newType === 'boundary') {
      el.color = zoneColor;
      el.label = zoneLabel || el.label || null;
      el.label_size = zoneLabelSizeValue;
      el.label_pos = zoneLabelPos;
      el.label_angle = zoneLabelAngle;
      el.zone_type = normalizeZoneType($el('ep-zone-type')?.value);
      el.opacity = DEFAULT_ZONE_OPACITY;
    } else {
      if (Object.prototype.hasOwnProperty.call(el, 'color')) delete el.color;
      if (Object.prototype.hasOwnProperty.call(el, 'label_size')) delete el.label_size;
      if (Object.prototype.hasOwnProperty.call(el, 'label_pos')) delete el.label_pos;
      if (Object.prototype.hasOwnProperty.call(el, 'label_angle')) delete el.label_angle;
      if (Object.prototype.hasOwnProperty.call(el, 'zone_type')) delete el.zone_type;
      if (Object.prototype.hasOwnProperty.call(el, 'opacity')) delete el.opacity;
    }
    dstArr.push(el);
    ed.selType = newType;
  }

  markDirty();
  renderStructure();
  renderObjectList();
  if (syncForm) showPropsFor(ed.selType, ed.selId);
}

function applyDoorProps() {
  if (ed.selType !== 'door' || !ed.selId || !ld) return;
  const door = (ld.doors || []).find(x => x.id === ed.selId);
  if (!isNewDoor(door)) return;
  histSnapshot();
  const w = _numOrNull('ep-door-width');
  if (w !== null) door.width = Math.max(10, Math.min(200, w));
  const deg = _numOrNull('ep-door-angle');
  if (deg !== null) door.angle = deg * Math.PI / 180;
  door.flip   = !!$el('ep-door-flip')?.checked;
  door.locked = !!$el('ep-door-locked')?.checked;
  markDirty();
  renderStructure();
}

function deleteStructEl(type, id) {
  if (!ld || !type || !id) return;
  const el = getStructByTypeId(type, id);
  if (isStructLocked(el)) {
    edToast('Объект закреплён: удаление недоступно', 'info');
    return;
  }
  histSnapshot();
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
  histSnapshot();
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
  histSnapshot();
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
  histSnapshot();
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

  ed.dragGroup = { pointerId, startPt, desks, structs, moved: false, beforeSnap: _snapLd() };
  _svg()?.setPointerCapture(pointerId);
  return true;
}

function updateGroupDrag(pt) {
  const g = ed.dragGroup;
  if (!g) return;
  const rawDx = pt.x - g.startPt.x;
  const rawDy = pt.y - g.startPt.y;

  // Compute smart snap using the first movable desk as anchor
  let dx = rawDx, dy = rawDy;
  if (g.desks?.length) {
    const anchor = g.desks[0];
    const excludeIds = g.desks.map(it => it.desk.id);
    const snapped = computeSnapForRect(
      anchor.x + rawDx, anchor.y + rawDy,
      anchor.desk.w, anchor.desk.h,
      excludeIds
    );
    dx = snapped.x - anchor.x;
    dy = snapped.y - anchor.y;
    ed.snapGuides = snapped.guides;
  } else {
    dx = snapV(rawDx + (g.structs?.[0]?.pts?.[0]?.[0] ?? 0)) - (g.structs?.[0]?.pts?.[0]?.[0] ?? 0);
    dy = snapV(rawDy + (g.structs?.[0]?.pts?.[0]?.[1] ?? 0)) - (g.structs?.[0]?.pts?.[0]?.[1] ?? 0);
    ed.snapGuides = [];
  }

  for (const it of (g.desks || [])) {
    it.desk.x = it.x + dx;
    it.desk.y = it.y + dy;
  }
  for (const it of (g.structs || [])) {
    it.el.pts = it.pts.map(([x, y]) => [snapV(x + rawDx), snapV(y + rawDy)]);
  }
  g.moved = g.moved || Math.abs(rawDx) > 0.2 || Math.abs(rawDy) > 0.2;
  if (g.structs?.length) renderStructure();
  if (g.desks?.length) renderDesks();
  renderSelection();
}

function endGroupDrag() {
  if (!ed.dragGroup) return false;
  const moved = !!ed.dragGroup.moved;
  const beforeSnap = ed.dragGroup.beforeSnap;
  ed.dragGroup = null;
  ed.snapGuides = [];
  renderSelection();
  if (moved) { histPushSnap(beforeSnap); markDirty(); }
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
  if (!el) return false;

  const beforeSnap = _snapLd();

  // New-style door: drag cx/cy
  if (isNewDoor(el)) {
    if (isStructLocked(el)) {
      edToast('Объект закреплён и не может быть перемещён', 'info');
      return false;
    }
    const baseCx = el.cx, baseCy = el.cy;
    let moved = false;
    const onMove = (ev) => {
      const p = svgPt(ev);
      const dx = p.x - startPt.x;
      const dy = p.y - startPt.y;
      el.cx = snapV(baseCx + dx);
      el.cy = snapV(baseCy + dy);
      moved = moved || Math.hypot(dx, dy) > 0.2;
      renderStructure();
      renderSelection();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (moved) { histPushSnap(beforeSnap); markDirty(); }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return true;
  }

  if (!Array.isArray(el.pts) || el.pts.length < 2) return false;
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
    if (moved) { histPushSnap(beforeSnap); markDirty(); }
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

  if (isDeskMultiMode()) {
    // Float preview: no drag needed; click handled in onSvgClick
    e.preventDefault();
    return;
  }

  // Boundary: drag-to-rectangle (intercepted before general drawing)
  if (ed.mode === 'boundary') {
    e.preventDefault();
    ed.boundaryDrag = { pointerId: e.pointerId, start: [pt.x, pt.y], current: [pt.x, pt.y] };
    _svg()?.setPointerCapture(e.pointerId);
    renderDrawing();
    updateStatusBar(); // show "drag in progress" hint
    return;
  }

  // Door: handled by click (onSvgClick), no drag drawing
  if (ed.mode === 'door') return;

  // Wall / Partition: polyline drawing with endpoint snap
  if (LINE_TOOLS.includes(ed.mode)) {
    e.preventDefault();
    const ep = snapToEndpoints(pt);
    const snapped = ep || [snapV(pt.x), snapV(pt.y)];

    if (!ed.drawing) {
      ed.drawing = { type: ed.mode, pts: [snapped], rubberPt: snapped };
      renderDrawing();
      updateStatusBar(); // show "1 точка" in hint
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

  if (isDeskMultiMode()) {
    updateDeskFloatPreview(pt);
    return;
  }

  // Drawing rubber band (wall/partition)
  if (ed.drawing) {
    const last = ed.drawing.pts?.[ed.drawing.pts.length - 1];
    ed.drawing.rubberPt = getConstrainedDrawPoint(last, pt, {
      angleLock: !!e.shiftKey,
      angleStepDeg: DRAW_ANGLE_STEP_DEG,
    });
    renderDrawing();
    return;
  }

  // Boundary drag-to-rect
  if (ed.boundaryDrag) {
    ed.boundaryDrag.current = [pt.x, pt.y];
    renderDrawing();
    return;
  }

  // Door mode: show nearest wall preview
  if (ed.mode === 'door') {
    const hit = findNearestWallSegment(pt);
    const hadPreview = !!ed.doorPreview;
    ed.doorPreview = hit ? { proj: hit.proj, angle: hit.angle } : null;
    const svg = _svg();
    if (svg) svg.style.cursor = hit ? 'pointer' : 'crosshair';
    renderDrawing();
    // Update hint only when snap state changes (not every frame)
    if (!!ed.doorPreview !== hadPreview) updateStatusBar();
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
  if (ed.boundaryDrag) {
    commitBoundaryDrag();
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

function commitBoundaryDrag() {
  const drag = ed.boundaryDrag;
  if (!drag || !ld) { ed.boundaryDrag = null; return; }
  histSnapshot();
  ed.boundaryDrag = null;
  const [x1, y1] = drag.start;
  const [x2, y2] = drag.current;
  const minW = worldUnitsForScreenPx(6);
  if (Math.abs(x2 - x1) < minW && Math.abs(y2 - y1) < minW) {
    renderDrawing();
    return; // too small, cancel
  }
  const lx = snapV(Math.min(x1, x2)), rx = snapV(Math.max(x1, x2));
  const ty = snapV(Math.min(y1, y2)), by = snapV(Math.max(y1, y2));
  const el = {
    id: uid(),
    pts: [[lx, ty], [rx, ty], [rx, by], [lx, by]],
    thick: 2,
    closed: true,
    conf: 1.0,
    locked: false,
    label: null,
    color: DEFAULT_ZONE_COLOR,
    label_size: defaultZoneLabelSize(),
    label_pos: 'center',
    label_angle: 0,
    zone_type: DEFAULT_ZONE_TYPE,
    opacity: DEFAULT_ZONE_OPACITY,
  };
  ld.boundaries.push(el);
  markDirty();
  selectObj('boundary', el.id);
  renderStructure();
  renderDrawing();
  updateStatusBar(); // reset hint to idle after commit
}

function onSvgClick(e) {
  if (ed.spacePanning || ed.panning) return;

  // Door mode: handle click before inBackground check — the click lands on the
  // wall's hitShape element (not the SVG background), so the normal guard would
  // swallow it. Door placement only needs svgPt + findNearestWallSegment.
  if (ed.mode === 'door') {
    const pt = svgPt(e);
    const hit = findNearestWallSegment(pt);
    if (!hit) {
      edToast('Кликните ближе к стене или перегородке', 'info');
      return;
    }
    const el = {
      id: uid(),
      type: 'door',
      cx: hit.proj[0],
      cy: hit.proj[1],
      angle: hit.angle,
      width: DOOR_WIDTH,
      flip: ed.doorFlip,
      wallId: hit.el.id,
      wallType: hit.type,
      locked: false,
      conf: 1.0,
    };
    histSnapshot();
    ld.doors = [...(ld.doors || []), el];
    markDirty();
    selectObj('door', el.id);
    renderStructure();
    return;
  }

  const target = e.target;
  const inBackground = target === _svg() ||
    target.closest('#ed-layer-bg') ||
    target === document.getElementById('ed-grid-rect');

  if (!inBackground) return;

  if (isDeskMultiMode()) {
    if (ed.deskTool.preview) {
      commitDeskFloatPreview();
    }
    return;
  }

  // Line tools: add point
  if (LINE_TOOLS.includes(ed.mode) && ed.drawing) {
    const pt = svgPt(e);
    const pts = ed.drawing.pts;
    const base = pts?.[pts.length - 1];
    const snapped = getConstrainedDrawPoint(base, pt, {
      angleLock: !!e.shiftKey,
      angleStepDeg: DRAW_ANGLE_STEP_DEG,
    });
    pts.push(snapped);
    renderDrawing();
    updateStatusBar(); // update pt count in hint
  }
}

function onSvgDblClick(e) {
  if (LINE_TOOLS.includes(ed.mode) && ed.drawing) {
    finishDrawing(false);
  }
}

function onWheelZoom(e) {
  e.preventDefault();
  const pt = svgPt(e);
  const rawDelta = Number.isFinite(e.deltaY) ? e.deltaY : 0;

  // ctrlKey=true means trackpad pinch-to-zoom (macOS/Chrome/Safari).
  // deltaY values are small (~0.5–3), so use a much higher speed coefficient.
  // Regular scroll wheel sends large deltaY (50–120), so use a lower coefficient.
  let factor;
  if (e.ctrlKey) {
    // Pinch gesture: clamp per-event zoom to ±25% to avoid jumps on fast gestures
    factor = Math.exp(Math.max(-0.25, Math.min(0.25, rawDelta * 0.06)));
  } else {
    const delta = Math.max(-120, Math.min(120, rawDelta));
    factor = Math.exp(delta * 0.00115);
  }

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

function onBoundaryResizeHandleDown(e, el, handleIdx) {
  if (ed.mode !== 'select' || !ld) return;
  if (isStructLocked(el)) return;
  e.stopPropagation();
  e.preventDefault();
  const captureTarget = _svg();
  try { captureTarget?.setPointerCapture(e.pointerId); } catch {}

  const startPt = svgPt(e);
  const bounds = pointsBounds(el.pts);
  if (!bounds) return;
  // Capture base edges at drag start
  const baseLx = bounds.minX, baseTy = bounds.minY;
  const baseRx = bounds.maxX, baseBy = bounds.maxY;
  const MIN_SIZE = 10;
  let moved = false;

  const onMove = ev => {
    const p = svgPt(ev);
    const dx = p.x - startPt.x;
    const dy = p.y - startPt.y;
    let lx = baseLx, ty = baseTy, rx = baseRx, by = baseBy;

    // Apply delta to the relevant edges based on handle index
    // 0=TL 1=TC 2=TR 3=MR 4=BR 5=BC 6=BL 7=ML
    if (handleIdx === 0) { lx = snapV(baseLx+dx); ty = snapV(baseTy+dy); }
    else if (handleIdx === 1) { ty = snapV(baseTy+dy); }
    else if (handleIdx === 2) { rx = snapV(baseRx+dx); ty = snapV(baseTy+dy); }
    else if (handleIdx === 3) { rx = snapV(baseRx+dx); }
    else if (handleIdx === 4) { rx = snapV(baseRx+dx); by = snapV(baseBy+dy); }
    else if (handleIdx === 5) { by = snapV(baseBy+dy); }
    else if (handleIdx === 6) { lx = snapV(baseLx+dx); by = snapV(baseBy+dy); }
    else if (handleIdx === 7) { lx = snapV(baseLx+dx); }

    // Enforce minimum size
    if (rx - lx < MIN_SIZE) {
      if (handleIdx === 7 || handleIdx === 0 || handleIdx === 6) lx = rx - MIN_SIZE;
      else rx = lx + MIN_SIZE;
    }
    if (by - ty < MIN_SIZE) {
      if (handleIdx === 1 || handleIdx === 0 || handleIdx === 2) ty = by - MIN_SIZE;
      else by = ty + MIN_SIZE;
    }

    el.pts = [[lx, ty], [rx, ty], [rx, by], [lx, by]];
    moved = true;
    renderStructure();
    renderSelection();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    try { captureTarget?.releasePointerCapture(e.pointerId); } catch {}
    if (moved) {
      markDirty();
      showPropsFor(ed.selType, ed.selId);
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
  // Auto-select group siblings
  if (desk.group_id && !e.shiftKey && ld) {
    const siblings = ld.desks.filter(d => d.group_id === desk.group_id && d.id !== desk.id);
    if (siblings.length > 0) {
      ed.multiDeskIds = siblings.map(d => d.id);
      renderDesks();
      renderSelection();
    }
  }
  if (isDeskLocked(desk)) {
    edToast('Объект закреплён и не может быть перемещён', 'info');
    return;
  }

  const startPt = svgPt(e);
  const sx = desk.x;
  const sy = desk.y;
  let moved = false;
  const beforeSnap = _snapLd();

  const onMove = ev => {
    const p = svgPt(ev);
    moved = moved || Math.abs(p.x - startPt.x) > 0.2 || Math.abs(p.y - startPt.y) > 0.2;
    const snapped = computeSnapForRect(sx + p.x - startPt.x, sy + p.y - startPt.y, desk.w, desk.h, [desk.id]);
    desk.x = snapped.x;
    desk.y = snapped.y;
    ed.snapGuides = snapped.guides;
    _v('ep-x', Math.round(desk.x));
    _v('ep-y', Math.round(desk.y));
    renderDesks();
    renderSelection();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    ed.snapGuides = [];
    renderSelection();
    if (moved) { histPushSnap(beforeSnap); markDirty(); }
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
  const beforeSnap = _snapLd();
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
    histPushSnap(beforeSnap);
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
  histSnapshot();
  const { type, pts } = ed.drawing;
  ed.drawing = null;
  const layer = _layer('draw');
  if (layer) layer.innerHTML = '';

  if (pts.length < 2) return;

  const el = {
    id: uid(),
    pts,
    thick: type === 'wall' ? 8 : type === 'partition' ? 3 : 2,
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
    el.zone_type = DEFAULT_ZONE_TYPE;
    el.opacity = DEFAULT_ZONE_OPACITY;
  }

  if (type === 'wall')           ld.walls.push(el);
  else if (type === 'boundary')  ld.boundaries.push(el);
  else if (type === 'partition') ld.partitions.push(el);
  else return; // unknown type — discard

  markDirty();
  selectObj(type, el.id);
  renderStructure();
  updateStatusBar(); // reset hint to idle after finishing a line
}

/* ── Desk placement ─────────────────────────────────────────────────────────── */
function buildPlacementRects(anchor) {
  const { w, h } = defaultDeskSize();
  const { placeMode, colCount, rowCount, deskGap, rowGap, axis } = ed.deskTool;
  const cols = clampInt(colCount, 1, 100, 6);
  const rows = placeMode === 'block' ? clampInt(rowCount, 1, 50, 2) : 1;
  const gapDesk = deskGap !== null && deskGap >= 0 ? deskGap : w * 0.22;
  const gapRow  = rowGap  !== null && rowGap  >= 0 ? rowGap  : h * 0.8;
  const stepAlong = (axis === 'vertical' ? h : w) + gapDesk;
  const stepPerp  = (axis === 'vertical' ? w : h) + gapRow;
  const rects = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const along = c * stepAlong;
      const perp  = r * stepPerp;
      const x = axis === 'horizontal' ? anchor.x + along : anchor.x + perp;
      const y = axis === 'horizontal' ? anchor.y + perp  : anchor.y + along;
      rects.push({ x: snapV(x), y: snapV(y), w, h });
    }
  }
  return rects;
}

// Keep old name as alias for any callers
function buildDeskBlockRects(anchor, _orientation, _direction) {
  return buildPlacementRects(anchor);
}

function buildDeskPreviewAtPt(pt) {
  const anchor = { x: snapV(pt.x), y: snapV(pt.y) };
  const rects = buildPlacementRects(anchor);
  const existing = ld?.desks || [];
  let conflicts = 0;
  const desks = rects.map(r => {
    const conflict = existing.some(d => rectsOverlap(r, d));
    if (conflict) conflicts++;
    return { ...r, conflict };
  });
  return {
    anchor,
    desks,
    conflicts,
    overflow: (ld?.desks.length || 0) + rects.length > MAX_LAYOUT_DESKS,
    _cursorPt: pt,
  };
}

function updateDeskFloatPreview(pt) {
  if (!isDeskMultiMode() || !ld) return;
  ed.deskTool.preview = buildDeskPreviewAtPt(pt);
  syncDeskBulkControls();
  renderDrawing();
}

function cancelDeskBlockPreview() {
  if (!ed.deskTool.preview) return false;
  ed.deskTool.preview = null;
  syncDeskBulkControls();
  renderDrawing();
  return true;
}

function commitDeskFloatPreview() {
  if (!ld) return false;
  histSnapshot();
  const preview = ed.deskTool.preview;
  if (!preview?.desks?.length) return false;
  if (preview.overflow) {
    edToast(`Нельзя добавить: лимит ${MAX_LAYOUT_DESKS} мест на схему`, 'error');
    return false;
  }
  const groupId = uid();
  const groupLabel = ed.deskTool.groupLabel?.trim() || null;
  const { numScheme: scheme, numPrefix: prefix, numStart: start } = ed.deskTool;
  const labels = generateSequentialLabels(preview.desks.length, scheme, prefix, start);
  const inserted = preview.desks.map((r, i) => makeDeskRecord(
    { x: r.x, y: r.y, w: r.w, h: r.h },
    labels[i],
    groupId,
    groupLabel,
  ));
  ld.desks.push(...inserted);
  markDirty();
  renderAll();
  // Select all inserted desks
  if (inserted.length === 1) {
    selectObj('desk', inserted[0].id);
  } else if (inserted.length > 1) {
    ed.selType = 'desk';
    ed.selId = inserted[0].id;
    ed.multiDeskIds = inserted.slice(1).map(d => d.id);
    renderDesks();
    renderSelection();
    renderObjectList();
    showPropsFor('desk', inserted[0].id);
  }
  const conflicts = preview.conflicts;
  edToast(
    `Добавлено мест: ${inserted.length}${conflicts ? ` (конфликтов: ${conflicts})` : ''}`,
    conflicts ? 'info' : 'success',
  );
  updateEditorKpis();
  return true;
}

// Legacy aliases — keep for any remaining references
function rebuildDeskBlockPreview(pt) { updateDeskFloatPreview(pt); }
function startDeskBlockPreview(pt) { updateDeskFloatPreview(pt); }
function finalizeDeskBlockPreview() { return false; }
function commitDeskBlockPreview() { return commitDeskFloatPreview(); }

function placeDeskAt(pt) {
  if (!ld) return;
  if (ld.desks.length >= MAX_LAYOUT_DESKS) {
    // limit guard — no snapshot
    edToast(`Достигнут лимит ${MAX_LAYOUT_DESKS} мест`, 'error');
    return;
  }
  histSnapshot();
  const { w, h } = defaultDeskSize();
  const { numScheme: scheme, numPrefix: prefix, numStart: start } = ed.deskTool;
  const [label] = generateSequentialLabels(1, scheme, prefix, start);
  const desk = makeDeskRecord(
    { x: snapV(pt.x - w / 2), y: snapV(pt.y - h / 2), w, h },
    label,
  );
  ld.desks.push(desk);
  markDirty();
  selectObj('desk', desk.id);
  updateEditorKpis();
}

function ungroupDesks(groupId) {
  if (!ld || !groupId) return;
  histSnapshot();
  let count = 0;
  for (const d of ld.desks) {
    if (d.group_id === groupId) {
      d.group_id = null;
      d.group_label = null;
      count++;
    }
  }
  if (count) {
    markDirty();
    renderObjectList();
    renderDesks();
    edToast(`Разгруппировано: ${count} мест`, 'success');
  }
}

/* ── Multi-select operations ────────────────────────────────────────────────── */

function duplicateSelected() {
  if (!ld) return;
  histSnapshot();
  const OFFSET = 20;
  const ids = new Set([
    ...(ed.multiDeskIds || []),
    ...(ed.selType === 'desk' && ed.selId ? [ed.selId] : []),
  ]);
  if (!ids.size) { edToast('Ничего не выбрано', 'info'); return; }
  const used = collectDeskNumberSet();
  const newDesks = [];
  for (const d of (ld.desks || [])) {
    if (!ids.has(d.id)) continue;
    const nd = { ...d, id: uid(), x: d.x + OFFSET, y: d.y + OFFSET, group_id: null, group_label: null };
    nd.label = takeNextDeskLabel(used);
    newDesks.push(nd);
  }
  if (!newDesks.length) return;
  ld.desks.push(...newDesks);
  markDirty();
  ed.selType = 'desk';
  ed.selId = newDesks[0].id;
  ed.multiDeskIds = newDesks.slice(1).map(d => d.id);
  ed.multiStructKeys = [];
  renderAll();
  showPropsFor('desk', newDesks[0].id);
  edToast(`Дублировано: ${newDesks.length} мест`, 'success');
}

function groupSelectedDesks() {
  if (!ld) return;
  const ids = selectedDeskIds();
  if (ids.length < 2) { edToast('Выберите 2 или более места для группировки', 'info'); return; }
  histSnapshot();
  const gid = uid();
  for (const d of ld.desks) {
    if (ids.includes(d.id)) d.group_id = gid;
  }
  markDirty();
  renderObjectList();
  renderDesks();
  edToast(`Сгруппировано: ${ids.length} мест`, 'success');
}

function ungroupSelected() {
  if (!ld) return;
  histSnapshot();
  const ids = new Set(selectedDeskIds());
  const gids = new Set(
    (ld.desks || []).filter(d => ids.has(d.id) && d.group_id).map(d => d.group_id)
  );
  if (!gids.size) { edToast('Выбранные места не в группе', 'info'); return; }
  let count = 0;
  for (const d of ld.desks) {
    if (d.group_id && gids.has(d.group_id)) { d.group_id = null; d.group_label = null; count++; }
  }
  if (count) { markDirty(); renderObjectList(); renderDesks(); }
  edToast(`Разгруппировано: ${count} мест`, 'success');
}

function alignSelected(direction) {
  if (!ld) return;
  const desks = selectedDeskRecords().filter(d => !isDeskLocked(d));
  if (desks.length < 2) { edToast('Выберите 2 или более места для выравнивания', 'info'); return; }
  histSnapshot();
  const minX = Math.min(...desks.map(d => d.x));
  const minY = Math.min(...desks.map(d => d.y));
  const maxX = Math.max(...desks.map(d => d.x + d.w));
  const maxY = Math.max(...desks.map(d => d.y + d.h));
  for (const d of desks) {
    if (direction === 'left')   d.x = snapV(minX);
    if (direction === 'right')  d.x = snapV(maxX - d.w);
    if (direction === 'center') d.x = snapV((minX + maxX) / 2 - d.w / 2);
    if (direction === 'top')    d.y = snapV(minY);
    if (direction === 'bottom') d.y = snapV(maxY - d.h);
    if (direction === 'middle') d.y = snapV((minY + maxY) / 2 - d.h / 2);
  }
  markDirty(); renderDesks(); renderSelection();
}

function distributeSelected(axis) {
  if (!ld) return;
  const desks = selectedDeskRecords().filter(d => !isDeskLocked(d));
  if (desks.length < 3) { edToast('Выберите 3 или более места для распределения', 'info'); return; }
  histSnapshot();
  if (axis === 'h') {
    const sorted = [...desks].sort((a, b) => (a.x + a.w / 2) - (b.x + b.w / 2));
    const span = (sorted.at(-1).x + sorted.at(-1).w / 2) - (sorted[0].x + sorted[0].w / 2);
    const step = span / (sorted.length - 1);
    const startCx = sorted[0].x + sorted[0].w / 2;
    for (let i = 1; i < sorted.length - 1; i++) {
      sorted[i].x = snapV(startCx + i * step - sorted[i].w / 2);
    }
  } else {
    const sorted = [...desks].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    const span = (sorted.at(-1).y + sorted.at(-1).h / 2) - (sorted[0].y + sorted[0].h / 2);
    const step = span / (sorted.length - 1);
    const startCy = sorted[0].y + sorted[0].h / 2;
    for (let i = 1; i < sorted.length - 1; i++) {
      sorted[i].y = snapV(startCy + i * step - sorted[i].h / 2);
    }
  }
  markDirty(); renderDesks(); renderSelection();
}

function selectAll() {
  if (!ld || ed.mode !== 'select') return;
  const deskIds = (ld.desks || []).map(d => d.id);
  if (!deskIds.length) return;
  ed.selType = 'desk';
  ed.selId = deskIds[0];
  ed.multiDeskIds = deskIds.slice(1);
  ed.multiStructKeys = [];
  renderDesks();
  renderSelection();
  renderObjectList();
  showPropsFor('desk', deskIds[0]);
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
  if (ed.boundaryDrag && mode !== 'boundary') {
    ed.boundaryDrag = null;
  }
  if (mode !== 'door') {
    ed.doorPreview = null;
  }
  if (mode !== 'desk') {
    cancelDeskBlockPreview();
  }
  if (ed.bgAdjust.active) {
    setBackgroundAdjustMode(false);
  }
  ed.mode = mode;

  // Reset SVG cursor when leaving door mode
  const svg = _svg();
  if (svg && mode !== 'door') svg.style.cursor = '';

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

    histReset();
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

/* ── Layout validation ───────────────────────────────────────────────────────
 *  validateLayout() → array of { type:'error'|'warning', code, message,
 *                                 objectType, objectId, relatedId? }
 * ────────────────────────────────────────────────────────────────────────── */
function validateLayout() {
  const issues = [];
  if (!ld) return issues;

  const canvas   = getCanvasRect();
  const desks    = ld.desks      || [];
  const walls    = ld.walls      || [];
  const parts    = ld.partitions || [];
  const bounds   = ld.boundaries || [];
  const doors    = ld.doors      || [];

  // ── 1. At least one desk ─────────────────────────────────────────────────
  if (desks.length === 0) {
    issues.push({ type: 'error', code: 'no_desks',
      message: 'На плане нет ни одного рабочего места',
      objectType: null, objectId: null });
  }

  // ── 2. Duplicate labels ──────────────────────────────────────────────────
  const labelMap = new Map();
  for (const d of desks) {
    const lbl = (d.label || '').trim();
    if (!lbl) continue;
    if (!labelMap.has(lbl)) labelMap.set(lbl, []);
    labelMap.get(lbl).push(d);
  }
  for (const [lbl, dups] of labelMap) {
    if (dups.length > 1) {
      for (const d of dups) {
        issues.push({ type: 'error', code: 'dup_label',
          message: `Дублирующийся ярлык «${lbl}»`,
          objectType: 'desk', objectId: d.id });
      }
    }
  }

  // ── 3. Doors without valid wall attachment ───────────────────────────────
  const allStructIds = new Set([...walls.map(w => w.id), ...parts.map(p => p.id)]);
  for (const door of doors) {
    if (!isNewDoor(door)) continue;
    if (!door.wallId || !allStructIds.has(door.wallId)) {
      const lbl = door.wallId ? 'стена удалена' : 'без привязки';
      issues.push({ type: 'warning', code: 'door_unattached',
        message: `Дверь не привязана к стене (${lbl})`,
        objectType: 'door', objectId: door.id });
    }
  }

  // ── 4. Overlapping desks ─────────────────────────────────────────────────
  const reportedPairs = new Set();
  for (let i = 0; i < desks.length; i++) {
    for (let j = i + 1; j < desks.length; j++) {
      if (rectsOverlap(desks[i], desks[j])) {
        const key = desks[i].id + ':' + desks[j].id;
        if (!reportedPairs.has(key)) {
          reportedPairs.add(key);
          const l1 = desks[i].label || desks[i].id.slice(0, 6);
          const l2 = desks[j].label || desks[j].id.slice(0, 6);
          issues.push({ type: 'warning', code: 'desk_overlap',
            message: `Пересечение мест: ${l1} и ${l2}`,
            objectType: 'desk', objectId: desks[i].id, relatedId: desks[j].id });
        }
      }
    }
  }

  // ── 5. Objects outside canvas bounds ────────────────────────────────────
  const cx2 = canvas.x + canvas.w, cy2 = canvas.y + canvas.h;

  for (const d of desks) {
    if (d.x < canvas.x || d.y < canvas.y || d.x + d.w > cx2 || d.y + d.h > cy2) {
      issues.push({ type: 'warning', code: 'out_of_bounds',
        message: `Место «${d.label || d.id.slice(0, 6)}» вне рабочей области`,
        objectType: 'desk', objectId: d.id });
    }
  }

  const structEntries = [
    ...walls.map(s   => ({ type: 'wall',      label: 'Стена',        el: s })),
    ...parts.map(s   => ({ type: 'partition', label: 'Перегородка',  el: s })),
    ...bounds.map(s  => ({ type: 'boundary',  label: 'Зона',         el: s })),
  ];
  for (const { type, label, el } of structEntries) {
    if (!el.pts?.length) continue;
    if (el.pts.some(p => p[0] < canvas.x || p[1] < canvas.y || p[0] > cx2 || p[1] > cy2)) {
      issues.push({ type: 'warning', code: 'out_of_bounds',
        message: `${label} частично вне рабочей области`,
        objectType: type, objectId: el.id });
    }
  }

  return issues;
}

/* ── Jump to object ──────────────────────────────────────────────────────── */
function jumpToObject(type, id) {
  if (!ld || !id) return;
  selectObj(type, id);
  let rect = null;
  if (type === 'desk') {
    const d = (ld.desks || []).find(x => x.id === id);
    if (d) rect = { x: d.x, y: d.y, w: d.w, h: d.h };
  } else if (type === 'door') {
    const d = (ld.doors || []).find(x => x.id === id);
    if (d && isNewDoor(d)) {
      const hw = (d.width || 50) / 2;
      rect = { x: d.cx - hw, y: d.cy - hw, w: d.width || 50, h: d.width || 50 };
    }
  } else {
    const arr = structArrayByType(type);
    const el = arr?.find(x => x.id === id);
    if (el?.pts) {
      const b = pointsBounds(el.pts);
      if (b) rect = { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
    }
  }
  if (!rect) return;
  // Zoom to show the object with generous padding
  const dim = Math.max(rect.w, rect.h, 40);
  const pad = dim * 2;
  setVb(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2);
}

/* ── Validation panel UI ─────────────────────────────────────────────────── */
let _valOnPublish = null;  // callback set when panel is opened from publish flow

function showValidationPanel(issues, onPublish) {
  _valOnPublish = onPublish || null;

  const errors   = issues.filter(i => i.type === 'error');
  const warnings = issues.filter(i => i.type === 'warning');
  const hasErrors = errors.length > 0;

  // Title + subtitle
  const titleEl = document.getElementById('ed-val-title');
  const subtEl  = document.getElementById('ed-val-subtitle');
  if (titleEl) {
    titleEl.textContent = hasErrors
      ? `Ошибки: ${errors.length}${warnings.length ? `, предупреждения: ${warnings.length}` : ''}`
      : `Предупреждения: ${warnings.length}`;
    titleEl.style.color = hasErrors ? 'var(--color-danger, #dc2626)' : '#b45309';
  }
  if (subtEl) {
    subtEl.textContent = hasErrors
      ? 'Исправьте ошибки перед публикацией.'
      : 'Можно опубликовать, игнорируя предупреждения.';
  }

  // Issue list
  const list = document.getElementById('ed-val-list');
  if (list) {
    list.innerHTML = '';

    const ICONS = { error: '✖', warning: '⚠' };
    const TYPE_LABELS = { desk: 'Место', door: 'Дверь', wall: 'Стена', partition: 'Перегородка', boundary: 'Зона' };

    for (const issue of [...errors, ...warnings]) {
      const row = document.createElement('div');
      row.className = `ed-val-item ed-val-${issue.type}`;
      const clickable = !!(issue.objectId);
      if (clickable) row.classList.add('ed-val-clickable');

      const typeTag = issue.objectType ? `<span class="ed-val-tag">${TYPE_LABELS[issue.objectType] || issue.objectType}</span>` : '';
      row.innerHTML = `
        <span class="ed-val-icon">${ICONS[issue.type]}</span>
        <span class="ed-val-msg">${issue.message}${typeTag}</span>
        ${clickable ? '<span class="ed-val-jump" title="Перейти к объекту">→</span>' : ''}
      `;

      if (clickable) {
        row.addEventListener('click', () => {
          hideValidationPanel();
          jumpToObject(issue.objectType, issue.objectId);
          // Also highlight related if overlap pair
          if (issue.relatedId && issue.objectType === 'desk') {
            ed.multiDeskIds = [issue.relatedId];
            renderDesks();
            renderSelection();
          }
        });
      }
      list.appendChild(row);
    }

    if (issues.length === 0) {
      list.innerHTML = '<div class="ed-val-ok">✔ Ошибок не обнаружено — план готов к публикации.</div>';
    }
  }

  // "Publish anyway" button — only when no hard errors and caller provided onPublish
  const publishBtn = document.getElementById('ed-val-publish-anyway');
  if (publishBtn) {
    const show = !hasErrors && !!onPublish;
    publishBtn.classList.toggle('ed-hidden', !show);
  }

  document.getElementById('ed-val-overlay')?.classList.remove('ed-hidden');
}

function hideValidationPanel() {
  document.getElementById('ed-val-overlay')?.classList.add('ed-hidden');
  _valOnPublish = null;
}

function initValidationPanel() {
  document.getElementById('ed-val-close')?.addEventListener('click', hideValidationPanel);
  document.getElementById('ed-val-cancel')?.addEventListener('click', hideValidationPanel);
  document.getElementById('ed-val-overlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('ed-val-overlay')) hideValidationPanel();
  });
  document.getElementById('ed-val-publish-anyway')?.addEventListener('click', () => {
    const cb = _valOnPublish;
    hideValidationPanel();
    if (cb) cb();
  });
  document.getElementById('ed-validate-btn')?.addEventListener('click', () => {
    if (!ld) { edToast('Загрузите этаж перед проверкой', 'info'); return; }
    const issues = validateLayout();
    showValidationPanel(issues, null);
  });
}
/* ─────────────────────────────────────────────────────────────────────────── */

async function edPublish() {
  if (!ed.floorId) return;
  if (!ed.dirty && ed.status !== 'draft') {
    edToast('Нет черновика для публикации. Внесите изменения и сохраните.', 'info');
    return;
  }

  // Validate before publishing
  const issues = validateLayout();
  const errors = issues.filter(i => i.type === 'error');
  if (issues.length > 0) {
    // If there are hard errors, show panel — user must fix them.
    // If only warnings, show panel with "publish anyway" button.
    showValidationPanel(issues, errors.length === 0 ? _doPublish : null);
    return;
  }

  // No issues — proceed with confirmation
  if (!confirm('Опубликовать план? Клиенты увидят изменения.')) return;
  await _doPublish();
}

async function _doPublish() {
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

  updateEmptyState();
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
        if (isDeskMultiMode() && ed.deskTool.preview?._cursorPt) {
          updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
        }
        updateStatusBar();
      }
      return;
    }
    if (e.key === 'Shift') {
      if (!ed.shiftDown) ed.shiftDown = true;
      if (!isDrawMode(ed.mode) && !ed.shiftFine) {
        ed.shiftFine = true;
        if (isDeskMultiMode() && ed.deskTool.preview?._cursorPt) {
          updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
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

    // Ctrl/Cmd shortcuts
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); histUndo(); return; }
      if (k === 'z' &&  e.shiftKey) { e.preventDefault(); histRedo(); return; }
      if (k === 'y')                { e.preventDefault(); histRedo(); return; }
      if (k === 'd') { e.preventDefault(); duplicateSelected(); return; }
      if (k === 'g' && !e.shiftKey) { e.preventDefault(); groupSelectedDesks(); return; }
      if (k === 'g' &&  e.shiftKey) { e.preventDefault(); ungroupSelected(); return; }
      if (k === 'a') { e.preventDefault(); selectAll(); return; }
    }

    switch (e.key) {
      case 'v': case 'V': setMode('select');    break;
      case 'h': case 'H': setMode('pan');       break;
      case 'w': case 'W': setMode('wall');      break;
      case 'b': case 'B': setMode('boundary');  break;
      case 'p': case 'P': setMode('partition'); break;
      case 'o': case 'O': setMode('door');      break;
      case 'd': case 'D': setMode('desk');      break;
      case 'f': case 'F': fitToScreen();         break;
      case 's': case 'S': {
        // Toggle smart snap (objects + walls together)
        const nextSnap = !(ed.snapToObjects && ed.snapToWalls);
        ed.snapToObjects = nextSnap;
        ed.snapToWalls = nextSnap;
        $el('ed-snap-obj-btn')?.classList.toggle('active', nextSnap);
        $el('ed-snap-wall-btn')?.classList.toggle('active', nextSnap);
        edToast('Умная привязка: ' + (nextSnap ? 'вкл' : 'выкл'), 'info');
        updateStatusBar();
        break;
      }
      case 'r': case 'R':
        if (ed.mode === 'desk') {
          ed.deskTool.axis = ed.deskTool.axis === 'vertical' ? 'horizontal' : 'vertical';
          _v('ed-desk-block-axis', ed.deskTool.axis);
          if (ed.deskTool.preview?._cursorPt) {
            updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
          }
          syncDeskBulkControls();
          renderDrawing();
          updateStatusBar();
          edToast(`Ориентация: ${ed.deskTool.axis === 'horizontal' ? 'горизонтально' : 'вертикально'}`, 'info');
        } else if (ed.mode === 'door') {
          ed.doorFlip = !ed.doorFlip;
          renderDrawing();
          updateStatusBar(); // update the flip direction indicator in hint
        } else if (ed.mode === 'select' && ed.selType === 'door' && ed.selId) {
          const door = (ld?.doors || []).find(x => x.id === ed.selId);
          if (door && isNewDoor(door) && !door.locked) {
            door.flip = !door.flip;
            markDirty();
            renderStructure();
            showPropsFor('door', ed.selId);
          }
        }
        break;
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
        if (isDeskMultiMode() && ed.deskTool.preview?._cursorPt) {
          updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
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
        // Area tool: cancel in-progress drag, stay in mode for next draw
        if (ed.boundaryDrag) {
          ed.boundaryDrag = null; renderDrawing(); updateStatusBar(); break;
        }
        // Line tools: cancel in-progress segment, stay in mode for next line
        if (ed.drawing) {
          ed.drawing = null; const l = _layer('draw'); if (l) l.innerHTML = ''; updateStatusBar(); break;
        }
        // Object tools (door, desk): Esc exits tool → select mode
        if (OBJECT_TOOLS.includes(ed.mode)) {
          if (ed.doorPreview) { ed.doorPreview = null; renderDrawing(); }
          setMode('select'); break;
        }
        // Area/Line tools idle: Esc exits to select
        if ([...LINE_TOOLS, ...AREA_TOOLS].includes(ed.mode)) { setMode('select'); break; }
        if (ed.marquee) { ed.marquee = null; renderSelection(); }
        else deselect();
        break;
      case 'Enter':
        if (commitDeskBlockPreview()) break;
        if (ed.drawing) finishDrawing(false);
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
      if (isDeskMultiMode() && ed.deskTool.preview?._cursorPt) {
        updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
      }
      updateStatusBar();
      return;
    }
    if (e.key === 'Shift') {
      ed.shiftDown = false;
      ed.shiftFine = false;
      if (isDeskMultiMode() && ed.deskTool.preview?._cursorPt) {
        updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
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
    if (isDeskMultiMode() && ed.deskTool.preview?._cursorPt) {
      updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
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
    const rawMode = $el('ed-desk-place-mode')?.value || 'single';
    const nextMode = ['single', 'row', 'block'].includes(rawMode) ? rawMode : 'single';
    const wasMulti = isDeskMultiMode();
    const baseSize = baseDeskSize();
    const maxW = Math.max(120, baseSize.w * 8);
    const maxH = Math.max(90, baseSize.h * 8);

    ed.deskTool.placeMode = nextMode;
    ed.deskTool.axis = $el('ed-desk-block-axis')?.value === 'vertical' ? 'vertical' : 'horizontal';
    ed.deskTool.deskW = clampNum($el('ed-desk-width')?.value, 4, maxW, ed.deskTool.deskW ?? baseSize.w);
    ed.deskTool.deskH = clampNum($el('ed-desk-height')?.value, 4, maxH, ed.deskTool.deskH ?? baseSize.h);
    ed.deskTool.colCount = clampInt($el('ed-desk-col-count')?.value, 1, 100, ed.deskTool.colCount || 6);
    ed.deskTool.rowCount = clampInt($el('ed-desk-row-count')?.value, 1, 50, ed.deskTool.rowCount || 2);
    const rawDeskGap = $el('ed-desk-gap')?.value;
    ed.deskTool.deskGap = rawDeskGap !== '' && rawDeskGap !== undefined ? clampNum(rawDeskGap, 0, 200, null) : null;
    const rawRowGap = $el('ed-desk-row-gap')?.value;
    ed.deskTool.rowGap = rawRowGap !== '' && rawRowGap !== undefined ? clampNum(rawRowGap, 0, 200, null) : null;
    ed.deskTool.groupLabel = ($el('ed-desk-group-label')?.value || '').trim();

    // Numbering scheme
    const rawScheme = $el('ed-desk-num-scheme')?.value || 'D-N';
    ed.deskTool.numScheme = ['D-N', 'A-N', 'N', 'Rm-N', 'custom'].includes(rawScheme) ? rawScheme : 'D-N';
    ed.deskTool.numPrefix = ($el('ed-desk-num-prefix')?.value || '').trim();
    const rawStart = $el('ed-desk-num-start')?.value;
    const parsedStart = rawStart !== '' && rawStart !== undefined ? parseInt(rawStart, 10) : NaN;
    ed.deskTool.numStart = Number.isFinite(parsedStart) && parsedStart >= 1 ? parsedStart : null;
    $el('ed-desk-num-prefix-field')?.classList.toggle('ed-hidden', ed.deskTool.numScheme !== 'custom');

    if (wasMulti && !isDeskMultiMode()) {
      cancelDeskBlockPreview();
    } else if (isDeskMultiMode() && ed.deskTool.preview?._cursorPt) {
      updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
    }

    syncDeskBulkControls();
    updateStatusBar();
    renderDrawing();
  };

  ['ed-desk-place-mode', 'ed-desk-block-axis', 'ed-desk-width', 'ed-desk-height',
   'ed-desk-col-count', 'ed-desk-row-count', 'ed-desk-gap', 'ed-desk-row-gap', 'ed-desk-group-label',
   'ed-desk-num-scheme', 'ed-desk-num-prefix', 'ed-desk-num-start']
    .forEach(id => {
      $el(id)?.addEventListener('change', apply);
      $el(id)?.addEventListener('input', apply);
    });

  // Renumber button in multi-desk panel
  $el('ep-renumber-btn')?.addEventListener('click', renumberSelected);

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
  $el('ed-undo-btn')?.addEventListener('click', histUndo);
  $el('ed-redo-btn')?.addEventListener('click', histRedo);
  $el('ed-fit-btn')?.addEventListener('click', fitToScreen);
  $el('ed-sync-bg-btn')?.addEventListener('click', syncCanvasToBackground);
  $el('ed-bg-adjust-btn')?.addEventListener('click', toggleBackgroundAdjustMode);
  $el('ed-clear-bg-btn')?.addEventListener('click', clearBackground);
  $el('ed-sync-desks-btn')?.addEventListener('click', syncDesksFromLayout);
  $el('ed-grid-btn')?.addEventListener('click', () => {
    ed.snapGrid = !ed.snapGrid;
    document.getElementById('ed-grid-rect')?.style.setProperty('display', ed.snapGrid ? '' : 'none');
    $el('ed-grid-btn')?.classList.toggle('active', ed.snapGrid);
    if (isDeskMultiMode() && ed.deskTool.preview?._cursorPt) {
      updateDeskFloatPreview(ed.deskTool.preview._cursorPt);
    }
    updateStatusBar();
  });
  $el('ed-snap-obj-btn')?.addEventListener('click', () => {
    ed.snapToObjects = !ed.snapToObjects;
    $el('ed-snap-obj-btn')?.classList.toggle('active', ed.snapToObjects);
    updateStatusBar();
  });
  $el('ed-snap-wall-btn')?.addEventListener('click', () => {
    ed.snapToWalls = !ed.snapToWalls;
    $el('ed-snap-wall-btn')?.classList.toggle('active', ed.snapToWalls);
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
    svg.addEventListener('pointerdown',  onSvgPointerDown);
    svg.addEventListener('pointermove',  onSvgPointerMove);
    svg.addEventListener('pointerup',    onSvgPointerUp);
    svg.addEventListener('click',        onSvgClick);
    svg.addEventListener('dblclick',     onSvgDblClick);
    svg.addEventListener('pointerleave', () => {
      if (ed.doorPreview) { ed.doorPreview = null; renderDrawing(); }
    });
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
  initValidationPanel();
  initEditorKeyboard();
  initCollapsePanels();
  initEditorTooltips();
  initOnboarding();
  updateEditorUI();
  updateStatusBar();
  updateEditorKpis();
  updateLockUI();
}

/* ── Empty state ─────────────────────────────────────────────────────────── */

function updateEmptyState() {
  const el = $el('ed-empty-state');
  if (!el) return;
  el.classList.toggle('ed-hidden', !!ed.floorId);
}

/* ── Floating tooltips ───────────────────────────────────────────────────── */

function initEditorTooltips() {
  const tip = $el('ed-tip');
  if (!tip) return;

  let hideTimer = null;

  document.querySelectorAll('[data-ed-tip]').forEach(btn => {
    btn.addEventListener('mouseenter', e => {
      clearTimeout(hideTimer);
      const titleText = btn.dataset.edTip || '';
      const descText  = btn.dataset.edTipDesc || '';
      $el('ed-tip-title').textContent = titleText;
      $el('ed-tip-desc').textContent  = descText;
      positionTip(tip, e);
      tip.classList.add('visible');
    });
    btn.addEventListener('mousemove', e => positionTip(tip, e));
    btn.addEventListener('mouseleave', () => {
      hideTimer = setTimeout(() => tip.classList.remove('visible'), 80);
    });
  });
}

function positionTip(tip, e) {
  const GAP = 10;
  const tw = tip.offsetWidth  || 260;
  const th = tip.offsetHeight || 60;
  let x = e.clientX + GAP;
  let y = e.clientY + GAP + 18;
  if (x + tw > window.innerWidth  - 8) x = e.clientX - tw - GAP;
  if (y + th > window.innerHeight - 8) y = e.clientY - th - GAP;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}

/* ── Onboarding ──────────────────────────────────────────────────────────── */

const ONBOARDING_KEY = 'ed_onboarded_v1';

function initOnboarding() {
  // Wire empty-state buttons
  $el('ed-empty-upload-btn')?.addEventListener('click', () => {
    // Open the upload plan modal from admin.js context (shared global)
    if (typeof openUploadPlanModal === 'function') {
      openUploadPlanModal(ed.floorId || null);
    } else {
      // Fallback: open floor select list or show admin panel
      const sel = $el('ed-floor-select');
      if (sel) sel.focus();
    }
  });

  $el('ed-empty-tour-btn')?.addEventListener('click', showEdOnboarding);
  $el('ed-ob-skip')?.addEventListener('click', hideEdOnboarding);
  $el('ed-ob-prev')?.addEventListener('click', () => setObStep(_obStep - 1));
  $el('ed-ob-next')?.addEventListener('click', () => {
    if (_obStep < 2) {
      setObStep(_obStep + 1);
    } else {
      hideEdOnboarding();
    }
  });
  $el('ed-onboarding-overlay')?.addEventListener('click', e => {
    if (e.target?.id === 'ed-onboarding-overlay') hideEdOnboarding();
  });

  if (!localStorage.getItem(ONBOARDING_KEY)) {
    showEdOnboarding();
  }
}

let _obStep = 0;

function showEdOnboarding() {
  _obStep = 0;
  setObStep(0);
  $el('ed-onboarding-overlay')?.classList.remove('ed-hidden');
}

function hideEdOnboarding() {
  $el('ed-onboarding-overlay')?.classList.add('ed-hidden');
  localStorage.setItem(ONBOARDING_KEY, '1');
}

function setObStep(step) {
  const total = 3;
  _obStep = Math.max(0, Math.min(total - 1, step));

  document.querySelectorAll('.ed-ob-slide').forEach(s => {
    s.classList.toggle('active', Number(s.dataset.step) === _obStep);
  });
  document.querySelectorAll('.ed-ob-dot').forEach(d => {
    d.classList.toggle('active', Number(d.dataset.step) === _obStep);
  });

  const prevBtn = $el('ed-ob-prev');
  const nextBtn = $el('ed-ob-next');
  if (prevBtn) prevBtn.disabled = _obStep === 0;
  if (nextBtn) nextBtn.textContent = _obStep === total - 1 ? 'Готово ✓' : 'Далее →';
}
