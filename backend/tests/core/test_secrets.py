import base64
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import SecretStr, ValidationError
from sqlalchemy import Table, delete, select
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, SQLModel
from sqlmodel import select as sm_select

import app.models  # noqa: F401
from app.core import reencrypt_secrets as reencrypt_mod
from app.core.config import Settings, settings
from app.core.db import engine
from app.core.reencrypt_secrets import (
    ENCRYPTED_TARGETS,
    ReencryptDatabaseError,
    main,
    reencrypt_secrets,
)
from app.core.secrets import (
    LEGACY_HKDF_INFO,
    SecretUnavailable,
    decrypt_secret,
    encrypt_secret,
    rotate_if_needed,
    rotate_secret,
)
from app.domains.access_token.models import OAuthClient
from app.domains.admin_assistant.models import (
    AdminAssistantAttachment,
    AdminAssistantMessage,
    AdminAssistantSession,
    AdminChangeSet,
)
from app.domains.bot.models import BotAttachment, BotMessage, BotSession
from app.domains.im.models import ImSetting
from app.domains.model.models import ModelSetting
from app.domains.org.models import OrgMembership
from app.domains.source.models import SourceConnection


def _fernet_key() -> str:
    return Fernet.generate_key().decode("ascii")


def _legacy_fernet_for(secret_key: str) -> Fernet:
    key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=b"employee-profile/stored-credentials/v1",
    ).derive(secret_key.encode())
    return Fernet(base64.urlsafe_b64encode(key))


@pytest.mark.unit
def test_legacy_hkdf_and_key_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "SECRET_KEY", "legacy-secret-key")
    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", None)
    assert LEGACY_HKDF_INFO == b"employee-profile/stored-credentials/v1"
    legacy_token = encrypt_secret("from-legacy")
    assert decrypt_secret(legacy_token) == "from-legacy"
    assert (
        _legacy_fernet_for("legacy-secret-key").decrypt(legacy_token.encode())
        == b"from-legacy"
    )

    k1, k2 = _fernet_key(), _fernet_key()
    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(k1))
    k1_token = encrypt_secret("from-k1")
    assert Fernet(k1.encode()).decrypt(k1_token.encode()) == b"from-k1"
    assert decrypt_secret(legacy_token) == "from-legacy"
    assert decrypt_secret(k1_token) == "from-k1"

    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(f"{k2},{k1}"))
    k2_token = encrypt_secret("from-k2")
    assert Fernet(k2.encode()).decrypt(k2_token.encode()) == b"from-k2"
    assert decrypt_secret(k2_token) == "from-k2"
    assert decrypt_secret(k1_token) == "from-k1"
    assert decrypt_secret(legacy_token) == "from-legacy"


@pytest.mark.unit
def test_rotate_secret_secondary_to_primary_and_retire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    k1, k2 = _fernet_key(), _fernet_key()
    monkeypatch.setattr(settings, "SECRET_KEY", "legacy-secret-key")
    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(k1))
    token_k1 = encrypt_secret("rotate-me")

    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(f"{k2}, {k1}"))
    assert rotate_if_needed(encrypt_secret("already-k2")) is None
    rotated = rotate_if_needed(token_k1)
    assert rotated is not None and rotated != token_k1
    assert rotate_secret(token_k1) != token_k1

    # Retiring K1 keeps rotated tokens readable while unrotated K1 tokens fail.
    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(k2))
    assert decrypt_secret(rotated) == "rotate-me"
    for bad in (token_k1, "not-a-valid-token"):
        with pytest.raises(SecretUnavailable):
            decrypt_secret(bad)
    with pytest.raises(SecretUnavailable):
        rotate_secret("not-a-valid-token")
    bad_utf8 = Fernet(k2.encode()).encrypt(b"\xff\xfe").decode()
    for fn in (rotate_secret, rotate_if_needed):
        with pytest.raises(SecretUnavailable):
            fn(bad_utf8)


_VALID_K1 = base64.urlsafe_b64encode(b"1" * 32).decode("ascii")
_VALID_K2 = base64.urlsafe_b64encode(b"2" * 32).decode("ascii")


