# Backend API Builder Memory

## Stack (DO-main project)
- FastAPI 0.111.0 + SQLAlchemy 2.0.30 (ORM, mapped_column style)
- PostgreSQL via psycopg2-binary; no Alembic — uses `Base.metadata.create_all` at startup
- Pydantic v2 (ConfigDict, model_dump, model_post_init)
- JWT auth via python-jose; bcrypt via bcrypt package (not passlib)
- APScheduler 3.10.4 (AsyncIOScheduler) for background jobs

## Project Structure
- `/backend/app/models.py` — SQLAlchemy ORM models
- `/backend/app/schemas.py` — Pydantic request/response schemas
- `/backend/app/crud.py` — all DB operations (no raw SQL)
- `/backend/app/main.py` — FastAPI routes + lifespan (scheduler, create_all)
- `/backend/app/auth.py` — JWT helpers + require_admin dependency
- `/backend/app/database.py` — engine, SessionLocal, Base, get_db
- `/backend/app/config.py` — pydantic-settings config

## Key Conventions
- Response schemas inherit from Base schemas; read-only fields (id, qr_token, checked_in_at) added only on the response class, NOT on Create/Update schemas
- `model_post_init` used for field normalization (strip whitespace)
- CRUD raises `KeyError("entity_name")` for not-found, `ValueError("message")` for business rule violations; routes catch and convert to HTTPException
- user_id in reservations is a plain string (username), NOT a FK to users.id — intentional design for frontend compatibility
- `require_admin` is a FastAPI dependency injected via `dependencies=[Depends(require_admin)]`

## Phase 2 Features Added
- `Desk.qr_token`: UUID string generated in `crud.create_desk` via `str(uuid.uuid4())`
- `Reservation.checked_in_at`: nullable timezone-aware DateTime
- `GET /desks/{desk_id}/qr`: admin-only, returns PNG StreamingResponse via qrcode lib
- `POST /checkin/{qr_token}?user_id=`: public check-in endpoint
- `cancel_noshow_reservations`: scheduled every 1 min, walks Reservation->Desk->Floor->Office->Policy chain for per-office timeout

## Phase 3 Features Added
- `POST /reservations` now enforces Policy rules (min/max_days_ahead, min/max_duration_minutes) before creating a booking
  - Policy lookup: desk -> floor -> office -> Policy.office_id match; skips if no policy found
  - Raises ValueError (caught as 409) with Russian-language user-facing messages
- `GET /reservations` accepts 5 new query params: user_id, date_from, date_to, office_id, status
  - office_id filter joins Reservation -> Desk -> Floor to filter by office
  - Results ordered by reservation_date DESC, id DESC
- `GET /analytics` (admin-only): returns AnalyticsResponse with total_today, total_active, total_cancelled, noshow_rate, occupancy_by_office, top_desks, top_users
- New schemas in schemas.py: DeskStat, UserStat, AnalyticsResponse (placed before Message class)

## Patterns
- Background scheduler: AsyncIOScheduler started in lifespan, `run_noshow_check` creates its own SessionLocal session (not injected)
- qrcode imported lazily inside endpoint handler to avoid import-time failure if package missing
- `SessionLocal` is exported from database.py and imported directly in main.py for the scheduler job
- `func` and `desc` are imported from sqlalchemy in crud.py; `func` is also in models.py separately (both needed independently)
- Analytics duration computation uses integer arithmetic on .hour/.minute (not timedelta) to avoid time arithmetic pitfalls with time objects
- Analytics queries use scalar() for counts; occupancy loops over offices rather than a group-by-office aggregate
