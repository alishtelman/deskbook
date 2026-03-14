"""Service layer for canonical LayoutDocument (v2 editor) draft/publish workflow."""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from . import models, schemas


class ConflictError(Exception):
    pass


class NotFoundError(Exception):
    pass


class LockError(Exception):
    pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _floor_or_404(db: Session, floor_id: int) -> models.Floor:
    f = db.get(models.Floor, floor_id)
    if not f:
        raise NotFoundError(f"Floor {floor_id} not found")
    return f


def _rev_to_response(rev: models.FloorMapRevision) -> schemas.LayoutDocumentResponse:
    if rev.layout_json:
        try:
            raw = json.loads(rev.layout_json)
            layout = schemas.LayoutDocument(**raw)
        except Exception:
            layout = schemas.LayoutDocument()
    else:
        layout = schemas.LayoutDocument()
    return schemas.LayoutDocumentResponse(
        revision_id=rev.id,
        floor_id=rev.floor_id,
        status=rev.status,
        version=rev.version,
        updated_at=rev.updated_at,
        published_at=rev.published_at,
        layout=layout,
    )


def _get_or_create_draft(
    db: Session, floor_id: int, user_id: Optional[int] = None
) -> tuple[models.FloorMapRevision, bool]:
    floor = _floor_or_404(db, floor_id)
    if floor.draft_map_revision_id:
        draft = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
        if draft:
            return draft, False

    published = None
    if floor.published_map_revision_id:
        published = db.get(models.FloorMapRevision, floor.published_map_revision_id)

    draft = models.FloorMapRevision(
        floor_id=floor_id,
        status="draft",
        plan_svg=published.plan_svg if published else None,
        desks_json=published.desks_json if published else "[]",
        zones_json=published.zones_json if published else "[]",
        layout_json=published.layout_json if published else None,
        version=(published.version + 1) if published else 1,
        created_by=user_id,
    )
    db.add(draft)
    db.flush()
    floor.draft_map_revision_id = draft.id
    db.commit()
    db.refresh(draft)
    return draft, True


# ── Public API ────────────────────────────────────────────────────────────────

def get_draft_or_published(db: Session, floor_id: int) -> Optional[schemas.LayoutDocumentResponse]:
    floor = _floor_or_404(db, floor_id)
    if floor.draft_map_revision_id:
        rev = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
        if rev:
            return _rev_to_response(rev)
    if floor.published_map_revision_id:
        rev = db.get(models.FloorMapRevision, floor.published_map_revision_id)
        if rev:
            return _rev_to_response(rev)
    return None


def get_published(db: Session, floor_id: int) -> Optional[schemas.LayoutDocumentResponse]:
    floor = _floor_or_404(db, floor_id)
    if not floor.published_map_revision_id:
        return None
    rev = db.get(models.FloorMapRevision, floor.published_map_revision_id)
    return _rev_to_response(rev) if rev else None


def save_draft(
    db: Session,
    floor_id: int,
    doc: schemas.LayoutDocument,
    version: int,
    user_id: Optional[int] = None,
) -> schemas.LayoutDocumentResponse:
    draft, created = _get_or_create_draft(db, floor_id, user_id)
    # Backward compatibility: when draft is auto-created from published revision,
    # clients may still send the published version number (draft.version - 1).
    if created:
        if version not in {draft.version, max(0, draft.version - 1)}:
            raise ConflictError(
                f"Version mismatch: expected {draft.version} (or {max(0, draft.version - 1)}), got {version}"
            )
    elif draft.version != version:
        raise ConflictError(f"Version mismatch: expected {draft.version}, got {version}")
    draft.layout_json = doc.model_dump_json()
    db.commit()
    db.refresh(draft)
    _log(db, floor_id, user_id, "saved", draft.id)
    return _rev_to_response(draft)


