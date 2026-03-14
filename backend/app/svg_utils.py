"""SVG sanitizer — stdlib only (xml.etree.ElementTree + re)."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET

ALLOWED_TAGS = {
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "defs", "clipPath", "mask", "symbol", "use", "title", "desc",
    "linearGradient", "radialGradient", "stop", "pattern", "image",
}

MAX_BYTES = 5 * 1024 * 1024
MAX_NODES = 50_000

SVG_NS = "http://www.w3.org/2000/svg"
_DANGER_STYLE = re.compile(r"expression\(|@import|javascript", re.IGNORECASE)
_UNSAFE_STYLE_URL = re.compile(r"url\(\s*(['\"])?(?!#)", re.IGNORECASE)
_SAFE_DATA_IMAGE_RE = re.compile(
    r"^data:image/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$",
    re.IGNORECASE,
)


def _local(tag: str) -> str:
    """Strip namespace URI from a tag name."""
    if tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag


def _clean_element(el: ET.Element) -> None:
    """Recursively remove disallowed children and sanitize attributes."""
    to_remove = []
    for child in list(el):
        if _local(child.tag) not in ALLOWED_TAGS:
            to_remove.append(child)
        else:
            _clean_element(child)
    for child in to_remove:
        el.remove(child)

    bad = []
    local_tag = _local(el.tag).lower()
    for attr, val in list(el.attrib.items()):
        local_attr = _local(attr).lower()
        # Remove all event handlers
        if local_attr.startswith("on"):
            bad.append(attr)
            continue
        val_lower = val.lower().strip()
        # href / xlink:href — only fragment references (#id) are allowed
        if "href" in local_attr:
            # Also allow embedded raster images on <image>.
            if val.startswith("#"):
                continue
            if local_tag == "image" and _SAFE_DATA_IMAGE_RE.match(val.strip()):
                continue
            bad.append(attr)
            continue
        # Forbid javascript: and data: in any other attribute value
        if "javascript:" in val_lower or "data:" in val_lower:
            bad.append(attr)
            continue
        # For image tags, keep only safe href + geometry/presentation attributes.
        if local_tag == "image":
            if local_attr not in {"x", "y", "width", "height", "preserveaspectratio", "href"}:
                bad.append(attr)
            continue
        # style — strip if it contains unsafe CSS
        if local_attr == "style":
            if _DANGER_STYLE.search(val) or _UNSAFE_STYLE_URL.search(val):
                bad.append(attr)
    for attr in bad:
        del el.attrib[attr]


def sanitize_svg(raw: str) -> str:
    """
    Parse, validate and sanitize an SVG string.

    Raises ValueError with a descriptive message — callers should return 400.
    """
    # Size check
    if len(raw.encode("utf-8")) > MAX_BYTES:
        raise ValueError("SVG too large (max 5 MB)")

    # Reject DOCTYPE / ENTITY before any parsing to avoid XXE
    raw_head = raw[:4096].upper()
    if "<!DOCTYPE" in raw_head or "<!ENTITY" in raw_head:
        raise ValueError("DOCTYPE and ENTITY declarations are not allowed")

    # Parse
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid SVG XML: {exc}") from exc

    # Root must be <svg>
    if _local(root.tag) != "svg":
        raise ValueError("Root element must be <svg>")

    # viewBox is mandatory — no normalization, always reject if missing
    if not (root.get("viewBox") or root.get("viewbox")):
        raise ValueError("SVG missing viewBox attribute")

    # Node count
    node_count = sum(1 for _ in root.iter())
    if node_count > MAX_NODES:
        raise ValueError(f"SVG too complex ({node_count} nodes, max {MAX_NODES})")

    # Clean disallowed elements and unsafe attributes
    _clean_element(root)

    # Re-serialize with standard SVG namespace
    ET.register_namespace("", SVG_NS)
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")

    return ET.tostring(root, encoding="unicode", xml_declaration=False)