@pytest.mark.unit
@pytest.mark.parametrize(
    "raw_keys",
    [
        "",
        "   ",
        ", ",
        f"{_VALID_K1},",
        f",{_VALID_K1}",
        f"{_VALID_K1}, ,{_VALID_K2}",
        "changethis",
        f"{_VALID_K1},changethis",
        "not-a-fernet-key",
        base64.b64encode(b"\xfb\xff" * 16).decode("ascii"),
        base64.urlsafe_b64encode(b"0" * 16).decode("ascii"),
    ],
)
def test_encryption_keys_rejects_invalid_values(
    monkeypatch: pytest.MonkeyPatch, raw_keys: str
) -> None:
    monkeypatch.delenv("FASTAPI_ENV", raising=False)
    monkeypatch.delenv("ENCRYPTION_KEYS", raising=False)
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            PROJECT_NAME="test",
            SECRET_KEY="random-test-secret",
            PI_SERVICE_TOKEN="synthetic-valid-token",
            DATABASE_URL="postgresql://postgres:test-password@localhost/app",
            ENCRYPTION_KEYS=raw_keys,  # type: ignore[arg-type]
        )
    for segment in raw_keys.split(","):
        candidate = segment.strip()
        if candidate and candidate != "changethis":
            assert candidate not in str(exc_info.value)


@pytest.mark.unit
def test_settings_repr_hides_encryption_keys_and_ignores_empty_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    k1 = _fernet_key()
    monkeypatch.delenv("FASTAPI_ENV", raising=False)
    base = {
        "PROJECT_NAME": "test",
        "SECRET_KEY": "random-test-secret",
        "PI_SERVICE_TOKEN": "synthetic-valid-token",
        "DATABASE_URL": "postgresql://postgres:test-password@localhost/app",
    }
    cfg = Settings(_env_file=None, **base, ENCRYPTION_KEYS=k1)  # type: ignore[call-arg, arg-type]
    assert k1 not in repr(cfg) and "ENCRYPTION_KEYS" not in repr(cfg)
    monkeypatch.setenv("ENCRYPTION_KEYS", "")
    assert Settings(_env_file=None, **base).ENCRYPTION_KEYS is None  # type: ignore[call-arg, arg-type]


@pytest.mark.unit
def test_reencrypt_targets_cover_all_metadata_secret_columns() -> None:
    discovered = {
        (t.name, c.name)
        for t in SQLModel.metadata.sorted_tables
        for c in t.columns
        if any(m in c.name for m in ("cipher", "secret", "encrypt", "credential"))
    }
    covered = {
        (str(target.model.__tablename__), col)
        for target in ENCRYPTED_TARGETS
        for col in target.secret_columns
    }
    assert len(ENCRYPTED_TARGETS) == 11 and len(covered) == 15 and covered == discovered
    with pytest.raises(ValueError, match="positive"):
        reencrypt_secrets(Session(), batch_size=0)


@contextmanager
def _oauth_cleanup(db: Session, client_ids: list[str]) -> Iterator[None]:
    try:
        yield
    finally:
        db.rollback()
        db.execute(delete(OAuthClient).where(OAuthClient.client_id.in_(client_ids)))  # type: ignore[attr-defined]
        db.commit()


