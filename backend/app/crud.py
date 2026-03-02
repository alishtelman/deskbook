from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta
from typing import Optional

from sqlalchemy import and_, desc, func
from sqlalchemy.orm import Session

from . import models, schemas


def _time_overlaps(start_a: time, end_a: time, start_b: time, end_b: time) -> bool:
    return start_a < end_b and start_b < end_a


# ---------------------------------------------------------------------------
# Offices
# ---------------------------------------------------------------------------

def list_offices(db: Session) -> list[models.Office]:
    return db.query(models.Office).all()


def create_office(db: Session, payload: schemas.OfficeCreate) -> models.Office:
    office = models.Office(**payload.model_dump())
    db.add(office)
    db.commit()
    db.refresh(office)
    return office


def update_office(db: Session, office_id: int, payload: schemas.OfficeUpdate) -> models.Office:
    office = db.query(models.Office).filter(models.Office.id == office_id).first()
    if office is None:
        raise KeyError("office")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(office, key, value)
    db.commit()
    db.refresh(office)
    return office


def delete_office(db: Session, office_id: int) -> None:
    office = db.query(models.Office).filter(models.Office.id == office_id).first()
    if office is None:
        raise KeyError("office")
    db.delete(office)
    db.commit()


# ---------------------------------------------------------------------------
# Floors
# ---------------------------------------------------------------------------

def list_floors(db: Session, office_id: Optional[int] = None) -> list[models.Floor]:
    q = db.query(models.Floor)
    if office_id is not None:
        q = q.filter(models.Floor.office_id == office_id)
    return q.all()


def create_floor(db: Session, payload: schemas.FloorCreate) -> models.Floor:
    office = db.query(models.Office).filter(models.Office.id == payload.office_id).first()
    if office is None:
        raise KeyError("office")
    floor = models.Floor(**payload.model_dump())
    db.add(floor)
    db.commit()
    db.refresh(floor)
    return floor


def update_floor(db: Session, floor_id: int, payload: schemas.FloorUpdate) -> models.Floor:
    floor = db.query(models.Floor).filter(models.Floor.id == floor_id).first()
    if floor is None:
        raise KeyError("floor")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(floor, key, value)
    db.commit()
    db.refresh(floor)
    return floor


def delete_floor(db: Session, floor_id: int) -> None:
    floor = db.query(models.Floor).filter(models.Floor.id == floor_id).first()
    if floor is None:
        raise KeyError("floor")
    db.delete(floor)
    db.commit()


# ---------------------------------------------------------------------------
# Desks
# ---------------------------------------------------------------------------

def list_desks(db: Session, floor_id: Optional[int] = None) -> list[models.Desk]:
    q = db.query(models.Desk)
    if floor_id is not None:
        q = q.filter(models.Desk.floor_id == floor_id)
    return q.all()


def create_desk(db: Session, payload: schemas.DeskCreate) -> models.Desk:
    floor = db.query(models.Floor).filter(models.Floor.id == payload.floor_id).first()
    if floor is None:
        raise KeyError("floor")
    data = payload.model_dump()
    if data.get("type") == "fixed" and not data.get("assigned_to"):
        raise ValueError("Fixed desks must have an assigned employee.")
    if data.get("type") == "flex":
        data["assigned_to"] = None
    data["qr_token"] = str(uuid.uuid4())
    desk = models.Desk(**data)
    db.add(desk)
    db.commit()
    db.refresh(desk)
    return desk


def update_desk(db: Session, desk_id: int, payload: schemas.DeskUpdate) -> models.Desk:
    desk = db.query(models.Desk).filter(models.Desk.id == desk_id).first()
    if desk is None:
        raise KeyError("desk")
    update_data = payload.model_dump(exclude_unset=True)
    next_type = update_data.get("type", desk.type)
    next_assigned = update_data.get("assigned_to", desk.assigned_to)
    if next_type == "fixed" and not next_assigned:
        raise ValueError("Fixed desks must have an assigned employee.")
    if next_type == "flex":
        update_data["assigned_to"] = None
    for key, value in update_data.items():
        setattr(desk, key, value)
    db.commit()
    db.refresh(desk)
    return desk


