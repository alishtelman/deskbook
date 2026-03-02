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
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from . import crud, models, schemas
from .auth import get_password_hash, verify_password, create_access_token, require_admin
from .config import settings
from .database import Base, engine, get_db, SessionLocal

# Static files directory (matches docker-compose volume: ./backend/static:/app/static)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Import all models so they are registered with Base before create_all
    from . import models  # noqa: F401
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
    if file.content_type not in {"image/png", "image/x-png"}:
        raise HTTPException(status_code=400, detail="Only PNG files are supported")
    extension = Path(file.filename or "").suffix.lower()
    if extension and extension != ".png":
        raise HTTPException(status_code=400, detail="Only PNG files are supported")
    filename = f"floor_{floor_id}_{uuid.uuid4().hex}.png"
    destination = STATIC_DIR / filename
    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    plan_url = f"{request.base_url}static/{filename}"
    try:
        return crud.update_floor(db, floor_id, schemas.FloorUpdate(plan_url=plan_url))
    except KeyError:
        raise HTTPException(status_code=404, detail="Floor not found")


# ---------------------------------------------------------------------------
# Desks
# ---------------------------------------------------------------------------

@app.get("/desks", response_model=list[schemas.Desk])
async def list_desks(
    floor_id: Optional[int] = Query(default=None), db: Session = Depends(get_db)
) -> list[models.Desk]:
    return crud.list_desks(db, floor_id)


@app.post(
    "/desks",
    response_model=schemas.Desk,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_admin)],
)
async def create_desk(
    payload: schemas.DeskCreate, db: Session = Depends(get_db)
) -> models.Desk:
    try:
        return crud.create_desk(db, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Floor not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


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
    db: Session = Depends(get_db),
) -> list[models.Reservation]:
    return crud.list_reservations(
        db, desk_id, reservation_date, user_id, date_from, date_to, office_id, status
    )


@app.post("/reservations", response_model=schemas.Reservation, status_code=status.HTTP_201_CREATED)
async def create_reservation(
    payload: schemas.ReservationCreate, db: Session = Depends(get_db)
) -> models.Reservation:
    if payload.start_time >= payload.end_time:
        raise HTTPException(status_code=400, detail="Start time must be before end time")
    try:
        return crud.create_reservation(db, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Desk not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/reservations/{reservation_id}/cancel", response_model=schemas.Reservation)
async def cancel_reservation(
    reservation_id: int, db: Session = Depends(get_db)
) -> models.Reservation:
    try:
        return crud.cancel_reservation(db, reservation_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Reservation not found")


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
