"""Classify SVG elements into floor structure categories (walls/boundaries/partitions/doors).

Uses only stdlib — no external deps.
"""
from __future__ import annotations

import math
import re
import uuid
import xml.etree.ElementTree as ET
from typing import Optional

from . import schemas

_SVG_NS = "http://www.w3.org/2000/svg"
_TRANSFORM_FN_RE = re.compile(r"([A-Za-z]+)\s*\(([^)]*)\)")
_NUM_RE = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")
_PATH_TOKEN_RE = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")
_GEOM_TAGS = {"line", "polyline", "polygon", "rect", "path"}
_SKIP_CONTAINER_TAGS = {"defs", "symbol", "marker", "clippath", "mask", "pattern"}


def _local(tag: str) -> str:
    return tag.split("}")[-1] if "}" in tag else tag


def _attr(el: ET.Element, name: str) -> Optional[str]:
    return el.get(name) or el.get(f"{{{_SVG_NS}}}{name}")


def _stroke_width(el: ET.Element) -> float:
    """Extract stroke-width from element or style attr."""
    stroke = (el.get("stroke") or "").strip().lower()
    style_stroke = (_style_prop(el, "stroke") or "").strip().lower()
    if (not stroke or stroke == "none") and (not style_stroke or style_stroke == "none"):
        return 0.0

    sw = el.get("stroke-width")
    if sw is None:
        sw = _style_prop(el, "stroke-width")
    try:
        return float(sw) if sw else 1.0
    except ValueError:
        return 1.0


def _style_prop(el: ET.Element, name: str) -> Optional[str]:
    style = el.get("style", "")
    if not style:
        return None
    pattern = re.compile(rf"{re.escape(name)}\s*:\s*([^;]+)")
    m = pattern.search(style)
    if not m:
        return None
    return m.group(1).strip()


def _has_stroke(el: ET.Element) -> bool:
    stroke = (el.get("stroke") or "").strip().lower()
    if stroke and stroke != "none":
        return True
    style_stroke = (_style_prop(el, "stroke") or "").strip().lower()
    return bool(style_stroke and style_stroke != "none")


def _has_fill(el: ET.Element) -> bool:
    fill = (el.get("fill") or "").strip().lower()
    style_fill = (_style_prop(el, "fill") or "").strip().lower()
    if style_fill == "none":
        return False
    if fill == "none":
        return False
    if style_fill:
        return True
    return bool(fill)


def _parse_viewbox(root: ET.Element) -> list[float]:
    vb = root.get("viewBox") or root.get("viewbox") or ""
    parts = re.split(r"[\s,]+", vb.strip())
    try:
        if len(parts) >= 4:
            return [float(p) for p in parts[:4]]
    except ValueError:
        pass
    w = float(root.get("width") or 1000)
    h = float(root.get("height") or 1000)
    return [0.0, 0.0, w, h]


def _line_pts(el: ET.Element) -> list[list[float]]:
    try:
        x1 = float(el.get("x1") or 0)
        y1 = float(el.get("y1") or 0)
        x2 = float(el.get("x2") or 0)
        y2 = float(el.get("y2") or 0)
        return [[x1, y1], [x2, y2]]
    except (TypeError, ValueError):
        return []


def _polyline_pts(el: ET.Element) -> list[list[float]]:
    pts_str = el.get("points") or ""
    nums = re.split(r"[\s,]+", pts_str.strip())
    result: list[list[float]] = []
    i = 0
    while i + 1 < len(nums):
        try:
            result.append([float(nums[i]), float(nums[i + 1])])
        except ValueError:
            pass
        i += 2
    return result


def _rect_pts(el: ET.Element) -> list[list[float]]:
    try:
        x = float(el.get("x") or 0)
        y = float(el.get("y") or 0)
        w = float(el.get("width") or 0)
        h = float(el.get("height") or 0)
        return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    except (TypeError, ValueError):
        return []


def _path_is_closed(d: str) -> bool:
    return bool(re.search(r"[Zz]", d))


