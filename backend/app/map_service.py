"""Service layer for floor map revisions (draft/published workflow)."""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from . import models, schemas
from .svg_utils import sanitize_svg


class ConflictError(Exception):
    pass


class NotFoundError(Exception):
    pass


def _get_floor_or_404(db: Session, floor_id: int) -> models.Floor:
    floor = db.get(models.Floor, floor_id)
    if not floor:
        raise NotFoundError(f"Floor {floor_id} not found")
    return floor


def _parse_revision(rev: models.FloorMapRevision) -> schemas.FloorMapRevisionResponse:
    try:
        desks_raw = json.loads(rev.desks_json or "[]")
        desks = [schemas.MapDesk(**d) for d in desks_raw]
    except Exception:
        desks = []

    try:
        zones_raw = json.loads(rev.zones_json or "[]")
        zones = [schemas.MapZone(**z) for z in zones_raw]
    except Exception:
        zones = []

    return schemas.FloorMapRevisionResponse(
        id=rev.id,
        floor_id=rev.floor_id,
        status=rev.status,
        plan_svg=rev.plan_svg,
        desks=desks,
        zones=zones,
        version=rev.version,
        published_at=rev.published_at,
        updated_at=rev.updated_at,
    )


def get_published_revision(db: Session, floor_id: int) -> Optional[models.FloorMapRevision]:
    floor = _get_floor_or_404(db, floor_id)
    if floor.published_map_revision_id:
        return db.get(models.FloorMapRevision, floor.published_map_revision_id)
    return None


def get_or_create_draft_revision(
    db: Session,
    floor_id: int,
    user_id: Optional[int] = None,
) -> models.FloorMapRevision:
    floor = _get_floor_or_404(db, floor_id)

    if floor.draft_map_revision_id:
        draft = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
        if draft:
            return draft

    # Create new draft — copy of published snapshot or empty
    published = get_published_revision(db, floor_id)
    draft = models.FloorMapRevision(
        floor_id=floor_id,
        status="draft",
        plan_svg=published.plan_svg if published else None,
        desks_json=published.desks_json if published else "[]",
        zones_json=published.zones_json if published else "[]",
        version=(published.version + 1) if published else 1,
        created_by=user_id,
    )
    db.add(draft)
    db.flush()
    floor.draft_map_revision_id = draft.id
    db.commit()
    db.refresh(draft)
    return draft


def _parse_viewbox(svg_str: str) -> Optional[tuple[float, float, float, float]]:
    """Return (x, y, w, h) from the SVG viewBox attribute, or None."""
    try:
        root = ET.fromstring(svg_str)
        vb = root.get("viewBox") or root.get("viewbox")
        if not vb:
            return None
        parts = re.split(r"[\s,]+", vb.strip())
        if len(parts) < 4:
            return None
        return (float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3]))
    except Exception:
        return None


def _validate_bounds(payload: schemas.FloorMapRevisionPayload) -> None:
    if not payload.plan_svg:
        return  # empty draft is allowed (schema already enforces desks/zones empty)

    vb = _parse_viewbox(payload.plan_svg)
    if not vb:
        return  # can't parse viewBox — skip bounds check

    vx, vy, vw, vh = vb
    errors: list[str] = []

    for desk in payload.desks:
        if desk.x < vx or desk.y < vy or (desk.x + desk.w) > (vx + vw) or (desk.y + desk.h) > (vy + vh):
            errors.append(f"Desk '{desk.label}' coordinates are outside the viewBox")

    for zone in payload.zones:
        for pt in zone.points:
            if pt.x < vx or pt.x > (vx + vw) or pt.y < vy or pt.y > (vy + vh):
                errors.append(f"Zone '{zone.name}' has a point outside the viewBox")
                break

    if errors:
        raise ValueError("; ".join(errors))


def get_draft_or_published(db: Session, floor_id: int) -> Optional[schemas.FloorMapRevisionResponse]:
    """For admin: return draft if it exists, otherwise published."""
    floor = _get_floor_or_404(db, floor_id)
    if floor.draft_map_revision_id:
        rev = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
        if rev:
            return _parse_revision(rev)
    if floor.published_map_revision_id:
        rev = db.get(models.FloorMapRevision, floor.published_map_revision_id)
        if rev:
            return _parse_revision(rev)
    return None


def get_published_response(db: Session, floor_id: int) -> Optional[schemas.FloorMapRevisionResponse]:
    rev = get_published_revision(db, floor_id)
    return _parse_revision(rev) if rev else None


def save_draft_revision(
    db: Session,
    floor_id: int,
    payload: schemas.FloorMapRevisionPayload,
    user_id: Optional[int] = None,
) -> schemas.FloorMapRevisionResponse:
    draft = get_or_create_draft_revision(db, floor_id, user_id)

    if draft.version != payload.version:
        raise ConflictError(
            f"Version mismatch: expected {draft.version}, got {payload.version}"
        )

    _validate_bounds(payload)

    if payload.plan_svg is not None:
        draft.plan_svg = sanitize_svg(payload.plan_svg)
    else:
        draft.plan_svg = None

    draft.desks_json = json.dumps([d.model_dump() for d in payload.desks])
    draft.zones_json = json.dumps([z.model_dump() for z in payload.zones])

    db.commit()
    db.refresh(draft)
    return _parse_revision(draft)


def upload_svg_to_draft(
    db: Session,
    floor_id: int,
    raw_svg: str,
    user_id: Optional[int] = None,
) -> schemas.FloorMapRevisionResponse:
    clean_svg = sanitize_svg(raw_svg)  # raises ValueError → 400
    draft = get_or_create_draft_revision(db, floor_id, user_id)
    draft.plan_svg = clean_svg
    db.commit()
    db.refresh(draft)
    return _parse_revision(draft)


def publish_draft_revision(
    db: Session,
    floor_id: int,
    user_id: Optional[int] = None,
) -> schemas.FloorMapRevisionResponse:
    floor = _get_floor_or_404(db, floor_id)

    if not floor.draft_map_revision_id:
        raise NotFoundError("No draft revision to publish")

    draft = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
    if not draft:
        raise NotFoundError("Draft revision not found")

    # Archive old published revision
    if floor.published_map_revision_id:
        old = db.get(models.FloorMapRevision, floor.published_map_revision_id)
        if old:
            old.status = "archived"

    # Atomic publish
    draft.status = "published"
    draft.published_at = datetime.utcnow()
    floor.published_map_revision_id = draft.id
    floor.draft_map_revision_id = None

    db.commit()
    db.refresh(draft)
    return _parse_revision(draft)


def discard_draft_revision(db: Session, floor_id: int) -> None:
    floor = _get_floor_or_404(db, floor_id)
    if not floor.draft_map_revision_id:
        return  # no-op, 204

    draft = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
    floor.draft_map_revision_id = None
    if draft:
        db.delete(draft)
    db.commit()