def delete_desk(db: Session, desk_id: int) -> None:
    desk = db.query(models.Desk).filter(models.Desk.id == desk_id).first()
    if desk is None:
        raise KeyError("desk")
    db.delete(desk)
    db.commit()


def get_desk_by_qr_token(db: Session, qr_token: str) -> Optional[models.Desk]:
    return db.query(models.Desk).filter(models.Desk.qr_token == qr_token).first()


def checkin_reservation(
    db: Session, qr_token: str, user_id: str
) -> models.Reservation:
    """Check in a user to their active reservation for today via QR token."""
    desk = get_desk_by_qr_token(db, qr_token)
    if desk is None:
        raise KeyError("desk")

    today = datetime.utcnow().date()

    reservation = (
        db.query(models.Reservation)
        .filter(
            models.Reservation.desk_id == desk.id,
            models.Reservation.user_id == user_id,
            models.Reservation.reservation_date == today,
            models.Reservation.status == "active",
            models.Reservation.checked_in_at.is_(None),
        )
        .first()
    )
    if reservation is None:
        raise ValueError("No active reservation for today")

    reservation.checked_in_at = datetime.utcnow()
    db.commit()
    db.refresh(reservation)
    return reservation


def cancel_noshow_reservations(db: Session) -> int:
    """Cancel active reservations where check-in is overdue past the policy timeout.

    Joins Reservation -> Desk -> Floor -> Office -> Policy to determine
    the no_show_timeout_minutes for each reservation's office. Defaults to 15
    minutes when no policy exists for an office.
    """
    DEFAULT_TIMEOUT = 15
    now_utc = datetime.utcnow()

    # Fetch all active, unchecked-in reservations that have a start_time set
    active_reservations = (
        db.query(models.Reservation)
        .join(models.Desk, models.Reservation.desk_id == models.Desk.id)
        .join(models.Floor, models.Desk.floor_id == models.Floor.id)
        .filter(
            models.Reservation.status == "active",
            models.Reservation.checked_in_at.is_(None),
            models.Reservation.start_time.is_not(None),
        )
        .all()
    )

    # Build a map of office_id -> no_show_timeout_minutes from policies
    # Use the first policy found for each office (most specific wins)
    policies = db.query(models.Policy).all()
    office_timeout: dict[Optional[int], int] = {}
    for policy in policies:
        oid = policy.office_id
        if oid not in office_timeout:
            office_timeout[oid] = policy.no_show_timeout_minutes

    cancelled_count = 0
    for res in active_reservations:
        # Walk up to find the office_id for this reservation
        desk = res.desk
        floor = desk.floor if desk else None
        office_id = floor.office_id if floor else None

        # Determine the applicable timeout: office-specific policy first, then global (None key), then default
        timeout = office_timeout.get(office_id, office_timeout.get(None, DEFAULT_TIMEOUT))

        # Combine reservation_date + start_time to get the scheduled start as a naive UTC datetime
        scheduled_start = datetime.combine(res.reservation_date, res.start_time)

        if now_utc >= scheduled_start + timedelta(minutes=timeout):
            res.status = "cancelled"
            cancelled_count += 1

    if cancelled_count:
        db.commit()

    return cancelled_count


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------

def check_availability(
    db: Session,
    desk_id: int,
    reservation_date: date,
    start_time: time,
    end_time: time,
    user_id: Optional[str] = None,
) -> schemas.AvailabilityResponse:
    desk = db.query(models.Desk).filter(models.Desk.id == desk_id).first()
    if desk is None:
        raise KeyError("desk")
    if desk.type == "fixed" and not desk.assigned_to:
        return schemas.AvailabilityResponse(
            available=False, reason="Desk is fixed but has no assigned employee."
        )
    if desk.type == "fixed" and desk.assigned_to and desk.assigned_to != user_id:
        return schemas.AvailabilityResponse(
            available=False, reason="Desk is assigned to another employee."
        )
    active = (
        db.query(models.Reservation)
        .filter(
            models.Reservation.desk_id == desk_id,
            models.Reservation.reservation_date == reservation_date,
            models.Reservation.status == "active",
        )
        .all()
    )
    for res in active:
        if res.start_time and res.end_time:
            if _time_overlaps(start_time, end_time, res.start_time, res.end_time):
                return schemas.AvailabilityResponse(
                    available=False,
                    reason="Desk already reserved for the requested time.",
                )
    return schemas.AvailabilityResponse(available=True)


