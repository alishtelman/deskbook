from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import date, time
import io
from pathlib import Path
import shutil
import uuid
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from sqlalchemy import text

from . import crud, models, schemas, map_service, layout_service, svg_import
from .auth import get_password_hash, verify_password, create_access_token, require_admin, get_current_user
from .config import settings
from .database import Base, engine, get_db, SessionLocal

# Static files directory (matches docker-compose volume: ./backend/static:/app/static)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Import all models so they are registered with Base before create_all
    from . import models  # noqa: F401

    # Startup migration: add profile columns to existing users table if they don't exist yet
    _profile_migrations = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name   VARCHAR(255);",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS department  VARCHAR(120);",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS position    VARCHAR(120);",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone       VARCHAR(30);",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS user_status VARCHAR(20) NOT NULL DEFAULT 'available';",
        "ALTER TABLE IF EXISTS policies ADD COLUMN IF NOT EXISTS max_bookings_per_day INTEGER NOT NULL DEFAULT 1;",
        # Phase 5: replace zone with space_type on desks
        "ALTER TABLE desks ADD COLUMN IF NOT EXISTS space_type VARCHAR(30) NOT NULL DEFAULT 'desk';",
        "ALTER TABLE desks DROP COLUMN IF EXISTS zone;",
        # Tile dimensions (normalized 0-1)
        "ALTER TABLE desks ADD COLUMN IF NOT EXISTS w FLOAT NOT NULL DEFAULT 0.07;",
        "ALTER TABLE desks ADD COLUMN IF NOT EXISTS h FLOAT NOT NULL DEFAULT 0.05;",
    ]
    try:
        with engine.connect() as conn:
            for stmt in _profile_migrations:
                conn.execute(text(stmt))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS favorite_desks (
                    id      SERIAL PRIMARY KEY,
                    user_id VARCHAR(120) NOT NULL,
                    desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
                    CONSTRAINT uq_favorite_desk UNIQUE (user_id, desk_id)
                )
            """))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_favorite_desks_user_id ON favorite_desks(user_id)"))
            conn.commit()
    except Exception as _exc:
        print(f"[startup migration] Warning: {_exc}")

    # v2: floor map revision workflow
    try:
        with engine.connect() as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS floor_map_revisions (
                    id           SERIAL PRIMARY KEY,
                    floor_id     INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
                    status       VARCHAR(20) NOT NULL DEFAULT 'draft'
                                 CONSTRAINT ck_fmr_status CHECK (status IN ('draft','published','archived')),
                    plan_svg     TEXT,
                    desks_json   TEXT NOT NULL DEFAULT '[]',
                    zones_json   TEXT NOT NULL DEFAULT '[]',
                    version      INTEGER NOT NULL DEFAULT 1,
                    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                    published_at TIMESTAMPTZ,
                    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_fmr_floor_id ON floor_map_revisions(floor_id)"
            ))
            conn.execute(text(
                "ALTER TABLE floors ADD COLUMN IF NOT EXISTS published_map_revision_id"
                " INTEGER REFERENCES floor_map_revisions(id) ON DELETE SET NULL"
            ))
            conn.execute(text(
                "ALTER TABLE floors ADD COLUMN IF NOT EXISTS draft_map_revision_id"
                " INTEGER REFERENCES floor_map_revisions(id) ON DELETE SET NULL"
            ))
            conn.commit()
    except Exception as _exc:
        print(f"[startup migration v2] Warning: {_exc}")

    # v3 migration — layout_json column + locking + audit log
    try:
        with engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE floor_map_revisions ADD COLUMN IF NOT EXISTS layout_json TEXT"
            ))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS floor_locks (
                    id         SERIAL PRIMARY KEY,
                    floor_id   INTEGER NOT NULL UNIQUE REFERENCES floors(id) ON DELETE CASCADE,
                    locked_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    locked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                    expires_at TIMESTAMPTZ NOT NULL
                )
            """))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS map_audit_log (
                    id          SERIAL PRIMARY KEY,
                    floor_id    INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
                    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    action      VARCHAR(50) NOT NULL,
                    revision_id INTEGER,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                    note        TEXT
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_mal_floor_id ON map_audit_log(floor_id)"
            ))
            conn.commit()
    except Exception as _exc:
        print(f"[startup migration v3] Warning: {_exc}")

    Base.metadata.create_all(bind=engine)

    scheduler = AsyncIOScheduler()

    def run_noshow_check() -> None:
        db = SessionLocal()
        try:
            count = crud.cancel_noshow_reservations(db)
            if count:
                print(f"[no-show] Cancelled {count} reservations")
        finally:
            db.close()

    scheduler.add_job(run_noshow_check, "interval", minutes=1)
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="Desk Booking API", version="0.1.0", lifespan=lifespan)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.post("/auth/register", response_model=schemas.UserResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: schemas.UserRegister, db: Session = Depends(get_db)) -> models.User:
    # Block admin self-registration unless correct secret provided
    if payload.role == "admin":
        if (
            not settings.ADMIN_REGISTER_SECRET
            or payload.admin_secret != settings.ADMIN_REGISTER_SECRET
        ):
            raise HTTPException(
                status_code=403,
                detail="Admin registration requires a valid admin_secret",
            )
    if crud.get_user_by_username(db, payload.username):
        raise HTTPException(status_code=409, detail="Username already taken")
    if crud.get_user_by_email(db, payload.email):
        raise HTTPException(status_code=409, detail="Email already registered")
    return crud.create_user(
        db,
        username=payload.username,
        email=payload.email,
        hashed_password=get_password_hash(payload.password),
        role=payload.role,
    )