def _path_approx_pts(d: str) -> list[list[float]]:
    """Approximate path by its command endpoints.

    Supports all common SVG path commands and tracks only segment end points.
    """
    pts: list[list[float]] = []
    cx, cy = 0.0, 0.0
    sx, sy = 0.0, 0.0
    cmd = ""
    tokens = _PATH_TOKEN_RE.findall(d)
    i = 0

    def is_cmd(tok: str) -> bool:
        return bool(re.fullmatch(r"[MmLlHhVvCcSsQqTtAaZz]", tok))

    def take_float(tok: str) -> float:
        return float(tok)

    while i < len(tokens):
        tok = tokens[i]
        if is_cmd(tok):
            cmd = tok
            i += 1
            if cmd in ("Z", "z"):
                cx, cy = sx, sy
                pts.append([cx, cy])
                continue
        elif not cmd:
            i += 1
            continue

        if cmd in ("M", "m"):
            first = True
            while i + 1 < len(tokens) and not is_cmd(tokens[i]):
                x = take_float(tokens[i]); y = take_float(tokens[i + 1])
                i += 2
                if cmd == "m":
                    x += cx; y += cy
                cx, cy = x, y
                if first:
                    sx, sy = cx, cy
                    first = False
                pts.append([cx, cy])
                cmd = "l" if cmd == "m" else "L"
            continue

        if cmd in ("L", "l"):
            while i + 1 < len(tokens) and not is_cmd(tokens[i]):
                x = take_float(tokens[i]); y = take_float(tokens[i + 1])
                i += 2
                if cmd == "l":
                    x += cx; y += cy
                cx, cy = x, y
                pts.append([cx, cy])
            continue

        if cmd in ("H", "h"):
            while i < len(tokens) and not is_cmd(tokens[i]):
                x = take_float(tokens[i]); i += 1
                cx = cx + x if cmd == "h" else x
                pts.append([cx, cy])
            continue

        if cmd in ("V", "v"):
            while i < len(tokens) and not is_cmd(tokens[i]):
                y = take_float(tokens[i]); i += 1
                cy = cy + y if cmd == "v" else y
                pts.append([cx, cy])
            continue

        if cmd in ("C", "c"):
            while i + 5 < len(tokens) and not is_cmd(tokens[i]):
                # Keep only endpoint of cubic segment (x, y)
                x = take_float(tokens[i + 4]); y = take_float(tokens[i + 5])
                i += 6
                if cmd == "c":
                    x += cx; y += cy
                cx, cy = x, y
                pts.append([cx, cy])
            continue

        if cmd in ("S", "s", "Q", "q"):
            step = 4
            while i + step - 1 < len(tokens) and not is_cmd(tokens[i]):
                x = take_float(tokens[i + step - 2]); y = take_float(tokens[i + step - 1])
                i += step
                if cmd in ("s", "q"):
                    x += cx; y += cy
                cx, cy = x, y
                pts.append([cx, cy])
            continue

        if cmd in ("T", "t"):
            while i + 1 < len(tokens) and not is_cmd(tokens[i]):
                x = take_float(tokens[i]); y = take_float(tokens[i + 1])
                i += 2
                if cmd == "t":
                    x += cx; y += cy
                cx, cy = x, y
                pts.append([cx, cy])
            continue

        if cmd in ("A", "a"):
            while i + 6 < len(tokens) and not is_cmd(tokens[i]):
                # Arc endpoint: last pair in a 7-arg arc segment.
                x = take_float(tokens[i + 5]); y = take_float(tokens[i + 6])
                i += 7
                if cmd == "a":
                    x += cx; y += cy
                cx, cy = x, y
                pts.append([cx, cy])
            continue

        # Unknown/invalid command token sequence: move forward defensively.
        i += 1

    return pts


def _mat_mul(m1: tuple[float, float, float, float, float, float], m2: tuple[float, float, float, float, float, float]) -> tuple[float, float, float, float, float, float]:
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def _transform_translate(tx: float, ty: float) -> tuple[float, float, float, float, float, float]:
    return (1.0, 0.0, 0.0, 1.0, tx, ty)


