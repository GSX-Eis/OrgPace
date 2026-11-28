import base64
import binascii
import re
import warnings
from pathlib import Path
from typing import Literal, Self

from cryptography.fernet import Fernet
from pydantic import (
    EmailStr,
    Field,
    HttpUrl,
    PostgresDsn,
    SecretStr,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Use top level .env file (one level above ./backend/)
        env_file="../.env",
        env_ignore_empty=True,
        extra="ignore",
        hide_input_in_errors=True,
    )
    API_V1_STR: str = "/api/v1"
    SECRET_KEY: str
    ENCRYPTION_KEYS: SecretStr | None = Field(default=None, repr=False)
    # 60 minutes * 24 hours * 8 days = 8 days
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 8
    LOGIN_MAX_FAILURES: int = Field(default=5, gt=0)
    LOGIN_MAX_FAILURES_PER_IP: int = Field(default=300, gt=0)
    LOGIN_LOCK_MINUTES: int = Field(default=15, gt=0, le=1440)
    OAUTH_REGISTER_MAX_PER_IP_HOUR: int = Field(default=10, gt=0)
    EXTERNAL_MCP_ENABLED: bool = False
    PLAYWRIGHT_FIXTURES_ENABLED: bool = False
    FRONTEND_HOST: str = "http://localhost:5173"
    FASTAPI_ENV: Literal["development"] | None = None
    CHATGPT_LOCAL_AUTH: bool = False
    PI_URL: str = "http://pi:8081"
    PI_SERVICE_TOKEN: SecretStr = Field(default=SecretStr("changethis"), repr=False)
    SEED_DEMO_DATA: bool = False
    DEMO_USER_PASSWORD: str | None = Field(default=None, min_length=8, max_length=128)
    DEMO_DATA_DIR: Path = Path(__file__).resolve().parents[3] / "examples/demo-org"
    CAPABILITY_TEMPLATES_DIR: Path = (
        Path(__file__).resolve().parents[3] / "templates/capabilities"
    )

    PROJECT_NAME: str
    SENTRY_DSN: HttpUrl | None = None
    SENTRY_TRACES_SAMPLE_RATE: float = Field(default=0.1, ge=0.0, le=1.0)
    DATABASE_URL: PostgresDsn

    @field_validator("DATABASE_URL", mode="before")
    @classmethod
    def _use_psycopg_driver(cls, value: str | PostgresDsn) -> str:
        database_url = str(value)
        for scheme in ("postgres://", "postgresql://"):
            if database_url.startswith(scheme):
                return database_url.replace(scheme, "postgresql+psycopg://", 1)
        return database_url

    FIRST_SUPERUSER: EmailStr | None = None
    FIRST_SUPERUSER_PASSWORD: str | None = None

    def _check_default_secret(self, var_name: str, value: str | None) -> None:
        if value == "changethis":
            message = (
                f'The value of {var_name} is "changethis", '
                "for security, please change it, at least for deployments."
            )
            if self.FASTAPI_ENV == "development":
                warnings.warn(message, stacklevel=1)
            else:
                raise ValueError(message)

    @model_validator(mode="after")
    def _enforce_non_default_secrets(self) -> Self:
        if bool(self.FIRST_SUPERUSER) != bool(self.FIRST_SUPERUSER_PASSWORD):
            raise ValueError(
                "Configure both FIRST_SUPERUSER and FIRST_SUPERUSER_PASSWORD, or neither"
            )
        self._check_default_secret("SECRET_KEY", self.SECRET_KEY)
        if self.ENCRYPTION_KEYS is not None:
            raw_keys = self.ENCRYPTION_KEYS.get_secret_value()
            for segment in raw_keys.split(","):
                self._check_default_secret("ENCRYPTION_KEYS", segment.strip())
            parse_encryption_keys(raw_keys)
        self._check_default_secret(
            "PI_SERVICE_TOKEN", self.PI_SERVICE_TOKEN.get_secret_value()
        )
        for host in self.DATABASE_URL.hosts():
            self._check_default_secret("DATABASE_URL password", host["password"])
        self._check_default_secret(
            "FIRST_SUPERUSER_PASSWORD", self.FIRST_SUPERUSER_PASSWORD
        )

        if (
            self.SEED_DEMO_DATA
            and self.FASTAPI_ENV != "development"
            and self.DEMO_USER_PASSWORD in {"changethis", "demo-password-2026"}
        ):
            raise ValueError("DEMO_USER_PASSWORD must not use an example password")

        if self.CHATGPT_LOCAL_AUTH and self.FASTAPI_ENV != "development":
            raise ValueError("CHATGPT_LOCAL_AUTH 只允许在开发模式使用")
        return self


_FERNET_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{43}=$")


def parse_encryption_keys(raw: str) -> tuple[bytes, ...]:
    """Parse comma-separated 32-byte urlsafe base64 Fernet keys without echoing secrets."""
    keys: list[bytes] = []
    for segment in raw.split(","):
        candidate = segment.strip()
        if not candidate:
            raise ValueError("ENCRYPTION_KEYS must not contain empty entries")
        if not _FERNET_KEY_RE.fullmatch(candidate):
            raise ValueError(
                "ENCRYPTION_KEYS entries must be valid 32-byte urlsafe base64 Fernet keys"
            )
        try:
            key_bytes = candidate.encode("ascii")
            decoded = base64.urlsafe_b64decode(key_bytes)
        except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
            raise ValueError(
                "ENCRYPTION_KEYS entries must be valid 32-byte urlsafe base64 Fernet keys"
            ) from exc
        if len(decoded) != 32:
            raise ValueError("ENCRYPTION_KEYS entries must decode to 32 bytes")
        Fernet(key_bytes)
        keys.append(key_bytes)
    return tuple(keys)


settings = Settings()  # type: ignore