def _seed_all_tables(
    db: Session, org_id: UUID, user_id: UUID, employee_id: UUID
) -> tuple[dict[tuple[str, str, str], str], list[str]]:
    plain: dict[tuple[str, str, str], str] = {}

    def enc(table: str, pk: str, col: str) -> str:
        value = f"sec-{table}-{col}-{pk[-4:]}"
        plain[(table, pk, col)] = value
        return encrypt_secret(value)

    oauth_ids = [f"test-oauth-{uuid4().hex}-{i}" for i in range(4)]
    bs_id, as_id, cs_id = uuid4(), uuid4(), uuid4()
    src_id, bm_id, bot_att_id, am_id, aa_id = (uuid4() for _ in range(5))
    att: dict[str, object] = {
        "kind": "file",
        "filename": "f.txt",
        "mime_type": "text/plain",
        "size": 5,
    }
    ms, oa = "model_setting", "oauth_client"
    db.add_all(
        [
            ModelSetting(
                org_id=org_id,
                updated_by_user_id=user_id,
                api_key_ciphertext=enc(ms, str(org_id), "api_key_ciphertext"),
                chatgpt_auth_ciphertext=enc(ms, str(org_id), "chatgpt_auth_ciphertext"),
                chatgpt_login_ciphertext=enc(
                    ms, str(org_id), "chatgpt_login_ciphertext"
                ),
            ),
            SourceConnection(
                id=src_id,
                org_id=org_id,
                kind="jira",
                updated_by_user_id=user_id,
                config={"deployment": "cloud"},
                secret_ciphertext=enc(
                    "source_connection", str(src_id), "secret_ciphertext"
                ),
            ),
            ImSetting(
                org_id=org_id,
                platform="feishu",
                updated_by_user_id=user_id,
                credentials=enc("im_setting", f"{org_id}:feishu", "credentials"),
            ),
            *[
                OAuthClient(
                    client_id=cid,
                    client_metadata={"n": str(i)},
                    client_secret_encrypted=(
                        ""
                        if i == 2
                        else None
                        if i == 3
                        else enc(oa, cid, "client_secret_encrypted")
                    ),
                    registered_ip="127.0.0.1",
                )
                for i, cid in enumerate(oauth_ids)
            ],
            BotSession(
                id=bs_id,
                org_id=org_id,
                employee_id=employee_id,
                state_ciphertext=enc("bot_session", str(bs_id), "state_ciphertext"),
            ),
            AdminAssistantSession(
                id=as_id,
                org_id=org_id,
                user_id=user_id,
                state_ciphertext=enc(
                    "admin_assistant_session", str(as_id), "state_ciphertext"
                ),
            ),
        ]
    )
    tbl_a_msg, tbl_a_att = "admin_assistant_message", "admin_assistant_attachment"
    db.flush()
    db.add_all(
        [
            AdminChangeSet(
                id=cs_id,
                org_id=org_id,
                session_id=as_id,
                created_by_user_id=user_id,
                items=[{"k": "v"}],
                secrets=enc("admin_change_set", str(cs_id), "secrets"),
            ),
            BotMessage(
                id=bm_id,
                org_id=org_id,
                session_id=bs_id,
                role="user",
                ciphertext=enc("bot_message", str(bm_id), "ciphertext"),
            ),
            BotAttachment(
                id=bot_att_id,
                org_id=org_id,
                session_id=bs_id,
                **att,
                ciphertext=enc("bot_attachment", str(bot_att_id), "ciphertext"),
                text_ciphertext=enc(
                    "bot_attachment", str(bot_att_id), "text_ciphertext"
                ),
            ),  # type: ignore[arg-type]
            AdminAssistantMessage(
                id=am_id,
                org_id=org_id,
                session_id=as_id,
                role="user",
                ciphertext=enc(tbl_a_msg, str(am_id), "ciphertext"),
            ),
            AdminAssistantAttachment(
                id=aa_id,
                org_id=org_id,
                session_id=as_id,
                **att,
                ciphertext=enc(tbl_a_att, str(aa_id), "ciphertext"),
                text_ciphertext=enc(tbl_a_att, str(aa_id), "text_ciphertext"),
            ),  # type: ignore[arg-type]
        ]
    )
    db.commit()
    return plain, oauth_ids


def _snapshot_all(db: Session) -> dict[tuple[str, str, str], str | None]:
    db.expire_all()
    snap: dict[tuple[str, str, str], str | None] = {}
    for target in ENCRYPTED_TARGETS:
        table = cast(Table, target.model.__table__)  # type: ignore[attr-defined]
        pk_cols = tuple(table.primary_key.columns)
        cols = tuple(table.c[c] for c in target.secret_columns)
        for row in db.execute(select(*pk_cols, *cols)).all():
            pk_key = ":".join(str(v) for v in row[: len(pk_cols)])
            for col, val in zip(cols, row[len(pk_cols) :], strict=True):
                snap[(table.name, pk_key, col.name)] = cast(str | None, val)
    return snap