# ---------------------------------------------------------------------------
# Reservations
# ---------------------------------------------------------------------------

def list_reservations(
    db: Session,
    desk_id: Optional[int] = None,
    reservation_date: Optional[date] = None,
    user_id: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    office_id: Optional[int] = None,
    status: Optional[str] = None,
) -> list[models.Reservation]:
    q = db.query(models.Reservation)
    if office_id is not None:
        # Join through Desk -> Floor to filter by office
        q = (
            q.join(models.Desk, models.Reservation.desk_id == models.Desk.id)
            .join(models.Floor, models.Desk.floor_id == models.Floor.id)
            .filter(models.Floor.office_id == office_id)
        )
    if desk_id is not None:
        q = q.filter(models.Reservation.desk_id == desk_id)
    if reservation_date is not None:
        q = q.filter(models.Reservation.reservation_date == reservation_date)
    if user_id is not None:
        q = q.filter(models.Reservation.user_id == user_id)
    if date_from is not None:
        q = q.filter(models.Reservation.reservation_date >= date_from)
    if date_to is not None:
        q = q.filter(models.Reservation.reservation_date <= date_to)
    if status is not None:
        q = q.filter(models.Reservation.status == status)
    q = q.order_by(models.Reservation.reservation_date.desc(), models.Reservation.id.desc())
    return q.all()


def create_reservation(db: Session, payload: schemas.ReservationCreate) -> models.Reservation:
    """Create a reservation with SELECT FOR UPDATE to prevent double-booking."""
    # Lock the desk row first to serialize concurrent bookings for same desk
    desk = (
        db.query(models.Desk)
        .filter(models.Desk.id == payload.desk_id)
        .with_for_update()
        .first()
    )
    if desk is None:
        raise KeyError("desk")

    if desk.type == "fixed" and not desk.assigned_to:
        raise ValueError("Desk is fixed but has no assigned employee.")
    if desk.type == "fixed" and desk.assigned_to and desk.assigned_to != payload.user_id:
        raise ValueError("Desk is assigned to another employee.")

    # Enforce booking policy for the office this desk belongs to
    floor = db.query(models.Floor).filter(models.Floor.id == desk.floor_id).first()
    if floor is not None:
        policy = (
            db.query(models.Policy)
            .filter(models.Policy.office_id == floor.office_id)
            .first()
        )
        if policy is not None:
            today = date.today()
            reservation_date = payload.reservation_date

            # min_days_ahead validation
            if reservation_date < today + timedelta(days=policy.min_days_ahead):
                raise ValueError(
                    f"Бронирование возможно не ранее чем за {policy.min_days_ahead} дней вперёд"
                )

            # max_days_ahead validation
            if reservation_date > today + timedelta(days=policy.max_days_ahead):
                raise ValueError(
                    f"Бронирование возможно не более чем за {policy.max_days_ahead} дней вперёд"
                )

            # duration validation (only when both times are provided and policy limits are set)
            if payload.start_time and payload.end_time:
                duration = (
                    payload.end_time.hour * 60 + payload.end_time.minute
                ) - (
                    payload.start_time.hour * 60 + payload.start_time.minute
                )
                if policy.min_duration_minutes is not None and duration < policy.min_duration_minutes:
                    raise ValueError(
                        f"Минимальная длительность брони — {policy.min_duration_minutes} минут"
                    )
                if policy.max_duration_minutes is not None and duration > policy.max_duration_minutes:
                    raise ValueError(
                        f"Максимальная длительность брони — {policy.max_duration_minutes} минут"
                    )

    # Lock active reservations for this desk/date to check overlaps atomically
    active = (
        db.query(models.Reservation)
        .filter(
            models.Reservation.desk_id == payload.desk_id,
            models.Reservation.reservation_date == payload.reservation_date,
            models.Reservation.status == "active",
        )
        .with_for_update()
        .all()
    )

    for res in active:
        if res.start_time and res.end_time and payload.start_time and payload.end_time:
            if _time_overlaps(
                payload.start_time, payload.end_time, res.start_time, res.end_time
            ):
                raise ValueError("Desk already reserved for the requested time.")

    reservation = models.Reservation(
        desk_id=payload.desk_id,
        user_id=payload.user_id,
        reservation_date=payload.reservation_date,
        start_time=payload.start_time,
        end_time=payload.end_time,
        status="active",
    )
    db.add(reservation)
    db.commit()
    db.refresh(reservation)
    return reservation