def publish(
    db: Session,
    floor_id: int,
    user_id: Optional[int] = None,
) -> schemas.LayoutDocumentResponse:
    floor = _floor_or_404(db, floor_id)
    if not floor.draft_map_revision_id:
        raise NotFoundError("No draft to publish")
    draft = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
    if not draft:
        raise NotFoundError("Draft revision missing")

    if floor.published_map_revision_id:
        old = db.get(models.FloorMapRevision, floor.published_map_revision_id)
        if old:
            old.status = "archived"

    draft.status = "published"
    draft.published_at = datetime.now(timezone.utc)
    floor.published_map_revision_id = draft.id
    floor.draft_map_revision_id = None
    db.commit()
    db.refresh(draft)
    _log(db, floor_id, user_id, "published", draft.id)
    try:
        _sync_desks(db, floor_id, draft)
    except Exception as exc:
        db.rollback()
        _log(db, floor_id, user_id, "sync_failed", draft.id, note=str(exc))
    return _rev_to_response(draft)


def discard(db: Session, floor_id: int, user_id: Optional[int] = None) -> None:
    floor = _floor_or_404(db, floor_id)
    if not floor.draft_map_revision_id:
        return
    draft = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
    floor.draft_map_revision_id = None
    if draft:
        db.delete(draft)
    db.commit()
    _log(db, floor_id, user_id, "discarded", None)


def sync_desks_for_floor(
    db: Session,
    floor_id: int,
    source: str = "published",
    cleanup: bool = False,
    user_id: Optional[int] = None,
) -> schemas.LayoutDeskSyncResult:
    floor = _floor_or_404(db, floor_id)
    src = source if source in {"published", "draft"} else "published"

    rev = None
    if src == "draft" and floor.draft_map_revision_id:
        rev = db.get(models.FloorMapRevision, floor.draft_map_revision_id)
    if rev is None and floor.published_map_revision_id:
        rev = db.get(models.FloorMapRevision, floor.published_map_revision_id)
        src = "published"

    if rev is None:
        raise NotFoundError("No revision to sync desks from")

    stats = _sync_desks(db, floor_id, rev)

    deleted = 0
    protected = 0
    if cleanup and stats.get("unmatched_ids"):
        for desk_id in stats["unmatched_ids"]:
            has_active = (
                db.query(models.Reservation.id)
                .filter(
                    models.Reservation.desk_id == desk_id,
                    models.Reservation.status == "active",
                )
                .first()
                is not None
            )
            if has_active:
                protected += 1
                continue
            desk = db.get(models.Desk, desk_id)
            if desk:
                db.delete(desk)
                deleted += 1
        db.commit()

    note = f"source:{src};cleanup:{1 if cleanup else 0};deleted:{deleted};protected:{protected}"
    _log(db, floor_id, user_id, "desks_synced", rev.id, note=note)
    return schemas.LayoutDeskSyncResult(
        floor_id=floor_id,
        revision_id=rev.id,
        source_status=src,
        created=stats["created"],
        updated=stats["updated"],
        renamed=stats["renamed"],
        total_layout_desks=stats["total_layout_desks"],
        unmatched_existing=stats["unmatched_existing"],
        deleted=deleted,
        protected_with_active_reservations=protected,
    )


def get_history(db: Session, floor_id: int, limit: int = 50) -> list[schemas.AuditLogEntry]:
    _floor_or_404(db, floor_id)
    rows = (
        db.query(models.MapAuditLog)
        .filter(models.MapAuditLog.floor_id == floor_id)
        .order_by(models.MapAuditLog.id.desc())
        .limit(limit)
        .all()
    )
    return [
        schemas.AuditLogEntry(
            id=r.id, floor_id=r.floor_id, user_id=r.user_id,
            action=r.action, revision_id=r.revision_id,
            created_at=r.created_at, note=r.note,
        )
        for r in rows
    ]


def list_revisions(db: Session, floor_id: int, limit: int = 100) -> list[schemas.LayoutRevisionSummary]:
    floor = _floor_or_404(db, floor_id)
    rows = (
        db.query(models.FloorMapRevision)
        .filter(models.FloorMapRevision.floor_id == floor_id)
        .order_by(models.FloorMapRevision.id.desc())
        .limit(limit)
        .all()
    )

    user_ids = {r.created_by for r in rows if r.created_by is not None}
    users_by_id: dict[int, str] = {}
    if user_ids:
        users_by_id = {
            u.id: u.username
            for u in db.query(models.User).filter(models.User.id.in_(user_ids)).all()
        }

    return [
        schemas.LayoutRevisionSummary(
            revision_id=r.id,
            floor_id=r.floor_id,
            status=r.status,
            version=r.version,
            created_at=r.created_at,
            updated_at=r.updated_at,
            published_at=r.published_at,
            created_by_id=r.created_by,
            created_by_username=users_by_id.get(r.created_by) if r.created_by is not None else None,
            is_current_published=floor.published_map_revision_id == r.id,
            is_current_draft=floor.draft_map_revision_id == r.id,
        )
        for r in rows
    ]