def _decrypt_all_expected(
    snap: dict[tuple[str, str, str], str | None],
    plain: dict[tuple[str, str, str], str],
    before: dict[tuple[str, str, str], str | None] | None = None,
) -> None:
    for key, expected in plain.items():
        tok = snap[key]
        assert tok is not None and decrypt_secret(tok) == expected
        if before is not None:
            assert tok != before[key]


def test_reencrypt_cli_all_tables_roundtrip_and_dry_run(
    minimal_demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    employee = minimal_demo[1]["E01"]
    org_id = employee.org_id
    org_member = db.exec(
        sm_select(OrgMembership).where(OrgMembership.org_id == org_id)
    ).first()
    assert org_member is not None

    monkeypatch.setattr(settings, "SECRET_KEY", "old-jwt-secret")
    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", None)
    plain, oauth_ids = _seed_all_tables(db, org_id, org_member.user_id, employee.id)

    with _oauth_cleanup(db, oauth_ids):
        before = _snapshot_all(db)
        k1, k2 = _fernet_key(), _fernet_key()

        monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(k1))
        assert main(["--dry-run", "--batch-size", "1"]) == 0
        dry = capsys.readouterr()
        assert "pending_values=16" in dry.out and "failed=0" in dry.out
        assert _snapshot_all(db) == before

        assert main(["--batch-size", "1"]) == 0
        applied = capsys.readouterr()
        assert "rotated_values=16" in applied.out and "failed=0" in applied.out

        monkeypatch.setattr(settings, "SECRET_KEY", "new-jwt-secret-after-rotation")
        after_k1 = _snapshot_all(db)
        assert after_k1[("oauth_client", oauth_ids[2], "client_secret_encrypted")] == ""
        assert (
            after_k1[("oauth_client", oauth_ids[3], "client_secret_encrypted")] is None
        )
        _decrypt_all_expected(after_k1, plain, before)

        assert main(["--batch-size", "1"]) == 0
        assert "rotated_values=0" in capsys.readouterr().out

        monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(f"{k2},{k1}"))
        assert reencrypt_secrets(db, batch_size=1).rotated_values == 16
        monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(k2))
        _decrypt_all_expected(_snapshot_all(db), plain)


def test_reencrypt_cli_reports_corrupted_rows_without_secret_leak(
    minimal_demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    org_id = minimal_demo[1]["E01"].org_id
    org_member = db.exec(
        sm_select(OrgMembership).where(OrgMembership.org_id == org_id)
    ).first()
    assert org_member is not None

    canary, corrupted, old_secret = "CANARY-VAL", "bad-cipher", "old-sec-1"
    monkeypatch.setattr(settings, "SECRET_KEY", old_secret)
    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", None)
    oauth_id = f"corrupt-oauth-{uuid4().hex}"
    db.add_all(
        [
            ModelSetting(
                org_id=org_id,
                updated_by_user_id=org_member.user_id,
                api_key_ciphertext=encrypt_secret(canary),
                chatgpt_auth_ciphertext=corrupted,
            ),
            ImSetting(
                org_id=org_id,
                platform="telegram",
                updated_by_user_id=org_member.user_id,
                credentials=corrupted,
            ),
            OAuthClient(
                client_id=oauth_id,
                client_metadata={"n": "ok"},
                client_secret_encrypted=encrypt_secret(canary),
                registered_ip="127.0.0.1",
            ),
        ]
    )
    db.commit()

    with _oauth_cleanup(db, [oauth_id]):
        k1 = _fernet_key()
        monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(k1))
        assert main(["--batch-size", "1"]) == 1
        cap = capsys.readouterr()
        combined = cap.out + cap.err + caplog.text

        assert "failed=2" in cap.out
        assert (
            f"model_setting pk=org_id={org_id} column=chatgpt_auth_ciphertext"
            in cap.err
        )
        assert (
            f"im_setting pk=org_id={org_id},platform=telegram column=credentials"
            in cap.err
        )
        for sensitive in (canary, corrupted, old_secret, k1):
            assert sensitive not in combined

        monkeypatch.setattr(settings, "SECRET_KEY", "replaced-secret")
        db.expire_all()
        m_row, o_row = db.get(ModelSetting, org_id), db.get(OAuthClient, oauth_id)
        assert m_row and m_row.api_key_ciphertext
        assert o_row and o_row.client_secret_encrypted
        assert decrypt_secret(m_row.api_key_ciphertext) == canary
        assert decrypt_secret(o_row.client_secret_encrypted) == canary


