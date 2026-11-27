from pathlib import Path

import sentry_sdk
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from fastapi.utils import is_body_allowed_for_status_code
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from app.api.main import api_router
from app.core.config import settings
from app.i18n import current_locale, parse_accept_language, tr
from app.mcp.oauth import oauth_routes
from app.mcp.server import endpoint, lifespan

FRONTEND_DIR = Path(__file__).parent / "frontend"


def custom_generate_unique_id(route: APIRoute) -> str:
    return f"{route.tags[0]}-{route.name}"


if settings.SENTRY_DSN and settings.FASTAPI_ENV != "development":
    sentry_sdk.init(dsn=str(settings.SENTRY_DSN), enable_tracing=True)

app = FastAPI(
    lifespan=lifespan,
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    generate_unique_id_function=custom_generate_unique_id,
)


class ApplicationCors(CORSMiddleware):
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] == "http" and (
            path in {"/oauth/register", "/oauth/token", "/oauth/revoke"}
            or path.startswith("/.well-known/oauth-")
        ):
            # Public OAuth endpoints already carry the SDK's client-facing CORS policy.
            await self.app(scope, receive, send)
        else:
            await super().__call__(scope, receive, send)


class LocaleMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        header_value: str | None = None
        for name, value in scope.get("headers", []):
            if name == b"accept-language":
                header_value = value.decode("latin-1")
                break
        token = current_locale.set(parse_accept_language(header_value))
        try:
            await self.app(scope, receive, send)
        finally:
            current_locale.reset(token)


app.add_middleware(LocaleMiddleware)
app.add_middleware(
    ApplicationCors,
    allow_origins=[settings.FRONTEND_HOST],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-Issued-Count"],
)


@app.exception_handler(StarletteHTTPException)
async def localized_http_exception_handler(
    _request: Request, exc: StarletteHTTPException
) -> Response:
    headers = getattr(exc, "headers", None)
    if not is_body_allowed_for_status_code(exc.status_code):
        return Response(status_code=exc.status_code, headers=headers)
    detail: object = exc.detail
    if isinstance(detail, str):
        detail = tr(detail)
    elif isinstance(detail, dict) and isinstance(detail.get("message"), str):
        detail = {**detail, "message": tr(detail["message"])}
    return JSONResponse(
        {"detail": detail}, status_code=exc.status_code, headers=headers
    )


app.include_router(api_router, prefix=settings.API_V1_STR)
app.router.routes.append(
    Route("/mcp", endpoint=endpoint, methods=["POST", "GET", "DELETE"])
)
app.router.routes.extend(oauth_routes())
if FRONTEND_DIR.is_dir():
    app.frontend("/", directory=FRONTEND_DIR)
