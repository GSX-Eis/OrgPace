import asyncio

from app.core.db import engine
from app.core.observability import init_observability
from app.domains.im.gateway import Gateway

if __name__ == "__main__":
    init_observability()
    asyncio.run(Gateway(engine).run())