def cancel_reservation(db: Session, reservation_id: int) -> models.Reservation:
    reservation = (
        db.query(models.Reservation)
        .filter(models.Reservation.id == reservation_id)
        .first()
    )
    if reservation is None:
        raise KeyError("reservation")
    reservation.status = "cancelled"
    db.commit()
    db.refresh(reservation)
    return reservation


# ---------------------------------------------------------------------------
# Policies
# ---------------------------------------------------------------------------

def list_policies(db: Session, office_id: Optional[int] = None) -> list[models.Policy]:
    q = db.query(models.Policy)
    if office_id is not None:
        q = q.filter(
            (models.Policy.office_id == office_id) | (models.Policy.office_id.is_(None))
        )
    return q.all()


def create_policy(db: Session, payload: schemas.PolicyCreate) -> models.Policy:
    if payload.office_id is not None:
        office = db.query(models.Office).filter(models.Office.id == payload.office_id).first()
        if office is None:
            raise KeyError("office")
    if payload.min_days_ahead > payload.max_days_ahead:
        raise ValueError("Min days ahead must not exceed max days ahead.")
    if payload.min_duration_minutes > payload.max_duration_minutes:
        raise ValueError("Min duration must not exceed max duration.")
    policy = models.Policy(**payload.model_dump())
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy


def update_policy(db: Session, policy_id: int, payload: schemas.PolicyUpdate) -> models.Policy:
    policy = db.query(models.Policy).filter(models.Policy.id == policy_id).first()
    if policy is None:
        raise KeyError("policy")
    update_data = payload.model_dump(exclude_unset=True)
    office_id = update_data.get("office_id", policy.office_id)
    if office_id is not None:
        office = db.query(models.Office).filter(models.Office.id == office_id).first()
        if office is None:
            raise KeyError("office")
    for key, value in update_data.items():
        setattr(policy, key, value)
    # Validate merged values
    min_days = update_data.get("min_days_ahead", policy.min_days_ahead)
    max_days = update_data.get("max_days_ahead", policy.max_days_ahead)
    min_dur = update_data.get("min_duration_minutes", policy.min_duration_minutes)
    max_dur = update_data.get("max_duration_minutes", policy.max_duration_minutes)
    if min_days > max_days:
        raise ValueError("Min days ahead must not exceed max days ahead.")
    if min_dur is not None and max_dur is not None and min_dur > max_dur:
        raise ValueError("Min duration must not exceed max duration.")
    db.commit()
    db.refresh(policy)
    return policy


def delete_policy(db: Session, policy_id: int) -> None:
    policy = db.query(models.Policy).filter(models.Policy.id == policy_id).first()
    if policy is None:
        raise KeyError("policy")
    db.delete(policy)
    db.commit()


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