def get_revision(db: Session, floor_id: int, revision_id: int) -> schemas.LayoutDocumentResponse:
    _floor_or_404(db, floor_id)
    rev = db.get(models.FloorMapRevision, revision_id)
    if not rev or rev.floor_id != floor_id:
        raise NotFoundError(f"Revision {revision_id} not found for floor {floor_id}")
    return _rev_to_response(rev)


def restore_revision_to_draft(
    db: Session,
    floor_id: int,
    revision_id: int,
    user_id: Optional[int] = None,
) -> schemas.LayoutDocumentResponse:
    source = db.get(models.FloorMapRevision, revision_id)
    if not source or source.floor_id != floor_id:
        raise NotFoundError(f"Revision {revision_id} not found for floor {floor_id}")

    draft, _ = _get_or_create_draft(db, floor_id, user_id)
    draft.status = "draft"
    draft.plan_svg = source.plan_svg
    draft.desks_json = source.desks_json
    draft.zones_json = source.zones_json
    draft.layout_json = source.layout_json
    db.commit()
    db.refresh(draft)
    _log(
        db,
        floor_id,
        user_id,
        "rolled_back",
        draft.id,
        note=f"restored_from_revision:{source.id}",
    )
    return _rev_to_response(draft)


# ── Lock management ───────────────────────────────────────────────────────────

_LOCK_TTL_SECONDS = 600  # 10 minutes


def acquire_lock(db: Session, floor_id: int, user_id: int) -> schemas.FloorLockOut:
    _floor_or_404(db, floor_id)
    now = datetime.now(timezone.utc)
    existing = db.query(models.FloorLock).filter_by(floor_id=floor_id).first()
    if existing:
        # Allow re-lock by same user, or if expired
        if existing.locked_by != user_id and existing.expires_at.replace(tzinfo=timezone.utc) > now:
            user = db.get(models.User, existing.locked_by)
            uname = user.username if user else str(existing.locked_by)
            raise LockError(f"Floor is locked by {uname}")
        existing.locked_by = user_id
        existing.locked_at = now
        existing.expires_at = datetime.fromtimestamp(now.timestamp() + _LOCK_TTL_SECONDS, tz=timezone.utc)
        db.commit()
        db.refresh(existing)
        lock = existing
    else:
        lock = models.FloorLock(
            floor_id=floor_id,
            locked_by=user_id,
            expires_at=datetime.fromtimestamp(now.timestamp() + _LOCK_TTL_SECONDS, tz=timezone.utc),
        )
        db.add(lock)
        db.commit()
        db.refresh(lock)

    user = db.get(models.User, user_id)
    return schemas.FloorLockOut(
        floor_id=floor_id,
        locked_by_id=user_id,
        locked_by_username=user.username if user else str(user_id),
        locked_at=lock.locked_at,
        expires_at=lock.expires_at,
    )


def release_lock(db: Session, floor_id: int, user_id: int) -> None:
    lock = db.query(models.FloorLock).filter_by(floor_id=floor_id, locked_by=user_id).first()
    if lock:
        db.delete(lock)
        db.commit()


def get_lock(db: Session, floor_id: int) -> Optional[schemas.FloorLockOut]:
    lock = db.query(models.FloorLock).filter_by(floor_id=floor_id).first()
    if not lock:
        return None
    now = datetime.now(timezone.utc)
    if lock.expires_at.replace(tzinfo=timezone.utc) <= now:
        db.delete(lock)
        db.commit()
        return None
    user = db.get(models.User, lock.locked_by)
    return schemas.FloorLockOut(
        floor_id=floor_id,
        locked_by_id=lock.locked_by,
        locked_by_username=user.username if user else str(lock.locked_by),
        locked_at=lock.locked_at,
        expires_at=lock.expires_at,
    )