def _transform_scale(sx: float, sy: float) -> tuple[float, float, float, float, float, float]:
    return (sx, 0.0, 0.0, sy, 0.0, 0.0)


def _transform_rotate(deg: float) -> tuple[float, float, float, float, float, float]:
    rad = math.radians(deg)
    cos_v = float(math.cos(rad))
    sin_v = float(math.sin(rad))
    return (cos_v, sin_v, -sin_v, cos_v, 0.0, 0.0)


def _transform_skew_x(deg: float) -> tuple[float, float, float, float, float, float]:
    rad = math.radians(deg)
    t = float(math.tan(rad))
    return (1.0, 0.0, t, 1.0, 0.0, 0.0)


def _transform_skew_y(deg: float) -> tuple[float, float, float, float, float, float]:
    rad = math.radians(deg)
    t = float(math.tan(rad))
    return (1.0, t, 0.0, 1.0, 0.0, 0.0)


def _parse_transform(el: ET.Element) -> tuple[float, float, float, float, float, float]:
    raw = (el.get("transform") or "").strip()
    if not raw:
        return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

    out = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for fn, args in _TRANSFORM_FN_RE.findall(raw):
        nums = [float(n) for n in _NUM_RE.findall(args)]
        name = fn.strip().lower()
        cur = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
        if name == "matrix" and len(nums) >= 6:
            cur = (nums[0], nums[1], nums[2], nums[3], nums[4], nums[5])
        elif name == "translate":
            tx = nums[0] if nums else 0.0
            ty = nums[1] if len(nums) > 1 else 0.0
            cur = _transform_translate(tx, ty)
        elif name == "scale":
            sx = nums[0] if nums else 1.0
            sy = nums[1] if len(nums) > 1 else sx
            cur = _transform_scale(sx, sy)
        elif name == "rotate":
            ang = nums[0] if nums else 0.0
            if len(nums) >= 3:
                cx, cy = nums[1], nums[2]
                cur = _mat_mul(
                    _transform_translate(cx, cy),
                    _mat_mul(_transform_rotate(ang), _transform_translate(-cx, -cy)),
                )
            else:
                cur = _transform_rotate(ang)
        elif name == "skewx" and nums:
            cur = _transform_skew_x(nums[0])
        elif name == "skewy" and nums:
            cur = _transform_skew_y(nums[0])
        out = _mat_mul(out, cur)
    return out


def _apply_transform(pts: list[list[float]], m: tuple[float, float, float, float, float, float]) -> list[list[float]]:
    a, b, c, d, e, f = m
    return [[a * x + c * y + e, b * x + d * y + f] for x, y in pts]


def _length(pts: list[list[float]]) -> float:
    total = 0.0
    for i in range(1, len(pts)):
        dx = pts[i][0] - pts[i - 1][0]
        dy = pts[i][1] - pts[i - 1][1]
        total += (dx * dx + dy * dy) ** 0.5
    return total


def _bbox_area(pts: list[list[float]]) -> float:
    if not pts:
        return 0.0
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (max(xs) - min(xs)) * (max(ys) - min(ys))


