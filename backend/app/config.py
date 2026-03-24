from __future__ import annotations

from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/deskbooking"
    SECRET_KEY: str = "change-me-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480
    FRONTEND_URL: str = "http://localhost:3000"
    ADMIN_REGISTER_SECRET: Optional[str] = None
    # Comma-separated allowed CORS origins; "*" = allow all (dev only)
    ALLOWED_ORIGINS: str = "*"
    # IANA timezone name for "today" comparisons (e.g. "Europe/Almaty")
    APP_TIMEZONE: str = "UTC"

    # Telegram bot for lead notifications
    TELEGRAM_BOT_TOKEN: str = ""
    TELEGRAM_CHAT_ID: str = ""

    class Config:
        env_file = ".env"


settings = Settings()
