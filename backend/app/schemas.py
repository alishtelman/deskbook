from __future__ import annotations

from datetime import date, datetime, time
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, PositiveInt, field_validator, model_validator


def _validate_password(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Пароль должен содержать минимум 8 символов")
    if not any(c.isdigit() for c in v):
        raise ValueError("Пароль должен содержать хотя бы одну цифру")
    if not any(c.isalpha() for c in v):
        raise ValueError("Пароль должен содержать хотя бы одну букву")
    return v


def _strip(value: Optional[str]) -> Optional[str]:
    if value is None:
        return value
    return value.strip()


class OfficeBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    address: Optional[str] = Field(None, max_length=300)

    def model_post_init(self, __context: object) -> None:
        self.name = _strip(self.name) or ""
        if self.address is not None:
            self.address = _strip(self.address)


class OfficeCreate(OfficeBase):
    pass


class Office(OfficeBase):
    model_config = ConfigDict(from_attributes=True)
    id: PositiveInt


class OfficeUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    address: Optional[str] = Field(None, max_length=300)

    def model_post_init(self, __context: object) -> None:
        if self.name is not None:
            self.name = _strip(self.name) or ""
        if self.address is not None:
            self.address = _strip(self.address)


class FloorBase(BaseModel):
    office_id: PositiveInt
    name: str = Field(..., min_length=1, max_length=120)
    plan_url: Optional[str] = Field(None, max_length=500)

    def model_post_init(self, __context: object) -> None:
        self.name = _strip(self.name) or ""
        if self.plan_url is not None:
            self.plan_url = _strip(self.plan_url) or None


class FloorCreate(FloorBase):
    pass


class Floor(FloorBase):
    model_config = ConfigDict(from_attributes=True)
    id: PositiveInt
    has_published_map: bool = False
    has_draft_map: bool = False


class FloorUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    plan_url: Optional[str] = Field(None, max_length=500)

    def model_post_init(self, __context: object) -> None:
        if self.name is not None:
            self.name = _strip(self.name) or ""
        if self.plan_url is not None:
            self.plan_url = _strip(self.plan_url) or None


class DeskBase(BaseModel):
    floor_id: PositiveInt
    label: str = Field(..., min_length=1, max_length=40)
    type: str = Field("flex", pattern="^(flex|fixed)$")
    space_type: str = Field("desk", pattern="^(desk|meeting_room|call_room|open_space|lounge)$")
    assigned_to: Optional[str] = Field(None, max_length=120)
    position_x: Optional[float] = Field(None, ge=0, le=1)
    position_y: Optional[float] = Field(None, ge=0, le=1)
    w: float = Field(0.07, ge=0.01, le=1)
    h: float = Field(0.05, ge=0.01, le=1)

    def model_post_init(self, __context: object) -> None:
        self.label = _strip(self.label) or ""
        if self.assigned_to is not None:
            self.assigned_to = _strip(self.assigned_to) or None


class DeskCreate(DeskBase):
    pass


class DeskFromMap(BaseModel):
    label: str = Field(..., min_length=1, max_length=40)
    type: str = Field("flex", pattern="^(flex|fixed)$")
    space_type: str = Field("desk", pattern="^(desk|meeting_room|call_room|open_space|lounge)$")
    assigned_to: Optional[str] = Field(None, max_length=120)
    position_x: float = Field(..., ge=0, le=1)
    position_y: float = Field(..., ge=0, le=1)
    w: float = Field(0.07, ge=0.01, le=1)
    h: float = Field(0.05, ge=0.01, le=1)

    def model_post_init(self, __context: object) -> None:
        self.label = (self.label or "").strip()
        if self.assigned_to is not None:
            self.assigned_to = self.assigned_to.strip() or None


class Desk(DeskBase):
    model_config = ConfigDict(from_attributes=True)
    id: PositiveInt
    qr_token: str


class DeskUpdate(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=40)
    type: Optional[str] = Field(None, pattern="^(flex|fixed)$")
    space_type: Optional[str] = Field(None, pattern="^(desk|meeting_room|call_room|open_space|lounge)$")
    assigned_to: Optional[str] = Field(None, max_length=120)
    position_x: Optional[float] = Field(None, ge=0, le=1)
    position_y: Optional[float] = Field(None, ge=0, le=1)

    def model_post_init(self, __context: object) -> None:
        if self.label is not None:
            self.label = _strip(self.label) or ""
        if self.assigned_to is not None:
            self.assigned_to = _strip(self.assigned_to) or None


class ReservationBase(BaseModel):
    desk_id: PositiveInt
    user_id: str = Field(..., min_length=1, max_length=120)
    reservation_date: date
    start_time: time
    end_time: time

    def model_post_init(self, __context: object) -> None:
        self.user_id = _strip(self.user_id) or ""


class ReservationCreate(ReservationBase):
    pass


class Reservation(ReservationBase):
    model_config = ConfigDict(from_attributes=True)
    id: PositiveInt
    status: str = Field("active", pattern="^(active|cancelled)$")
    checked_in_at: Optional[datetime] = None


class AvailabilityResponse(BaseModel):
    available: bool
    reason: Optional[str] = None


class AvailabilityBatchRequest(BaseModel):
    desk_ids: list[int] = Field(..., min_length=1, max_length=500)
    reservation_date: date
    start_time: time
    end_time: time
    user_id: Optional[str] = None


class AvailabilityBatchItem(BaseModel):
    desk_id: int
    available: bool
    reason: Optional[str] = None


class AvailabilityBatchResponse(BaseModel):
    results: list[AvailabilityBatchItem]


# ---------------------------------------------------------------------------
# Batch reservations
# ---------------------------------------------------------------------------

class ReservationBatchCreate(BaseModel):
    desk_id: PositiveInt
    dates: list[date] = Field(..., min_length=1, max_length=60)
    start_time: time = Field(..., description="Start time in HH:MM format")
    end_time: time = Field(..., description="End time in HH:MM format")


class ReservationBatchResult(BaseModel):
    created: list[Reservation]
    skipped: list[date]
    errors: list[str]


class PolicyBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    office_id: Optional[PositiveInt] = None
    min_days_ahead: int = Field(0, ge=0, le=365)
    max_days_ahead: int = Field(30, ge=0, le=365)
    min_duration_minutes: int = Field(30, ge=15, le=1440)
    max_duration_minutes: int = Field(480, ge=15, le=1440)
    no_show_timeout_minutes: int = Field(15, ge=0, le=120)
    max_bookings_per_day: int = Field(1, ge=1, le=10)

    def model_post_init(self, __context: object) -> None:
        self.name = _strip(self.name) or ""


class PolicyCreate(PolicyBase):
    pass


class Policy(PolicyBase):
    model_config = ConfigDict(from_attributes=True)
    id: PositiveInt


class PolicyUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    office_id: Optional[PositiveInt] = None
    min_days_ahead: Optional[int] = Field(None, ge=0, le=365)
    max_days_ahead: Optional[int] = Field(None, ge=0, le=365)
    min_duration_minutes: Optional[int] = Field(None, ge=15, le=1440)
    max_duration_minutes: Optional[int] = Field(None, ge=15, le=1440)
    no_show_timeout_minutes: Optional[int] = Field(None, ge=0, le=120)
    max_bookings_per_day: Optional[int] = Field(None, ge=1, le=10)

    def model_post_init(self, __context: object) -> None:
        if self.name is not None:
            self.name = _strip(self.name) or ""


class DeskStat(BaseModel):
    desk_id: int
    label: str
    floor_name: str
    office_name: str
    total: int


class UserStat(BaseModel):
    user_id: str
    total: int


class AnalyticsResponse(BaseModel):
    total_today: int
    total_active: int
    total_cancelled: int
    noshow_rate: float
    occupancy_by_office: list[dict]
    top_desks: list[DeskStat]
    top_users: list[UserStat]


class Message(BaseModel):
    message: str


class PasswordChange(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)

    @field_validator("new_password")
    @classmethod
    def password_complexity(cls, v: str) -> str:
        return _validate_password(v)


# ---------------------------------------------------------------------------
# Auth schemas
# ---------------------------------------------------------------------------

class UserRegister(BaseModel):
    username: str = Field(..., min_length=2, max_length=120)
    email: str = Field(..., max_length=320)
    password: str = Field(..., min_length=8)
    role: str = Field("user", pattern="^(admin|user)$")
    admin_secret: Optional[str] = None

    @field_validator("password")
    @classmethod
    def password_complexity(cls, v: str) -> str:
        return _validate_password(v)


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: PositiveInt
    username: str
    email: str
    role: str
    full_name: Optional[str] = None
    department: Optional[str] = None
    position: Optional[str] = None
    phone: Optional[str] = None
    user_status: str = "available"
    is_active: bool = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    full_name: Optional[str] = None
    department: Optional[str] = None
    position: Optional[str] = None
    phone: Optional[str] = None
    user_status: str = "available"
    is_active: bool = True


class UserLocation(BaseModel):
    desk_id: int
    desk_label: Optional[str] = None
    floor_id: int
    floor_name: Optional[str] = None
    office_id: int
    office_name: Optional[str] = None


class UserWithLocation(UserPublic):
    location: Optional[UserLocation] = None


class UserProfileUpdate(BaseModel):
    full_name: Optional[str] = Field(None, max_length=255)
    department: Optional[str] = Field(None, max_length=120)
    position: Optional[str] = Field(None, max_length=120)
    phone: Optional[str] = Field(None, max_length=30)
    user_status: Optional[str] = Field(None, pattern="^(available|busy|away)$")


# ---------------------------------------------------------------------------
# Departments
# ---------------------------------------------------------------------------

class DepartmentCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class Department(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


# ---------------------------------------------------------------------------
# Favorites
# ---------------------------------------------------------------------------

class FavoriteCreate(BaseModel):
    desk_id: PositiveInt


class FavoriteItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    desk_id: int


class UserAdminUpdate(BaseModel):
    role: Optional[str] = Field(None, pattern="^(admin|user)$")
    is_active: Optional[bool] = None


# ---------------------------------------------------------------------------
# Floor map revision (SVG-based editor)
# ---------------------------------------------------------------------------

class Point(BaseModel):
    x: float
    y: float

    @field_validator("x", "y")
    @classmethod
    def must_be_finite(cls, v: float) -> float:
        import math
        if not math.isfinite(v):
            raise ValueError("coordinates must be finite numbers")
        return v


class MapDesk(BaseModel):
    id: Optional[str] = None          # UUID v4, generated by frontend
    label: str = Field(..., min_length=1, max_length=40)
    type: str = Field("flex", pattern="^(flex|fixed)$")
    space_type: str = Field("desk", pattern="^(desk|meeting_room|call_room|open_space|lounge)$")
    assigned_to: Optional[str] = Field(None, max_length=120)
    x: float
    y: float
    w: float
    h: float

    @field_validator("x", "y", "w", "h")
    @classmethod
    def must_be_finite(cls, v: float) -> float:
        import math
        if not math.isfinite(v):
            raise ValueError("coordinates must be finite numbers")
        return v


class MapZone(BaseModel):
    id: str = Field(..., min_length=1, max_length=36)   # UUID v4 from frontend
    name: str = Field(..., min_length=1, max_length=120)
    space_type: str = Field("open_space", pattern="^(desk|meeting_room|call_room|open_space|lounge)$")
    color: Optional[str] = Field(None, pattern="^#[0-9a-fA-F]{3,6}$")
    points: list[Point] = Field(..., min_length=3, max_length=500)


class FloorMapRevisionPayload(BaseModel):
    plan_svg: Optional[str] = None
    desks: list[MapDesk] = Field(default_factory=list, max_length=2000)
    zones: list[MapZone] = Field(default_factory=list, max_length=500)
    version: int

    @model_validator(mode="after")
    def check_svg_required(self) -> "FloorMapRevisionPayload":
        if self.plan_svg is None and (self.desks or self.zones):
            raise ValueError("plan_svg is required when desks or zones are present")
        return self


class FloorMapRevisionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    floor_id: int
    status: str
    plan_svg: Optional[str]
    desks: list[MapDesk]
    zones: list[MapZone]
    version: int
    published_at: Optional[datetime]
    updated_at: Optional[datetime]


# ── Layout v2 canonical schemas ────────────────────────────────────────────────

class StructureElement(BaseModel):
    """A wall, boundary, partition, or door in the layout."""
    id: str
    pts: list[list[float]]      # [[x, y], ...]  — at least 2 points
    thick: float = 4.0
    closed: bool = False
    label: Optional[str] = None
    label_size: Optional[float] = Field(None, gt=0, le=120)
    label_pos: Optional[str] = Field(None, pattern="^(center|top|bottom|left|right)$")
    label_angle: Optional[float] = Field(None, ge=-180, le=180)
    color: Optional[str] = Field(None, pattern="^#[0-9a-fA-F]{3,6}$")
    locked: bool = False
    conf: float = Field(1.0, ge=0.0, le=1.0)  # import confidence 0–1


class LayoutDesk(BaseModel):
    id: str
    label: str = Field(..., min_length=1, max_length=40)
    name: Optional[str] = Field(None, max_length=120)
    team: Optional[str] = Field(None, max_length=120)
    dept: Optional[str] = Field(None, max_length=120)
    bookable: bool = True
    fixed: bool = False
    assigned_to: Optional[str] = Field(None, max_length=120)
    status: str = Field("available", pattern="^(available|occupied|disabled)$")
    x: float
    y: float
    w: float
    h: float
    r: float = 0.0   # rotation degrees
    locked: bool = False


class LayoutBackgroundTransform(BaseModel):
    x: float
    y: float
    w: float = Field(..., gt=0)
    h: float = Field(..., gt=0)


class LayoutDocument(BaseModel):
    """Canonical floor layout — stored as layout_json in FloorMapRevision."""
    v: int = 2
    vb: list[float] = Field(default_factory=lambda: [0.0, 0.0, 1000.0, 1000.0])  # [x,y,w,h]
    bg_url: Optional[str] = None
    bg_transform: Optional[LayoutBackgroundTransform] = None
    walls: list[StructureElement] = Field(default_factory=list, max_length=5000)
    boundaries: list[StructureElement] = Field(default_factory=list, max_length=1000)
    partitions: list[StructureElement] = Field(default_factory=list, max_length=5000)
    doors: list[StructureElement] = Field(default_factory=list, max_length=5000)
    desks: list[LayoutDesk] = Field(default_factory=list, max_length=2000)


class LayoutDocumentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    revision_id: int
    floor_id: int
    status: str
    version: int
    updated_at: Optional[datetime]
    published_at: Optional[datetime]
    layout: LayoutDocument


class LayoutRevisionSummary(BaseModel):
    revision_id: int
    floor_id: int
    status: str
    version: int
    created_at: Optional[datetime]
    updated_at: Optional[datetime]
    published_at: Optional[datetime]
    created_by_id: Optional[int]
    created_by_username: Optional[str]
    is_current_published: bool = False
    is_current_draft: bool = False


class LayoutDeskSyncResult(BaseModel):
    floor_id: int
    revision_id: int
    source_status: str
    created: int
    updated: int
    renamed: int
    total_layout_desks: int
    unmatched_existing: int
    deleted: int = 0
    protected_with_active_reservations: int = 0


class FloorLockOut(BaseModel):
    floor_id: int
    locked_by_id: int
    locked_by_username: str
    locked_at: datetime
    expires_at: datetime


class ImportStats(BaseModel):
    total_elements: int
    walls: int
    boundaries: int
    partitions: int
    doors: int
    uncertain: int
    skipped: int


class ImportResult(BaseModel):
    walls: list[StructureElement] = Field(default_factory=list)
    boundaries: list[StructureElement] = Field(default_factory=list)
    partitions: list[StructureElement] = Field(default_factory=list)
    doors: list[StructureElement] = Field(default_factory=list)
    uncertain: list[StructureElement] = Field(default_factory=list)
    stats: ImportStats
    vb: list[float]   # detected viewBox [x,y,w,h]


class AuditLogEntry(BaseModel):
    id: int
    floor_id: int
    user_id: Optional[int]
    action: str
    revision_id: Optional[int]
    created_at: datetime
    note: Optional[str]