def _dist(a: list[float], b: list[float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _dedupe_pts(pts: list[list[float]], eps: float = 1e-6) -> list[list[float]]:
    out: list[list[float]] = []
    for p in pts:
        if not out or _dist(out[-1], p) > eps:
            out.append([float(p[0]), float(p[1])])
    if len(out) >= 2 and _dist(out[0], out[-1]) <= eps:
        out.pop()
    return out


def _simplify_collinear(pts: list[list[float]], angle_tol_deg: float = 8.0) -> list[list[float]]:
    pts = _dedupe_pts(pts)
    if len(pts) < 3:
        return pts
    sin_tol = math.sin(math.radians(angle_tol_deg))
    out: list[list[float]] = [pts[0]]
    for i in range(1, len(pts) - 1):
        a = out[-1]
        b = pts[i]
        c = pts[i + 1]
        v1x, v1y = b[0] - a[0], b[1] - a[1]
        v2x, v2y = c[0] - b[0], c[1] - b[1]
        l1 = math.hypot(v1x, v1y)
        l2 = math.hypot(v2x, v2y)
        if l1 <= 1e-6 or l2 <= 1e-6:
            continue
        cross = abs(v1x * v2y - v1y * v2x) / (l1 * l2)
        dot = (v1x * v2x + v1y * v2y) / (l1 * l2)
        if cross <= sin_tol and dot > 0:
            continue
        out.append(b)
    out.append(pts[-1])
    return _dedupe_pts(out)


def _try_extend_chain(
    chain: list[list[float]],
    seg_pts: list[list[float]],
    at_end: bool,
    endpoint_tol: float,
    cos_tol: float,
) -> tuple[list[list[float]], float] | None:
    if len(chain) < 2 or len(seg_pts) != 2:
        return None
    p0, p1 = seg_pts
    if at_end:
        anchor = chain[-1]
        prev = chain[-2]
        dirx, diry = anchor[0] - prev[0], anchor[1] - prev[1]
    else:
        anchor = chain[0]
        nxt = chain[1]
        dirx, diry = anchor[0] - nxt[0], anchor[1] - nxt[1]

    ldir = math.hypot(dirx, diry)
    best: tuple[list[list[float]], float] | None = None
    for near, far in ((p0, p1), (p1, p0)):
        d = _dist(anchor, near)
        if d > endpoint_tol:
            continue
        vx, vy = far[0] - anchor[0], far[1] - anchor[1]
        lv = math.hypot(vx, vy)
        if lv <= 1e-6:
            continue
        if ldir > 1e-6:
            cosv = (dirx * vx + diry * vy) / (ldir * lv)
            if cosv < cos_tol:
                continue
        if at_end:
            cand = chain + [[far[0], far[1]]]
        else:
            cand = [[far[0], far[1]]] + chain
        if best is None or d < best[1]:
            best = (cand, d)
    return best


def _merge_open_segments(
    open_elements: list[dict],
    endpoint_tol: float,
    angle_tol_deg: float = 12.0,
) -> list[dict]:
    if len(open_elements) < 2:
        return open_elements

    cos_tol = math.cos(math.radians(angle_tol_deg))
    mergeable: list[dict] = []
    passthrough: list[dict] = []
    for el in open_elements:
        pts = el.get("pts") or []
        if el.get("has_stroke") and not el.get("has_fill") and len(pts) == 2:
            mergeable.append(el)
        else:
            passthrough.append(el)

    if len(mergeable) < 2:
        return open_elements

    used = [False] * len(mergeable)
    merged: list[dict] = []
    for i, base in enumerate(mergeable):
        if used[i]:
            continue
        used[i] = True
        chain = [[base["pts"][0][0], base["pts"][0][1]], [base["pts"][1][0], base["pts"][1][1]]]
        sw_weight = max(_length(chain), 1.0)
        sw_sum = float(base.get("sw", 1.0)) * sw_weight

        while True:
            best_idx = -1
            best_chain = None
            best_dist = float("inf")
            for j, cand in enumerate(mergeable):
                if used[j]:
                    continue
                sw_a = float(base.get("sw", 1.0))
                sw_b = float(cand.get("sw", 1.0))
                if abs(sw_a - sw_b) > max(0.9, 0.35 * max(sw_a, sw_b)):
                    continue
                ext_end = _try_extend_chain(chain, cand["pts"], True, endpoint_tol, cos_tol)
                ext_start = _try_extend_chain(chain, cand["pts"], False, endpoint_tol, cos_tol)
                for ext in (ext_end, ext_start):
                    if ext is None:
                        continue
                    new_chain, dist = ext
                    if dist < best_dist:
                        best_idx = j
                        best_chain = new_chain
                        best_dist = dist
            if best_idx < 0 or best_chain is None:
                break
            used[best_idx] = True
            chain = best_chain
            seg_len = max(_length(mergeable[best_idx]["pts"]), 1.0)
            sw_weight += seg_len
            sw_sum += float(mergeable[best_idx].get("sw", 1.0)) * seg_len

        chain = _simplify_collinear(chain, 7.0)
        merged.append(
            {
                "pts": chain,
                "closed": False,
                "sw": (sw_sum / sw_weight) if sw_weight > 0 else float(base.get("sw", 1.0)),
                "has_fill": False,
                "has_stroke": True,
                "fill_raw": "",
            }
        )

    return passthrough + merged


def _is_axis_aligned(a: list[float], b: list[float], tol: float = 0.8) -> bool:
    return abs(a[0] - b[0]) <= tol or abs(a[1] - b[1]) <= tol


def classify_svg(raw_svg: str) -> schemas.ImportResult:
    """Parse an SVG string and classify elements into structure categories."""
    # Reject DOCTYPE/ENTITY before parsing
    if "<!DOCTYPE" in raw_svg or "<!ENTITY" in raw_svg:
        raise ValueError("DOCTYPE/ENTITY not allowed")
    if len(raw_svg.encode()) > 5 * 1024 * 1024:
        raise ValueError("SVG too large (max 5 MB)")

    try:
        root = ET.fromstring(raw_svg)
    except ET.ParseError as exc:
        raise ValueError(f"SVG parse error: {exc}") from exc

    if _local(root.tag) != "svg":
        raise ValueError("Root element must be <svg>")

    vb = _parse_viewbox(root)
    vb_area = vb[2] * vb[3] if vb[2] and vb[3] else 1e6
    vb_diag = math.hypot(vb[2], vb[3]) if vb[2] and vb[3] else 1_500.0

    walls: list[schemas.StructureElement] = []
    boundaries: list[schemas.StructureElement] = []
    partitions: list[schemas.StructureElement] = []
    doors: list[schemas.StructureElement] = []
    uncertain: list[schemas.StructureElement] = []
    open_elements: list[dict] = []
    skipped = 0

    tiny_area = max(vb_area * 0.00002, 4.0)
    min_open_len = max(vb_diag * 0.015, 8.0)
    long_open_len = max(vb_diag * 0.05, 28.0)
    min_closed_len = max(vb_diag * 0.03, 18.0)
    min_door_len = max(vb_diag * 0.006, 6.0)
    max_door_len = min(max(vb_diag * 0.03, 16.0), 34.0)
    max_door_area = min(max(tiny_area * 25, 140.0), max(vb_area * 0.003, 280.0))

    def parse_geometry(tag_l: str, el: ET.Element) -> tuple[list[list[float]], bool]:
        if tag_l == "line":
            return _line_pts(el), False
        if tag_l == "polyline":
            return _polyline_pts(el), False
        if tag_l == "polygon":
            return _polyline_pts(el), True
        if tag_l == "rect":
            return _rect_pts(el), True
        if tag_l == "path":
            d = el.get("d") or ""
            return _path_approx_pts(d), _path_is_closed(d)
        return [], False

    def walk(el: ET.Element, inherited: tuple[float, float, float, float, float, float], in_skip_container: bool) -> None:
        nonlocal skipped
        tag = _local(el.tag)
        tag_l = tag.lower()
        own_matrix = _parse_transform(el)
        matrix = _mat_mul(inherited, own_matrix)
        now_skip = in_skip_container or tag_l in _SKIP_CONTAINER_TAGS

        if tag_l in _GEOM_TAGS:
            if now_skip:
                skipped += 1
            else:
                pts, closed = parse_geometry(tag_l, el)
                if len(pts) < 2:
                    skipped += 1
                else:
                    pts = _apply_transform(pts, matrix)
                    pts = _simplify_collinear(pts, 8.0)
                    if len(pts) < 2:
                        skipped += 1
                        return
                    sw = _stroke_width(el)
                    has_fill = _has_fill(el)
                    has_stroke = _has_stroke(el)
                    fill_raw = ((el.get("fill") or _style_prop(el, "fill") or "").strip().lower())
                    length = _length(pts)
                    area = _bbox_area(pts)

                    # Ignore pattern/image fills and "full-canvas" background rectangles.
                    if closed and fill_raw.startswith("url("):
                        skipped += 1
                    elif closed and has_fill and area >= vb_area * 0.9 and sw <= 1.2 and not has_stroke:
                        skipped += 1
                    # Ignore tiny decorative symbols/noise (icons, tiny markers, glyphs).
                    elif area <= tiny_area and length <= min_open_len:
                        skipped += 1
                    else:
                        uid = str(uuid.uuid4())
                        el_data = schemas.StructureElement(id=uid, pts=pts, closed=closed)

                        if closed:
                            if has_fill and area > vb_area * 0.001:
                                el_data.thick = max(sw, 1.6)
                                el_data.conf = 0.82 if area > vb_area * 0.01 else 0.66
                                boundaries.append(el_data)
                            elif has_stroke and (length >= min_closed_len or area >= tiny_area * 10):
                                el_data.thick = max(sw, 1.2)
                                el_data.conf = 0.72
                                boundaries.append(el_data)
                            else:
                                skipped += 1
                        else:
                            open_elements.append(
                                {
                                    "pts": pts,
                                    "closed": False,
                                    "sw": sw,
                                    "has_fill": has_fill,
                                    "has_stroke": has_stroke,
                                    "fill_raw": fill_raw,
                                }
                            )

        elif tag_l not in ("svg", "g", "defs", "title", "desc"):
            skipped += 1

        for child in list(el):
            walk(child, matrix, now_skip)

    walk(root, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), False)

    open_elements = _merge_open_segments(
        open_elements,
        endpoint_tol=max(vb_diag * 0.0022, 2.0),
        angle_tol_deg=12.0,
    )

    for raw in open_elements:
        pts = _simplify_collinear(raw.get("pts") or [], 7.0)
        if len(pts) < 2:
            skipped += 1
            continue
        sw = float(raw.get("sw", 1.0))
        has_stroke = bool(raw.get("has_stroke"))
        length = _length(pts)
        area = _bbox_area(pts)
        if area <= tiny_area and length <= min_open_len * 0.7:
            skipped += 1
            continue

        uid = str(uuid.uuid4())
        el_data = schemas.StructureElement(id=uid, pts=pts, closed=False)
        door_shape = len(pts) >= 3 or not _is_axis_aligned(pts[0], pts[-1], tol=max(vb_diag * 0.0004, 0.7))
        is_door_like = (
            has_stroke
            and sw <= 2.2
            and min_door_len <= length <= max_door_len
            and area <= max_door_area
            and len(pts) <= 10
            and door_shape
        )

        if is_door_like:
            el_data.thick = max(sw, 1.0)
            el_data.conf = 0.8
            doors.append(el_data)
        elif has_stroke and sw >= 2.5 and length >= min_open_len:
            el_data.thick = max(sw, 2.5)
            el_data.conf = 0.86
            walls.append(el_data)
        elif has_stroke and length >= min_open_len:
            el_data.thick = max(sw, 1.0)
            el_data.conf = 0.76
            partitions.append(el_data)
        elif length >= long_open_len:
            el_data.thick = max(sw, 1.0)
            el_data.conf = 0.45
            uncertain.append(el_data)
        else:
            skipped += 1

    stats = schemas.ImportStats(
        total_elements=len(walls) + len(boundaries) + len(partitions) + len(doors) + len(uncertain) + skipped,
        walls=len(walls),
        boundaries=len(boundaries),
        partitions=len(partitions),
        doors=len(doors),
        uncertain=len(uncertain),
        skipped=skipped,
    )

    return schemas.ImportResult(
        walls=walls,
        boundaries=boundaries,
        partitions=partitions,
        doors=doors,
        uncertain=uncertain,
        stats=stats,
        vb=vb,
    )