@pytest.mark.unit
@pytest.mark.parametrize("fn", [rotate_secret, rotate_if_needed])
def test_rotate_normalizes_unicode_error(fn: Callable[[str], str | None]) -> None:
    with pytest.raises(SecretUnavailable):
        fn(chr(0xD800))


@pytest.mark.unit
def test_settings_validation_and_db_errors_redact_secrets(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.delenv("FASTAPI_ENV", raising=False)
    jwt_canary, db_canary, key_canary = (
        "jwt-canary-secret",
        "db-canary-pass",
        "bad-canary-key",
    )
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            PROJECT_NAME="test",
            SECRET_KEY=jwt_canary,
            PI_SERVICE_TOKEN="synthetic-valid-token",
            DATABASE_URL=f"postgresql://postgres:{db_canary}@localhost/app",  # type: ignore[arg-type]
            ENCRYPTION_KEYS=key_canary,  # type: ignore[arg-type]
        )
    err_text = str(exc_info.value)
    assert "input_value=" not in err_text
    for canary in (jwt_canary, db_canary, key_canary):
        assert canary not in err_text

    class _FailingSession:
        def execute(self, *_args: object, **_kwargs: object) -> object:
            raise OperationalError(
                "SELECT secret",
                {"secret": "CIPHER-CANARY", "plain": "PLAINTEXT-CANARY"},
                RuntimeError("KEY-CANARY"),
            )

        def rollback(self) -> None:
            return None

    with pytest.raises(ReencryptDatabaseError) as db_exc:
        reencrypt_secrets(cast(Session, _FailingSession()))
    assert "table=model_setting" in str(db_exc.value)
    for canary in ("CIPHER-CANARY", "PLAINTEXT-CANARY", "KEY-CANARY"):
        assert canary not in str(db_exc.value)

    class _Ctx:
        def __init__(self, *_args: object) -> None:
            pass

        def __enter__(self) -> object:
            return _FailingSession()

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(reencrypt_mod, "Session", _Ctx)
    assert main([]) == 1
    cap = capsys.readouterr()
    combined = cap.out + cap.err + caplog.text
    assert "table=model_setting error=OperationalError" in cap.err
    for canary in ("CIPHER-CANARY", "PLAINTEXT-CANARY", "KEY-CANARY"):
        assert canary not in combined


@pytest.mark.unit
def test_attachment_tables_cap_batch_size() -> None:
    limits: dict[str, int] = {}

    class _EmptyResult:
        def all(self) -> list[object]:
            return []

    class _RecordingSession:
        def execute(self, stmt: Any) -> _EmptyResult:
            table_name = stmt.get_final_froms()[0].name
            if stmt._limit_clause is not None:
                limits[table_name] = int(stmt._limit_clause.value)
            return _EmptyResult()

        def commit(self) -> None:
            return None

    reencrypt_secrets(cast(Session, _RecordingSession()), batch_size=500)
    assert limits["bot_attachment"] <= 10
    assert limits["admin_assistant_attachment"] <= 10
    assert limits["oauth_client"] == 500


