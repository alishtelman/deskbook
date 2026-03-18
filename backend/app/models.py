from __future__ import annotations

from datetime import date, datetime, time
from typing import Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(120), unique=True, nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, server_default="user")
    created_at: Mapped[date] = mapped_column(
        Date, nullable=False, server_default=func.current_date()
    )
    full_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    department: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    position: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    user_status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="available")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    avatar_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    __table_args__ = (
        CheckConstraint("role IN ('admin', 'user')", name="ck_users_role"),
        CheckConstraint(
            "user_status IN ('available', 'busy', 'away')", name="ck_users_user_status"
        ),
    )


class Office(Base):
    __tablename__ = "offices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)

    floors: Mapped[list[Floor]] = relationship(
        "Floor", back_populates="office", cascade="all, delete-orphan"
    )
    policies: Mapped[list[Policy]] = relationship(
        "Policy", back_populates="office", cascade="all, delete-orphan"
    )


class Floor(Base):
    __tablename__ = "floors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    office_id: Mapped[int] = mapped_column(
        ForeignKey("offices.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    plan_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    published_map_revision_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey(
            "floor_map_revisions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_floor_published_rev",
        ),
        nullable=True,
    )
    draft_map_revision_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey(
            "floor_map_revisions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_floor_draft_rev",
        ),
        nullable=True,
    )

    office: Mapped[Office] = relationship("Office", back_populates="floors")
    desks: Mapped[list[Desk]] = relationship(
        "Desk", back_populates="floor", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("idx_floors_office_id", "office_id"),)

    @property
    def has_published_map(self) -> bool:
        return self.published_map_revision_id is not None

    @property
    def has_draft_map(self) -> bool:
        return self.draft_map_revision_id is not None


class Desk(Base):
    __tablename__ = "desks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    floor_id: Mapped[int] = mapped_column(
        ForeignKey("floors.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(40), nullable=False)
    type: Mapped[str] = mapped_column(String(10), nullable=False, server_default="flex")
    space_type: Mapped[str] = mapped_column(String(30), nullable=False, server_default="desk")
    assigned_to: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    position_x: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    position_y: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    w: Mapped[float] = mapped_column(Float, nullable=False, server_default="0.07")
    h: Mapped[float] = mapped_column(Float, nullable=False, server_default="0.05")
    qr_token: Mapped[str] = mapped_column(
        String(36), unique=True, nullable=False, index=True
    )

    floor: Mapped[Floor] = relationship("Floor", back_populates="desks")
    reservations: Mapped[list[Reservation]] = relationship(
        "Reservation", back_populates="desk", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("type IN ('flex', 'fixed')", name="ck_desks_type"),
        CheckConstraint(
            "space_type IN ('desk','meeting_room','call_room','open_space','lounge')",
            name="ck_desks_space_type",
        ),
        Index("idx_desks_floor_id", "floor_id"),
    )


class Reservation(Base):
    __tablename__ = "reservations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    desk_id: Mapped[int] = mapped_column(
        ForeignKey("desks.id", ondelete="CASCADE"), nullable=False
    )
    # user_id stores the username string — intentionally NOT a FK to users.id
    # because the frontend passes display names, not DB integer IDs.
    user_id: Mapped[str] = mapped_column(String(120), nullable=False)
    reservation_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    end_time: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="active")
    checked_in_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[date] = mapped_column(
        Date, nullable=False, server_default=func.current_date()
    )

    desk: Mapped[Desk] = relationship("Desk", back_populates="reservations")

    __table_args__ = (
        CheckConstraint("status IN ('active', 'cancelled')", name="ck_reservations_status"),
        Index("idx_reservations_desk_date", "desk_id", "reservation_date"),
        Index("idx_reservations_user_id", "user_id"),
    )


class Policy(Base):
    __tablename__ = "policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    office_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("offices.id", ondelete="CASCADE"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    min_days_ahead: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    max_days_ahead: Mapped[int] = mapped_column(Integer, nullable=False, server_default="30")
    min_duration_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    max_duration_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    no_show_timeout_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="15"
    )
    max_bookings_per_day: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="1"
    )

    office: Mapped[Optional[Office]] = relationship("Office", back_populates="policies")

    __table_args__ = (
        CheckConstraint(
            "min_days_ahead >= 0 AND max_days_ahead >= 0",
            name="ck_policies_days_positive",
        ),
        CheckConstraint(
            "min_days_ahead <= max_days_ahead",
            name="ck_policies_days_order",
        ),
        CheckConstraint(
            "max_bookings_per_day >= 1",
            name="ck_policies_max_bookings_per_day",
        ),
        Index("idx_policies_office_id", "office_id"),
    )


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)


class FavoriteDesk(Base):
    __tablename__ = "favorite_desks"
    id      = Column(Integer, primary_key=True, index=True)
    user_id = Column(String(120), nullable=False, index=True)
    desk_id = Column(Integer, ForeignKey("desks.id", ondelete="CASCADE"), nullable=False)
    __table_args__ = (UniqueConstraint("user_id", "desk_id", name="uq_favorite_desk"),)


class FloorMapRevision(Base):
    __tablename__ = "floor_map_revisions"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    floor_id     = Column(Integer, ForeignKey("floors.id", ondelete="CASCADE"), nullable=False)
    status       = Column(String(20), nullable=False, server_default="draft")
    plan_svg     = Column(Text, nullable=True)
    desks_json   = Column(Text, nullable=False, server_default="[]")
    zones_json   = Column(Text, nullable=False, server_default="[]")
    version      = Column(Integer, nullable=False, server_default="1")
    created_at   = Column(DateTime(timezone=True), server_default=func.now())
    updated_at   = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    published_at = Column(DateTime(timezone=True), nullable=True)
    created_by   = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    layout_json  = Column(Text, nullable=True)   # canonical LayoutDocument JSON (v2 editor)

    __table_args__ = (
        CheckConstraint("status IN ('draft','published','archived')", name="ck_fmr_status"),
        Index("idx_fmr_floor_id", "floor_id"),
    )


class FloorLock(Base):
    """Floor-level edit lock so only one admin edits at a time."""
    __tablename__ = "floor_locks"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    floor_id   = Column(Integer, ForeignKey("floors.id", ondelete="CASCADE"), nullable=False, unique=True)
    locked_by  = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    locked_at  = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False)


class MapAuditLog(Base):
    """Audit trail for map publish/discard/rollback events."""
    __tablename__ = "map_audit_log"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    floor_id    = Column(Integer, ForeignKey("floors.id", ondelete="CASCADE"), nullable=False)
    user_id     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action      = Column(String(50), nullable=False)  # saved|published|discarded|rolled_back
    revision_id = Column(Integer, nullable=True)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    note        = Column(Text, nullable=True)

    __table_args__ = (Index("idx_mal_floor_id", "floor_id"),)
