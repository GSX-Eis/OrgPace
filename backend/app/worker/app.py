from procrastinate import App, PsycopgConnector

from app.core.config import settings
from app.core.observability import init_observability

init_observability()

app = App(
    connector=PsycopgConnector(
        conninfo=str(settings.DATABASE_URL).replace(
            "postgresql+psycopg://", "postgresql://", 1
        ),
    ),
    import_paths=["app.worker.tasks"],
)