# ── Private helpers ───────────────────────────────────────────────────────────

def _log(
    db: Session,
    floor_id: int,
    user_id: Optional[int],
    action: str,
    revision_id: Optional[int],
    note: Optional[str] = None,
) -> None:
    try:
        entry = models.MapAuditLog(
            floor_id=floor_id, user_id=user_id,
            action=action, revision_id=revision_id,
            note=note,
        )
        db.add(entry)
        db.commit()
    except Exception:
        db.rollback()


def _norm_label(label: str) -> str:
    return re.sub(r"[^0-9A-ZА-ЯЁ]", "", str(label or "").upper())


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _sync_desks(db: Session, floor_id: int, rev: models.FloorMapRevision) -> dict[str, int]:
    """Upsert Desk table rows from published layout_json desks (by label)."""
    if not rev.layout_json:
        return {
            "created": 0, "updated": 0, "renamed": 0,
            "total_layout_desks": 0, "unmatched_existing": 0, "unmatched_ids": [],
        }
    try:
        raw = json.loads(rev.layout_json)
        ld = schemas.LayoutDocument(**raw)
    except Exception:
        return {
            "created": 0, "updated": 0, "renamed": 0,
            "total_layout_desks": 0, "unmatched_existing": 0, "unmatched_ids": [],
        }

    existing_rows = db.query(models.Desk).filter_by(floor_id=floor_id).all()
    by_exact: dict[str, list[models.Desk]] = {}
    by_norm: dict[str, list[models.Desk]] = {}
    for row in existing_rows:
        key = (row.label or "").strip()
        by_exact.setdefault(key, []).append(row)
        nkey = _norm_label(key)
        if nkey:
            by_norm.setdefault(nkey, []).append(row)

    seen_layout_labels: set[str] = set()
    used_existing_ids: set[int] = set()
    created = 0
    updated = 0
    renamed = 0
    total_layout_desks = 0

    def pick_unused(items: list[models.Desk] | None) -> Optional[models.Desk]:
        if not items:
            return None
        for item in items:
            if item.id not in used_existing_ids:
                return item
        return None

    for ld_desk in ld.desks:
        label = (ld_desk.label or "").strip()
        if not label or label in seen_layout_labels:
            continue
        seen_layout_labels.add(label)
        total_layout_desks += 1

        desk = pick_unused(by_exact.get(label))
        if desk is None:
            desk = pick_unused(by_norm.get(_norm_label(label)))

        if desk is None:
            desk = models.Desk(
                floor_id=floor_id,
                label=label,
                qr_token=str(uuid.uuid4()),
            )
            db.add(desk)
            created += 1
        else:
            used_existing_ids.add(desk.id)
            updated += 1
            if (desk.label or "").strip() != label:
                desk.label = label
                renamed += 1
            if not getattr(desk, "qr_token", None):
                desk.qr_token = str(uuid.uuid4())

        desk.type = "fixed" if ld_desk.fixed else "flex"
        desk.space_type = "desk"
        desk.assigned_to = ld_desk.assigned_to
        px = (ld_desk.x / ld.vb[2]) if ld.vb[2] else 0
        py = (ld_desk.y / ld.vb[3]) if ld.vb[3] else 0
        pw = (ld_desk.w / ld.vb[2]) if ld.vb[2] else 0.05
        ph = (ld_desk.h / ld.vb[3]) if ld.vb[3] else 0.03

        desk.position_x = _clamp(px, 0.0, 1.0)
        desk.position_y = _clamp(py, 0.0, 1.0)
        desk.w = _clamp(pw, 0.01, 1.0)
        desk.h = _clamp(ph, 0.01, 1.0)

    db.commit()
    unmatched_ids = [row.id for row in existing_rows if row.id not in used_existing_ids]
    return {
        "created": created,
        "updated": updated,
        "renamed": renamed,
        "total_layout_desks": total_layout_desks,
        "unmatched_existing": len(unmatched_ids),
        "unmatched_ids": unmatched_ids,
    }