def get_analytics(db: Session) -> dict:
    today = date.today()

    # Total active reservations for today
    total_today = (
        db.query(func.count(models.Reservation.id))
        .filter(
            models.Reservation.reservation_date == today,
            models.Reservation.status == "active",
        )
        .scalar()
        or 0
    )

    # Total active / cancelled (all time)
    total_active = (
        db.query(func.count(models.Reservation.id))
        .filter(models.Reservation.status == "active")
        .scalar()
        or 0
    )
    total_cancelled = (
        db.query(func.count(models.Reservation.id))
        .filter(models.Reservation.status == "cancelled")
        .scalar()
        or 0
    )

    # No-show rate: cancelled without check-in / all past reservations
    past_total = (
        db.query(func.count(models.Reservation.id))
        .filter(models.Reservation.reservation_date < today)
        .scalar()
        or 0
    )
    past_noshow = (
        db.query(func.count(models.Reservation.id))
        .filter(
            models.Reservation.reservation_date < today,
            models.Reservation.status == "cancelled",
            models.Reservation.checked_in_at.is_(None),
        )
        .scalar()
        or 0
    )
    noshow_rate = round(past_noshow / past_total * 100, 1) if past_total > 0 else 0.0

    # Occupancy by office
    offices = db.query(models.Office).all()
    occupancy_by_office = []
    for office in offices:
        total_desks = (
            db.query(func.count(models.Desk.id))
            .join(models.Floor, models.Desk.floor_id == models.Floor.id)
            .filter(models.Floor.office_id == office.id)
            .scalar()
            or 0
        )
        booked_today = (
            db.query(func.count(models.Reservation.id))
            .join(models.Desk, models.Reservation.desk_id == models.Desk.id)
            .join(models.Floor, models.Desk.floor_id == models.Floor.id)
            .filter(
                models.Floor.office_id == office.id,
                models.Reservation.reservation_date == today,
                models.Reservation.status == "active",
            )
            .scalar()
            or 0
        )
        pct = round(booked_today / total_desks * 100, 1) if total_desks > 0 else 0.0
        occupancy_by_office.append(
            {
                "office_id": office.id,
                "office_name": office.name,
                "total_desks": total_desks,
                "booked_today": booked_today,
                "occupancy_pct": pct,
            }
        )

    # Top 5 desks by booking count (active reservations only)
    top_desks_q = (
        db.query(
            models.Desk.id,
            models.Desk.label,
            models.Floor.name.label("floor_name"),
            models.Office.name.label("office_name"),
            func.count(models.Reservation.id).label("total"),
        )
        .join(models.Reservation, models.Reservation.desk_id == models.Desk.id)
        .join(models.Floor, models.Floor.id == models.Desk.floor_id)
        .join(models.Office, models.Office.id == models.Floor.office_id)
        .filter(models.Reservation.status == "active")
        .group_by(
            models.Desk.id,
            models.Desk.label,
            models.Floor.name,
            models.Office.name,
        )
        .order_by(desc("total"))
        .limit(5)
        .all()
    )
    top_desks = [
        {
            "desk_id": r.id,
            "label": r.label,
            "floor_name": r.floor_name,
            "office_name": r.office_name,
            "total": r.total,
        }
        for r in top_desks_q
    ]

    # Top 5 users by booking count (active reservations only)
    top_users_q = (
        db.query(
            models.Reservation.user_id,
            func.count(models.Reservation.id).label("total"),
        )
        .filter(models.Reservation.status == "active")
        .group_by(models.Reservation.user_id)
        .order_by(desc("total"))
        .limit(5)
        .all()
    )
    top_users = [{"user_id": r.user_id, "total": r.total} for r in top_users_q]

    return {
        "total_today": total_today,
        "total_active": total_active,
        "total_cancelled": total_cancelled,
        "noshow_rate": noshow_rate,
        "occupancy_by_office": occupancy_by_office,
        "top_desks": top_desks,
        "top_users": top_users,
    }


# ---------------------------------------------------------------------------
# Users (auth)
# ---------------------------------------------------------------------------

def get_user_by_username(db: Session, username: str) -> Optional[models.User]:
    return db.query(models.User).filter(models.User.username == username).first()


def get_user_by_email(db: Session, email: str) -> Optional[models.User]:
    return db.query(models.User).filter(models.User.email == email).first()


def create_user(
    db: Session, username: str, email: str, hashed_password: str, role: str = "user"
) -> models.User:
    user = models.User(
        username=username,
        email=email,
        hashed_password=hashed_password,
        role=role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user