@pytest.mark.unit
@pytest.mark.parametrize("reread_mode", ["unresolved", "already_current", "deleted"])
def test_reencrypt_cas_rowcount_zero_reread_and_exit_code(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    reread_mode: str,
) -> None:
    target = next(t for t in ENCRYPTED_TARGETS if t.model is OAuthClient)
    monkeypatch.setattr(reencrypt_mod, "ENCRYPTED_TARGETS", (target,))
    monkeypatch.setattr(
        reencrypt_mod,
        "rotate_if_needed",
        lambda tok: "new-synthetic-value" if tok == "old-synthetic-value" else None,
    )

    class _Result:
        def __init__(self, rows: list[tuple[Any, ...]] = (), rowcount: int = 0) -> None:  # type: ignore[assignment]
            self._rows = rows
            self.rowcount = rowcount

        def all(self) -> list[tuple[Any, ...]]:
            return self._rows

        def one_or_none(self) -> tuple[Any, ...] | None:
            return self._rows[0] if self._rows else None

    class _StubSession:
        def __init__(self) -> None:
            self.batches = 0

        def execute(self, stmt: Any) -> _Result:
            if stmt.is_update:
                return _Result(rowcount=0)
            if len(stmt.selected_columns) == 2:
                self.batches += 1
                return _Result(
                    rows=[(1, "old-synthetic-value")] if self.batches == 1 else []
                )
            if reread_mode == "unresolved":
                return _Result(rows=[("old-synthetic-value",)])
            if reread_mode == "already_current":
                return _Result(rows=[("new-synthetic-value",)])
            return _Result(rows=[])

        def commit(self) -> None:
            return None

        def rollback(self) -> None:
            return None

    class _Ctx:
        def __init__(self, *_args: object) -> None:
            pass

        def __enter__(self) -> _StubSession:
            return _StubSession()

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(reencrypt_mod, "Session", _Ctx)
    code = main(["--batch-size", "1"])
    cap = capsys.readouterr()
    assert "rotated_values=0" in cap.out
    if reread_mode == "unresolved":
        assert code == 1 and "unresolved=1" in cap.out and "oauth_client" in cap.err
    elif reread_mode == "already_current":
        assert (
            code == 0 and "already_current=1" in cap.out and "unresolved=0" in cap.out
        )
    else:
        assert code == 0 and "skipped_concurrent=1" in cap.out


def test_reencrypt_cas_does_not_overwrite_concurrent_db_write(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    oauth_id = f"cas-oauth-{uuid4().hex}"
    monkeypatch.setattr(settings, "SECRET_KEY", "old-cas-secret")
    monkeypatch.setattr(settings, "ENCRYPTION_KEYS", None)
    db.add(
        OAuthClient(
            client_id=oauth_id,
            client_metadata={"n": "cas"},
            client_secret_encrypted=encrypt_secret("old-value"),
            registered_ip="127.0.0.1",
        )
    )
    db.commit()

    with _oauth_cleanup(db, [oauth_id]):
        k1 = _fernet_key()
        monkeypatch.setattr(settings, "ENCRYPTION_KEYS", SecretStr(k1))
        target = next(t for t in ENCRYPTED_TARGETS if t.model is OAuthClient)
        monkeypatch.setattr(reencrypt_mod, "ENCRYPTED_TARGETS", (target,))

        orig_execute = db.execute
        raced = False

        def racing_execute(stmt: Any, *args: Any, **kwargs: Any) -> Any:
            nonlocal raced
            if not raced and getattr(stmt, "is_update", False):
                raced = True
                with Session(engine) as concurrent_db:
                    row = concurrent_db.get(OAuthClient, oauth_id)
                    assert row is not None
                    row.client_secret_encrypted = encrypt_secret("fresh-concurrent-val")
                    concurrent_db.commit()
            return orig_execute(stmt, *args, **kwargs)

        monkeypatch.setattr(db, "execute", racing_execute)
        summary = reencrypt_secrets(db, batch_size=1)
        assert raced
        assert summary.rotated_values == 0
        assert summary.already_current_values == 1
        assert summary.unresolved_values == 0
        assert summary.failed_values == 0

        db.expire_all()
        final_row = db.get(OAuthClient, oauth_id)
        assert final_row and final_row.client_secret_encrypted
        assert (
            decrypt_secret(final_row.client_secret_encrypted) == "fresh-concurrent-val"
        )
