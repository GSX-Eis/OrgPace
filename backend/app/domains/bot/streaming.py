from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager

from fastapi import Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import Engine
from sqlmodel import Session

from app.core.db import engine
from app.domains.bot import delivery
from app.domains.bot.schemas import TurnResponse
from app.domains.chat_runtime import streaming as _streaming
from app.domains.chat_runtime.streaming import (
    ErrorEvent as ErrorEvent,
)
from app.domains.chat_runtime.streaming import (
    FinalEvent as FinalEvent,
)
from app.domains.chat_runtime.streaming import (
    TextEvent as TextEvent,
)
from app.domains.chat_runtime.streaming import (
    ToolEvent as ToolEvent,
)
from app.domains.chat_runtime.streaming import (
    TurnStreamingResponse as TurnStreamingResponse,
)
from app.domains.chat_runtime.streaming import (
    _error_message as _error_message,
)
from app.domains.model.pi_client import TurnStream, cancel_run


@asynccontextmanager
async def _deliver_turn_response(
    db_engine: Engine, event: BaseModel
) -> AsyncGenerator[BaseModel]:
    if isinstance(event, TurnResponse):
        # Hold the scope lock until StreamingResponse has awaited send.
        with Session(db_engine) as db:
            async with delivery.in_thread(delivery.guard(db, event)) as result:
                yield result
    else:
        yield event


def response(
    run: Callable[[Session, TurnStream], BaseModel], request: Request
) -> StreamingResponse:
    return _streaming.response(
        run,
        request,
        deliver_final=_deliver_turn_response,
        db_engine=engine,
        cancel_fn=cancel_run,
    )