@app.post("/auth/login", response_model=schemas.Token)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
) -> schemas.Token:
    user = crud.get_user_by_username(db, form_data.username)
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = create_access_token({"sub": user.username, "role": user.role})
    return schemas.Token(access_token=token)


# ---------------------------------------------------------------------------
# Users (profiles)
# ---------------------------------------------------------------------------

@app.get("/users/search", response_model=list[schemas.UserWithLocation], tags=["users"])
async def search_users(
    q: str = Query(..., min_length=2, description="Поисковый запрос (мин. 2 символа)"),
    limit: int = Query(10, ge=1, le=50),
    date: Optional[str] = Query(None, description="Дата в формате YYYY-MM-DD"),
    start_time: Optional[str] = Query(None, description="Начало в формате HH:MM"),
    end_time: Optional[str] = Query(None, description="Конец в формате HH:MM"),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return crud.search_users(db, q, limit, date, start_time, end_time)


@app.get("/users", response_model=list[schemas.UserPublic])
async def list_users(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[models.User]:
    return crud.get_users(db)


# ---------------------------------------------------------------------------
# Team  (registered BEFORE /users/{username} to avoid route capture)
# ---------------------------------------------------------------------------

@app.get("/users/team", response_model=list[schemas.UserPublic], tags=["users"])
async def get_team(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[models.User]:
    return crud.get_team(db, current_user.username)


# ---------------------------------------------------------------------------
# Favorites  (registered BEFORE /users/{username} to avoid route capture)
# ---------------------------------------------------------------------------

@app.get("/users/me/favorites", response_model=list[schemas.Desk], tags=["favorites"])
async def list_favorites(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[models.Desk]:
    return crud.get_favorites(db, current_user.username)


@app.post("/users/me/favorites/{desk_id}", status_code=201, tags=["favorites"])
async def add_favorite(
    desk_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        crud.add_favorite(db, current_user.username, desk_id)
        return {"desk_id": desk_id}
    except ValueError as e:
        err = str(e)
        if err == "desk_not_found":
            raise HTTPException(404, "Стол не найден")
        raise HTTPException(409, "Уже в избранном")


@app.delete("/users/me/favorites/{desk_id}", status_code=204, response_class=Response, tags=["favorites"])
async def remove_favorite(
    desk_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    try:
        crud.remove_favorite(db, current_user.username, desk_id)
    except ValueError:
        raise HTTPException(404, "Не найдено в избранном")
    return Response(status_code=204)


@app.get("/users/{username}", response_model=schemas.UserPublic)
async def get_user(
    username: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.User:
    user = crud.get_user_by_username(db, username)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@app.patch("/users/{username}/profile", response_model=schemas.UserPublic)
async def update_user_profile(
    username: str,
    payload: schemas.UserProfileUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.User:
    if current_user.role != "admin" and current_user.username != username:
        raise HTTPException(status_code=403, detail="You can only edit your own profile")
    try:
        return crud.update_user_profile(db, username, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="User not found")


# ---------------------------------------------------------------------------
# Departments
# ---------------------------------------------------------------------------

@app.get("/departments", response_model=list[schemas.Department], tags=["departments"])
async def list_departments(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return crud.list_departments(db)


@app.post("/departments", response_model=schemas.Department, status_code=201, tags=["departments"])
async def create_department(
    payload: schemas.DepartmentCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(403, "Только для администраторов")
    try:
        return crud.create_department(db, payload.name)
    except ValueError:
        raise HTTPException(409, "Отдел с таким названием уже существует")


@app.delete("/departments/{dept_id}", status_code=204, response_class=Response, tags=["departments"])
async def delete_department(
    dept_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(403, "Только для администраторов")
    try:
        crud.delete_department(db, dept_id)
    except ValueError:
        raise HTTPException(404, "Отдел не найден")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health", response_model=schemas.Message)
async def health() -> schemas.Message:
    return schemas.Message(message="ok")


# ---------------------------------------------------------------------------
# Offices
# ---------------------------------------------------------------------------

@app.get("/offices", response_model=list[schemas.Office])
async def list_offices(db: Session = Depends(get_db)) -> list[models.Office]:
    return crud.list_offices(db)


@app.post(
    "/offices",
    response_model=schemas.Office,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_admin)],
)
async def create_office(
    payload: schemas.OfficeCreate, db: Session = Depends(get_db)
) -> models.Office:
    return crud.create_office(db, payload)


@app.patch(
    "/offices/{office_id}",
    response_model=schemas.Office,
    dependencies=[Depends(require_admin)],
)
async def update_office(
    office_id: int, payload: schemas.OfficeUpdate, db: Session = Depends(get_db)
) -> models.Office:
    try:
        return crud.update_office(db, office_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Office not found")


@app.delete(
    "/offices/{office_id}",
    response_model=schemas.Message,
    dependencies=[Depends(require_admin)],
)
async def delete_office(office_id: int, db: Session = Depends(get_db)) -> schemas.Message:
    try:
        crud.delete_office(db, office_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Office not found")
    return schemas.Message(message="deleted")


# ---------------------------------------------------------------------------
# Floors
# ---------------------------------------------------------------------------

@app.get("/floors", response_model=list[schemas.Floor])
async def list_floors(
    office_id: Optional[int] = Query(default=None), db: Session = Depends(get_db)
) -> list[models.Floor]:
    return crud.list_floors(db, office_id)


@app.post(
    "/floors",
    response_model=schemas.Floor,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_admin)],
)
async def create_floor(
    payload: schemas.FloorCreate, db: Session = Depends(get_db)
) -> models.Floor:
    try:
        return crud.create_floor(db, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Office not found")


@app.patch(
    "/floors/{floor_id}",
    response_model=schemas.Floor,
    dependencies=[Depends(require_admin)],
)
async def update_floor(
    floor_id: int, payload: schemas.FloorUpdate, db: Session = Depends(get_db)
) -> models.Floor:
    try:
        return crud.update_floor(db, floor_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Floor not found")


@app.delete(
    "/floors/{floor_id}",
    response_model=schemas.Message,
    dependencies=[Depends(require_admin)],
)
async def delete_floor(floor_id: int, db: Session = Depends(get_db)) -> schemas.Message:
    try:
        crud.delete_floor(db, floor_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Floor not found")
    return schemas.Message(message="deleted")


@app.post(
    "/floors/{floor_id}/plan",
    response_model=schemas.Floor,
    dependencies=[Depends(require_admin)],
)
async def upload_floor_plan(
    floor_id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> models.Floor:
    allowed_ct = {
        "image/png": ".png",
        "image/x-png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/pjpeg": ".jpg",
        "image/webp": ".webp",
    }
    if file.content_type not in allowed_ct:
        raise HTTPException(status_code=400, detail="Only PNG/JPG/JPEG/WEBP files are supported")

    extension = Path(file.filename or "").suffix.lower()
    if extension not in {".png", ".jpg", ".jpeg", ".webp"}:
        extension = allowed_ct[file.content_type]
    if extension == ".jpeg":
        extension = ".jpg"

    filename = f"floor_{floor_id}_{uuid.uuid4().hex}{extension}"
    destination = STATIC_DIR / filename
    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    plan_url = f"/api/static/{filename}"
    try:
        return crud.update_floor(db, floor_id, schemas.FloorUpdate(plan_url=plan_url))
    except KeyError:
        raise HTTPException(status_code=404, detail="Floor not found")


@app.post(
    "/floors/{floor_id}/desks-from-map",
    response_model=list[schemas.Desk],
    dependencies=[Depends(require_admin)],
)
async def create_desks_from_map(
    floor_id: int,
    payload: list[schemas.DeskFromMap],
    db: Session = Depends(get_db),
) -> list[models.Desk]:
    if not payload:
        raise HTTPException(status_code=400, detail="Desk list cannot be empty")
    try:
        return crud.create_desks_from_map(db, floor_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Floor not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# ---------------------------------------------------------------------------
# Floor map revisions (SVG-based editor — draft/published workflow)
# ---------------------------------------------------------------------------

@app.get("/floors/{floor_id}/map", response_model=schemas.FloorMapRevisionResponse, dependencies=[Depends(require_admin)])
async def get_floor_map(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.FloorMapRevisionResponse:
    """Admin: returns draft if one exists, otherwise published. 404 if neither."""
    result = map_service.get_draft_or_published(db, floor_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No map revision found for this floor")
    return result


@app.get("/floors/{floor_id}/map/published", response_model=schemas.FloorMapRevisionResponse)
async def get_published_floor_map(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.FloorMapRevisionResponse:
    """Any authenticated user: returns only the published revision. 404 if none."""
    try:
        result = map_service.get_published_response(db, floor_id)
    except map_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if result is None:
        raise HTTPException(status_code=404, detail="No published map for this floor")
    return result


@app.put(
    "/floors/{floor_id}/map/draft",
    response_model=schemas.FloorMapRevisionResponse,
    dependencies=[Depends(require_admin)],
)
async def save_floor_map_draft(
    floor_id: int,
    payload: schemas.FloorMapRevisionPayload,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.FloorMapRevisionResponse:
    """Admin: save full draft snapshot."""
    try:
        return map_service.save_draft_revision(db, floor_id, payload, user_id=current_user.id)
    except map_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except map_service.ConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post(
    "/floors/{floor_id}/map/draft/plan-svg",
    response_model=schemas.FloorMapRevisionResponse,
    dependencies=[Depends(require_admin)],
)
async def upload_floor_plan_svg(
    floor_id: int,
    request: Request,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.FloorMapRevisionResponse:
    """Admin: upload raw SVG body (max 5 MB). Sanitized and stored in draft."""
    raw_svg = (await request.body()).decode("utf-8", errors="replace")
    try:
        return map_service.upload_svg_to_draft(db, floor_id, raw_svg, user_id=current_user.id)
    except map_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post(
    "/floors/{floor_id}/map/publish",
    response_model=schemas.FloorMapRevisionResponse,
    dependencies=[Depends(require_admin)],
)
async def publish_floor_map(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.FloorMapRevisionResponse:
    """Admin: atomically publish the current draft revision."""
    try:
        return map_service.publish_draft_revision(db, floor_id, user_id=current_user.id)
    except map_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete(
    "/floors/{floor_id}/map/draft",
    status_code=204,
    response_class=Response,
    dependencies=[Depends(require_admin)],
)
async def discard_floor_map_draft(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Admin: discard draft revision. 204 no-op if no draft exists."""
    try:
        map_service.discard_draft_revision(db, floor_id)
    except map_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Layout v2 — canonical LayoutDocument CRUD + lock + import
# ---------------------------------------------------------------------------

@app.get("/floors/{floor_id}/layout", response_model=schemas.LayoutDocumentResponse,
         dependencies=[Depends(require_admin)])
async def get_floor_layout(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.LayoutDocumentResponse:
    result = layout_service.get_draft_or_published(db, floor_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No layout found for this floor")
    return result


@app.get("/floors/{floor_id}/layout/published", response_model=schemas.LayoutDocumentResponse)
async def get_floor_layout_published(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.LayoutDocumentResponse:
    try:
        result = layout_service.get_published(db, floor_id)
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if result is None:
        raise HTTPException(status_code=404, detail="No published layout")
    return result


@app.put("/floors/{floor_id}/layout/draft", response_model=schemas.LayoutDocumentResponse,
         dependencies=[Depends(require_admin)])
async def save_floor_layout_draft(
    floor_id: int,
    request: Request,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.LayoutDocumentResponse:
    """Admin: save canonical layout document. Body: {version, layout: LayoutDocument}."""
    try:
        body = await request.json()
        version = int(body.get("version", 0))
        doc = schemas.LayoutDocument(**body.get("layout", {}))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    try:
        return layout_service.save_draft(db, floor_id, doc, version, user_id=current_user.id)
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except layout_service.ConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/floors/{floor_id}/layout/publish", response_model=schemas.LayoutDocumentResponse,
          dependencies=[Depends(require_admin)])
async def publish_floor_layout(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.LayoutDocumentResponse:
    try:
        return layout_service.publish(db, floor_id, user_id=current_user.id)
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/floors/{floor_id}/layout/sync-desks", response_model=schemas.LayoutDeskSyncResult,
          dependencies=[Depends(require_admin)])
async def sync_floor_layout_desks(
    floor_id: int,
    source: str = Query("published", pattern="^(published|draft)$"),
    cleanup: bool = Query(False),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.LayoutDeskSyncResult:
    try:
        return layout_service.sync_desks_for_floor(
            db, floor_id, source=source, cleanup=cleanup, user_id=current_user.id
        )
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/floors/{floor_id}/layout/draft", status_code=204, response_class=Response,
            dependencies=[Depends(require_admin)])
async def discard_floor_layout_draft(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    layout_service.discard(db, floor_id, user_id=current_user.id)
    return Response(status_code=204)


@app.get("/floors/{floor_id}/layout/history", response_model=list[schemas.AuditLogEntry],
         dependencies=[Depends(require_admin)])
async def get_floor_layout_history(
    floor_id: int,
    db: Session = Depends(get_db),
) -> list[schemas.AuditLogEntry]:
    try:
        return layout_service.get_history(db, floor_id)
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/floors/{floor_id}/layout/revisions", response_model=list[schemas.LayoutRevisionSummary],
         dependencies=[Depends(require_admin)])
async def get_floor_layout_revisions(
    floor_id: int,
    limit: int = Query(100, ge=1, le=300),
    db: Session = Depends(get_db),
) -> list[schemas.LayoutRevisionSummary]:
    try:
        return layout_service.list_revisions(db, floor_id, limit=limit)
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/floors/{floor_id}/layout/revisions/{revision_id}", response_model=schemas.LayoutDocumentResponse,
         dependencies=[Depends(require_admin)])
async def get_floor_layout_revision(
    floor_id: int,
    revision_id: int,
    db: Session = Depends(get_db),
) -> schemas.LayoutDocumentResponse:
    try:
        return layout_service.get_revision(db, floor_id, revision_id)
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/floors/{floor_id}/layout/revisions/{revision_id}/restore", response_model=schemas.LayoutDocumentResponse,
          dependencies=[Depends(require_admin)])
async def restore_floor_layout_revision(
    floor_id: int,
    revision_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.LayoutDocumentResponse:
    try:
        return layout_service.restore_revision_to_draft(db, floor_id, revision_id, user_id=current_user.id)
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# Lock management
@app.post("/floors/{floor_id}/lock", response_model=schemas.FloorLockOut,
          dependencies=[Depends(require_admin)])
async def acquire_floor_lock(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.FloorLockOut:
    try:
        return layout_service.acquire_lock(db, floor_id, current_user.id)
    except layout_service.NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except layout_service.LockError as exc:
        raise HTTPException(status_code=423, detail=str(exc))


@app.delete("/floors/{floor_id}/lock", status_code=204, response_class=Response,
            dependencies=[Depends(require_admin)])
async def release_floor_lock(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    layout_service.release_lock(db, floor_id, current_user.id)
    return Response(status_code=204)


@app.get("/floors/{floor_id}/lock")
async def get_floor_lock(
    floor_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    lock = layout_service.get_lock(db, floor_id)
    if lock is None:
        return {"locked": False}
    return {"locked": True, **lock.model_dump()}


# SVG import classifier
@app.post("/floors/{floor_id}/layout/import", response_model=schemas.ImportResult,
          dependencies=[Depends(require_admin)])
async def import_floor_svg(
    floor_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> schemas.ImportResult:
    raw_svg = (await request.body()).decode("utf-8", errors="replace")
    try:
        return svg_import.classify_svg(raw_svg)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Floor reservations (floor map view — all active bookings for a floor)
# ---------------------------------------------------------------------------

@app.get("/floors/{floor_id}/reservations", response_model=list[schemas.Reservation])
async def list_floor_reservations(
    floor_id: int,
    date: Optional[date] = Query(default=None),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[models.Reservation]:
    """All active reservations for a floor on a given date. JWT required (any role)."""
    desks = db.query(models.Desk).filter(models.Desk.floor_id == floor_id).all()
    desk_ids = {d.id for d in desks}
    if not desk_ids:
        return []
    q = db.query(models.Reservation).filter(
        models.Reservation.desk_id.in_(desk_ids),
        models.Reservation.status == "active",
    )
    if date:
        q = q.filter(models.Reservation.reservation_date == date)
    return q.all()


# ---------------------------------------------------------------------------
# Desks
# ---------------------------------------------------------------------------

@app.get("/desks", response_model=list[schemas.Desk])
async def list_desks(
    floor_id: Optional[int] = Query(default=None), db: Session = Depends(get_db)
) -> list[models.Desk]:
    return crud.list_desks(db, floor_id)


@app.patch(
    "/desks/{desk_id}",
    response_model=schemas.Desk,
    dependencies=[Depends(require_admin)],
)
async def update_desk(
    desk_id: int, payload: schemas.DeskUpdate, db: Session = Depends(get_db)
) -> models.Desk:
    try:
        return crud.update_desk(db, desk_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Desk not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.delete(
    "/desks/{desk_id}",
    response_model=schemas.Message,
    dependencies=[Depends(require_admin)],
)
async def delete_desk(desk_id: int, db: Session = Depends(get_db)) -> schemas.Message:
    try:
        crud.delete_desk(db, desk_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Desk not found")
    return schemas.Message(message="deleted")


@app.get("/desks/{desk_id}/qr", dependencies=[Depends(require_admin)])
async def get_desk_qr(
    desk_id: int, request: Request, db: Session = Depends(get_db)
) -> StreamingResponse:
    """Return a QR code PNG that encodes the check-in URL for a desk."""
    import qrcode  # imported here so startup is not blocked if qrcode is missing

    desk = db.query(models.Desk).filter(models.Desk.id == desk_id).first()
    if not desk:
        raise HTTPException(status_code=404, detail="Desk not found")

    checkin_url = f"{settings.FRONTEND_URL}/checkin.html?token={desk.qr_token}"
    qr = qrcode.QRCode(box_size=8, border=2)
    qr.add_data(checkin_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@app.post("/checkin/{qr_token}", response_model=schemas.Reservation)
async def checkin(
    qr_token: str,
    user_id: str = Query(...),
    db: Session = Depends(get_db),
) -> models.Reservation:
    """Check in to an active reservation via QR token.

    The QR token is embedded in the QR code printed on/near each desk.
    Callers must supply their user_id as a query parameter.
    """
    try:
        return crud.checkin_reservation(db, qr_token, user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Desk not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------

@app.get("/availability", response_model=schemas.AvailabilityResponse)
async def check_availability(
    desk_id: int = Query(..., gt=0),
    reservation_date: date = Query(...),
    start_time: time = Query(...),
    end_time: time = Query(...),
    user_id: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
) -> schemas.AvailabilityResponse:
    if start_time >= end_time:
        raise HTTPException(status_code=400, detail="Start time must be before end time")
    try:
        return crud.check_availability(db, desk_id, reservation_date, start_time, end_time, user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Desk not found")


@app.post("/availability/batch", response_model=schemas.AvailabilityBatchResponse)
async def check_availability_batch(
    payload: schemas.AvailabilityBatchRequest,
    db: Session = Depends(get_db),
) -> schemas.AvailabilityBatchResponse:
    if payload.start_time >= payload.end_time:
        raise HTTPException(status_code=400, detail="Start time must be before end time")

    items: list[schemas.AvailabilityBatchItem] = []
    for desk_id in payload.desk_ids:
        try:
            result = crud.check_availability(
                db=db,
                desk_id=desk_id,
                reservation_date=payload.reservation_date,
                start_time=payload.start_time,
                end_time=payload.end_time,
                user_id=payload.user_id,
            )
            items.append(
                schemas.AvailabilityBatchItem(
                    desk_id=desk_id,
                    available=result.available,
                    reason=result.reason,
                )
            )
        except KeyError:
            items.append(
                schemas.AvailabilityBatchItem(
                    desk_id=desk_id,
                    available=False,
                    reason="Desk not found",
                )
            )

    return schemas.AvailabilityBatchResponse(items=items)


# ---------------------------------------------------------------------------
# Reservations
# ---------------------------------------------------------------------------

@app.get("/reservations", response_model=list[schemas.Reservation])
async def list_reservations(
    desk_id: Optional[int] = Query(default=None),
    reservation_date: Optional[date] = Query(default=None),
    user_id: Optional[str] = Query(default=None),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    office_id: Optional[int] = Query(default=None),
    status: Optional[str] = Query(default=None),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[models.Reservation]:
    # Regular users can only see their own reservations
    if current_user.role != "admin":
        user_id = current_user.username
    return crud.list_reservations(
        db, desk_id, reservation_date, user_id, date_from, date_to, office_id, status
    )


@app.post("/reservations", response_model=schemas.Reservation, status_code=status.HTTP_201_CREATED)
async def create_reservation(
    payload: schemas.ReservationCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.Reservation:
    # Force user_id from JWT — do not trust the request body
    payload.user_id = current_user.username
    if payload.start_time >= payload.end_time:
        raise HTTPException(status_code=400, detail="Start time must be before end time")
    try:
        return crud.create_reservation(db, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Desk not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/reservations/batch", response_model=schemas.ReservationBatchResult)
async def create_reservations_batch(
    payload: schemas.ReservationBatchCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.ReservationBatchResult:
    """Create recurring/batch reservations for multiple dates in one request.

    Each date is attempted independently — conflicts on individual dates are
    collected in `skipped` rather than failing the whole request.  Returns
    HTTP 409 only when every requested date was skipped or errored.
    """
    if payload.start_time >= payload.end_time:
        raise HTTPException(status_code=400, detail="Start time must be before end time")
    try:
        result = crud.create_reservations_batch(db, current_user.username, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Desk not found")
    # If nothing was created at all, signal a conflict
    if not result.created:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "No reservations could be created",
                "skipped": [str(d) for d in result.skipped],
                "errors": result.errors,
            },
        )
    return result


@app.post("/reservations/{reservation_id}/cancel", response_model=schemas.Reservation)
async def cancel_reservation(
    reservation_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.Reservation:
    reservation = db.query(models.Reservation).filter(
        models.Reservation.id == reservation_id
    ).first()
    if reservation is None:
        raise HTTPException(status_code=404, detail="Reservation not found")
    if current_user.role != "admin" and reservation.user_id != current_user.username:
        raise HTTPException(status_code=403, detail="You can only cancel your own reservations")
    if reservation.status == "cancelled":
        raise HTTPException(status_code=409, detail="Reservation is already cancelled")
    reservation.status = "cancelled"
    db.commit()
    db.refresh(reservation)
    return reservation


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

@app.get("/analytics", response_model=schemas.AnalyticsResponse, dependencies=[Depends(require_admin)])
async def get_analytics(db: Session = Depends(get_db)) -> schemas.AnalyticsResponse:
    return crud.get_analytics(db)


# ---------------------------------------------------------------------------
# Policies
# ---------------------------------------------------------------------------

@app.get("/policies", response_model=list[schemas.Policy])
async def list_policies(
    office_id: Optional[int] = Query(default=None), db: Session = Depends(get_db)
) -> list[models.Policy]:
    return crud.list_policies(db, office_id)


@app.post(
    "/policies",
    response_model=schemas.Policy,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_admin)],
)
async def create_policy(
    payload: schemas.PolicyCreate, db: Session = Depends(get_db)
) -> models.Policy:
    try:
        return crud.create_policy(db, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Office not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.patch(
    "/policies/{policy_id}",
    response_model=schemas.Policy,
    dependencies=[Depends(require_admin)],
)
async def update_policy(
    policy_id: int, payload: schemas.PolicyUpdate, db: Session = Depends(get_db)
) -> models.Policy:
    try:
        return crud.update_policy(db, policy_id, payload)
    except KeyError as exc:
        if exc.args and exc.args[0] == "office":
            raise HTTPException(status_code=404, detail="Office not found")
        raise HTTPException(status_code=404, detail="Policy not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.delete(
    "/policies/{policy_id}",
    response_model=schemas.Message,
    dependencies=[Depends(require_admin)],
)
async def delete_policy(policy_id: int, db: Session = Depends(get_db)) -> schemas.Message:
    try:
        crud.delete_policy(db, policy_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Policy not found")
    return schemas.Message(message="deleted")
