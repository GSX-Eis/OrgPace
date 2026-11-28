import asyncio
import base64
import json
import threading
import time
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import SecretStr, ValidationError
from sqlalchemy import Table, delete, select, text
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
    secret_fingerprint,
)
from app.domains.access_token.models import OAuthClient as OC
from app.domains.admin_assistant.models import AdminAssistantAttachment as AA
from app.domains.admin_assistant.models import AdminAssistantMessage as AM
from app.domains.admin_assistant.models import AdminAssistantSession as AS
from app.domains.admin_assistant.models import AdminChangeSet as AC
from app.domains.base import utc_now
from app.domains.bot.models import BotAttachment as BAtt
from app.domains.bot.models import BotMessage as BM
from app.domains.bot.models import BotSession as BS
from app.domains.im import binding, gateway, notifications
from app.domains.im.adapters.base import Event
from app.domains.im.models import ImNotification
from app.domains.im.models import ImSetting as IS
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.domains.model import chatgpt
from app.domains.model.models import ModelSetting as MS
from app.domains.org.models import OrgMembership
from app.domains.source.models import SourceConnection as SC

_K1 = base64.urlsafe_b64encode(b"1" * 32).decode("ascii")
_K2 = base64.urlsafe_b64encode(b"2" * 32).decode("ascii")


def _fk() -> str:
    return Fernet.generate_key().decode("ascii")


def _set_keys(mp: pytest.MonkeyPatch, sk: str, ek: str | None = None) -> None:
    mp.setattr(settings, "SECRET_KEY", sk)
    mp.setattr(settings, "ENCRYPTION_KEYS", SecretStr(ek) if ek is not None else None)


def _org_ctx(db: Session, demo_data: tuple) -> tuple[Any, UUID, UUID]:
    emp = demo_data[1]["E01"]
    q = sm_select(OrgMembership).where(OrgMembership.org_id == emp.org_id)
    return emp, emp.org_id, db.exec(q).first().user_id  # type: ignore[union-attr]


def _ctx(session: object) -> Callable[..., Any]:
    @contextmanager
    def _cm(*_a: object) -> Iterator[object]:
        yield session

    return _cm


class _FakeIm:
    def __init__(self, out: list[Any], *_a: object) -> None:
        self.sent, self.closed = [], False
        out.append(self)

    async def test_connection(self) -> str:
        return "b1"

    async def poll(self) -> AsyncIterator[Event]:
        await asyncio.Event().wait()
        yield  # type: ignore[misc]

    async def send_text(self, cid: str, text: str) -> None:
        self.sent.append((cid, text))

    async def close(self) -> None:
        self.closed = True


def _tok(a: str, r: str, dt: int) -> dict[str, Any]:
    exp = (time.time() + dt) * 1000
    return {"access": a, "refresh": r, "expires": exp, "accountId": "a1"}


def _cfg(**kw: Any) -> Settings:
    url = "postgresql://postgres:p@localhost/app"
    base: dict[str, Any] = {
        "PROJECT_NAME": "t",
        "SECRET_KEY": "s",
        "PI_SERVICE_TOKEN": "t",
        "DATABASE_URL": url,
        "FASTAPI_ENV": None,
        "FIRST_SUPERUSER": None,
        "FIRST_SUPERUSER_PASSWORD": None,
        "SEED_DEMO_DATA": False,
        "DEMO_USER_PASSWORD": None,
        "CHATGPT_LOCAL_AUTH": False,
    }
    return Settings(_env_file=None, **{**base, **kw})  # type: ignore[call-arg, arg-type]


@pytest.mark.unit
def test_legacy_hkdf_and_key_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_keys(monkeypatch, "legacy-sec")
    assert LEGACY_HKDF_INFO == b"employee-profile/stored-credentials/v1"
    leg = encrypt_secret("from-legacy")
    drv = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=LEGACY_HKDF_INFO)
    lk = base64.urlsafe_b64encode(drv.derive(b"legacy-sec"))
    assert Fernet(lk).decrypt(leg.encode()) == b"from-legacy"

    k1, k2 = _fk(), _fk()
    _set_keys(monkeypatch, "legacy-sec", k1)
    t1 = encrypt_secret("from-k1")
    assert Fernet(k1.encode()).decrypt(t1.encode()) == b"from-k1"
    assert decrypt_secret(leg) == "from-legacy" and decrypt_secret(t1) == "from-k1"

    _set_keys(monkeypatch, "legacy-sec", f"{k2},{k1}")
    t2 = encrypt_secret("from-k2")
    assert Fernet(k2.encode()).decrypt(t2.encode()) == b"from-k2"
    assert decrypt_secret(t2) == "from-k2" and decrypt_secret(t1) == "from-k1"
    assert decrypt_secret(leg) == "from-legacy"


@pytest.mark.unit
def test_rotate_secret_secondary_to_primary_and_retire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    k1, k2 = _fk(), _fk()
    _set_keys(monkeypatch, "legacy-sec", k1)
    tok1 = encrypt_secret("rotate-me")
    _set_keys(monkeypatch, "legacy-sec", f"{k2}, {k1}")
    assert rotate_if_needed(encrypt_secret("ok")) is None
    rot = rotate_if_needed(tok1)
    assert rot is not None and rot != tok1 and rotate_secret(tok1) != tok1

    _set_keys(monkeypatch, "legacy-sec", k2)
    assert decrypt_secret(rot) == "rotate-me"
    for bad in (tok1, "not-a-valid-token"):
        with pytest.raises(SecretUnavailable):
            decrypt_secret(bad)
    for fn in (rotate_secret, rotate_if_needed):
        with pytest.raises(SecretUnavailable):
            fn("not-a-valid-token")
        with pytest.raises(SecretUnavailable):
            fn(Fernet(k2.encode()).encrypt(b"\xff\xfe").decode())


_BAD_KEYS = (
    *("", "   ", ", ", f"{_K1},", f",{_K1}", f"{_K1}, ,{_K2}"),
    *("changethis", f"{_K1},changethis", "bad"),
    base64.b64encode(b"\xfb\xff" * 16).decode(),
    base64.urlsafe_b64encode(b"0" * 16).decode(),
)


@pytest.mark.unit
@pytest.mark.parametrize("raw", _BAD_KEYS)
def test_encryption_keys_rejects_invalid_values(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    monkeypatch.delenv("FASTAPI_ENV", raising=False)
    monkeypatch.delenv("ENCRYPTION_KEYS", raising=False)
    with pytest.raises(ValidationError) as exc:
        _cfg(ENCRYPTION_KEYS=raw)
    for seg in raw.split(","):
        if (cand := seg.strip()) and cand != "changethis":
            assert cand not in str(exc.value)


@pytest.mark.unit
def test_settings_repr_hides_encryption_keys_and_ignores_empty_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    k1 = _fk()
    monkeypatch.delenv("FASTAPI_ENV", raising=False)
    cfg = _cfg(ENCRYPTION_KEYS=k1)
    assert k1 not in repr(cfg) and "ENCRYPTION_KEYS" not in repr(cfg)
    monkeypatch.setenv("ENCRYPTION_KEYS", "")
    assert _cfg().ENCRYPTION_KEYS is None


@pytest.mark.unit
def test_reencrypt_targets_cover_all_metadata_secret_columns() -> None:
    disc = {
        (t.name, c.name)
        for t in SQLModel.metadata.sorted_tables
        for c in t.columns
        if any(m in c.name for m in ("cipher", "secret", "encrypt", "credential"))
    }
    cov = {
        (str(t.model.__tablename__), c)
        for t in ENCRYPTED_TARGETS
        for c in t.secret_columns
    }
    assert len(ENCRYPTED_TARGETS) == 11 and len(cov) == 15 and cov == disc
    with pytest.raises(ValueError, match="positive"):
        reencrypt_secrets(Session(), batch_size=0)


@pytest.mark.unit
@pytest.mark.parametrize("fn", [rotate_secret, rotate_if_needed])
def test_rotate_normalizes_unicode_error(fn: Callable[[str], str | None]) -> None:
    with pytest.raises(SecretUnavailable):
        fn(chr(0xD800))


@pytest.mark.unit
def test_secret_fingerprint_behavior(monkeypatch: pytest.MonkeyPatch) -> None:
    k1, k2 = _fk(), _fk()
    assert secret_fingerprint(None) is None and secret_fingerprint("") is None
    _set_keys(monkeypatch, "fp-sec", k1)
    t1, tb, tr = encrypt_secret("a"), encrypt_secret("b"), encrypt_secret("raw:x")
    _set_keys(monkeypatch, "fp-sec", f"{k2},{k1}")
    t2 = rotate_secret(t1)
    assert secret_fingerprint(t1) == secret_fingerprint(t2) != secret_fingerprint(tb)
    assert str(secret_fingerprint(tr)).startswith("v1:")
    _set_keys(monkeypatch, "fp-sec", k2)
    assert str(secret_fingerprint(t1)).startswith("raw:")
    assert secret_fingerprint(t1) != secret_fingerprint(t2)
    assert str(secret_fingerprint(chr(0xD800))).startswith("raw:")


@pytest.mark.unit
def test_settings_validation_and_db_errors_redact_secrets(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.delenv("FASTAPI_ENV", raising=False)
    canaries = ("jwt-canary-secret", "db-canary-pass", "bad-canary-key")
    db_url = f"postgresql://postgres:{canaries[1]}@localhost/app"
    with pytest.raises(ValidationError) as exc:
        _cfg(SECRET_KEY=canaries[0], DATABASE_URL=db_url, ENCRYPTION_KEYS=canaries[2])
    msg = str(exc.value)
    assert "input_value=" not in msg and all(c not in msg for c in canaries)

    class _Fail:
        rollback = lambda _s: None  # noqa: E731

        def execute(self, *_a: object, **_k: object) -> object:
            op = OperationalError(
                "SELECT", {"s": "CIPHER-C", "p": "PLAIN-C"}, RuntimeError("KEY-C")
            )
            raise op

    with pytest.raises(ReencryptDatabaseError) as db_exc:
        reencrypt_secrets(cast(Session, _Fail()))
    s_exc = str(db_exc.value)
    assert "table=model_setting" in s_exc
    assert all(c not in s_exc for c in ("CIPHER-C", "PLAIN-C", "KEY-C"))
    monkeypatch.setattr(reencrypt_mod, "Session", _ctx(_Fail()))
    assert main([]) == 1
    cap = capsys.readouterr()
    assert "table=model_setting error=OperationalError" in cap.err
    leaked = cap.out + cap.err + caplog.text
    assert all(c not in leaked for c in ("CIPHER-C", "PLAIN-C", "KEY-C"))


@pytest.mark.unit
def test_attachment_tables_cap_batch_size() -> None:
    limits: dict[str, int] = {}

    class _Rec:
        commit = lambda _s: None  # noqa: E731

        def execute(self, stmt: Any) -> Any:
            if (cl := stmt._limit_clause) is not None:
                limits[stmt.selected_columns[0].table.name] = int(cl.value)
            return type("_E", (), {"all": staticmethod(list)})()

    reencrypt_secrets(cast(Session, _Rec()), batch_size=500)
    assert limits["bot_attachment"] <= 10 and limits["admin_assistant_attachment"] <= 10
    assert limits["oauth_client"] == 500


@pytest.mark.unit
@pytest.mark.parametrize(
    ("rr", "exp_code", "exp_out"),
    [
        ([("old-s",)], 1, "unresolved=1"),
        ([("new-s",)], 0, "already_current=1"),
        ([], 0, "skipped_concurrent=1"),
    ],
)
def test_reencrypt_cas_rowcount_zero_reread_and_exit_code(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    rr: list[tuple[str]],
    exp_code: int,
    exp_out: str,
) -> None:
    _set_target(monkeypatch, OC)
    fn = lambda t: "new-s" if t == "old-s" else None  # noqa: E731
    monkeypatch.setattr(reencrypt_mod, "rotate_if_needed", fn)

    class _Stub:
        batches = 0
        commit = rollback = lambda _s: None  # noqa: E731

        def execute(self, stmt: Any) -> Any:
            if stmt.is_update:
                return type("_R", (), {"rowcount": 0})()
            if len(stmt.selected_columns) == 2:
                self.batches += 1
                rows: list[Any] = [(1, "old-s")] if self.batches == 1 else []
            else:
                rows = list(rr)
            one = rows[0] if rows else None
            return type(
                "_R", (), {"all": lambda _s: rows, "one_or_none": lambda _s: one}
            )()

    monkeypatch.setattr(reencrypt_mod, "Session", _ctx(_Stub()))
    code, cap = main(["--batch-size", "1"]), capsys.readouterr()
    assert code == exp_code and "rotated_values=0" in cap.out and exp_out in cap.out
    assert ("oauth_client" in cap.err) == (exp_code == 1)


def _set_target(mp: pytest.MonkeyPatch, model: type[SQLModel]) -> None:
    t = next(x for x in ENCRYPTED_TARGETS if x.model is model)
    mp.setattr(reencrypt_mod, "ENCRYPTED_TARGETS", (t,))


@contextmanager
def _oauth_cleanup(db: Session, client_ids: list[str]) -> Iterator[None]:
    try:
        yield
    finally:
        db.rollback()
        db.execute(delete(OC).where(OC.client_id.in_(client_ids)))  # type: ignore[attr-defined]
        db.commit()


def _mk_oc(cid: str, **kw: Any) -> OC:
    return OC(
        client_id=cid, client_metadata={"n": "0"}, registered_ip="127.0.0.1", **kw
    )


def _seed_all_tables(
    db: Session, oid: UUID, uid: UUID, eid: UUID
) -> tuple[dict[tuple[str, str, str], str], list[str]]:
    plain: dict[tuple[str, str, str], str] = {}
    cols_of = {t.model: t.secret_columns for t in ENCRYPTED_TARGETS}

    def e(m: type[SQLModel], pk: Any) -> dict[str, str]:
        t, out = str(m.__tablename__), {}
        for c in cols_of[m]:
            plain[(t, str(pk), c)] = val = f"s-{t}-{c}-{str(pk)[-4:]}"
            out[c] = encrypt_secret(val)
        return out

    oa = [f"test-oauth-{uuid4().hex}-{i}" for i in range(4)]
    bs, as_, cs, src, bm, b_att, am, aa = (uuid4() for _ in range(8))
    att: dict[str, Any] = {"kind": "file", "filename": "f", "mime_type": "t", "size": 5}
    ov = [e(OC, c) for c in oa[:2]] + [
        {"client_secret_encrypted": v} for v in ("", None)
    ]
    kw: dict[str, Any] = {"org_id": oid, "updated_by_user_id": uid}
    sc_kw: dict[str, Any] = {**kw, "kind": "jira", "config": {"deployment": "cloud"}}
    ocs = [_mk_oc(c, **v) for c, v in zip(oa, ov, strict=True)]
    r1 = [
        MS(**kw, **e(MS, oid)),
        SC(id=src, **sc_kw, **e(SC, src)),
        IS(**kw, platform="feishu", **e(IS, f"{oid}:feishu")),
        BS(id=bs, org_id=oid, employee_id=eid, **e(BS, bs)),
        AS(id=as_, org_id=oid, user_id=uid, **e(AS, as_)),
        *ocs,
    ]
    db.add_all(r1)
    db.flush()
    b_kw: dict[str, Any] = {"org_id": oid, "session_id": bs}
    a_kw: dict[str, Any] = {"org_id": oid, "session_id": as_}
    ac_kw: dict[str, Any] = {**a_kw, "created_by_user_id": uid, "items": [{"k": "v"}]}
    r2 = [
        AC(id=cs, **ac_kw, **e(AC, cs)),
        BM(id=bm, **b_kw, role="user", **e(BM, bm)),
        BAtt(id=b_att, **b_kw, **att, **e(BAtt, b_att)),
        AM(id=am, **a_kw, role="user", **e(AM, am)),
        AA(id=aa, **a_kw, **att, **e(AA, aa)),
    ]
    db.add_all(r2)
    db.commit()
    return plain, oa


def _snapshot_all(db: Session) -> dict[tuple[str, str, str], str | None]:
    db.expire_all()
    snap: dict[tuple[str, str, str], str | None] = {}
    for target in ENCRYPTED_TARGETS:
        tbl = cast(Table, target.model.__table__)  # type: ignore[attr-defined]
        pks = tuple(tbl.primary_key.columns)
        cols = tuple(tbl.c[c] for c in target.secret_columns)
        for row in db.execute(select(*pks, *cols)).all():
            pk_key = ":".join(str(v) for v in row[: len(pks)])
            for col, val in zip(cols, row[len(pks) :], strict=True):
                snap[(tbl.name, pk_key, col.name)] = cast(str | None, val)
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
    emp, oid, uid = _org_ctx(db, minimal_demo)
    _set_keys(monkeypatch, "old-jwt-secret")
    plain, oa = _seed_all_tables(db, oid, uid, emp.id)

    with _oauth_cleanup(db, oa):
        before, k1, k2 = _snapshot_all(db), _fk(), _fk()
        _set_keys(monkeypatch, "old-jwt-secret", k1)
        assert main(["--dry-run", "--batch-size", "1"]) == 0
        dry = capsys.readouterr().out
        assert "pending_values=16" in dry and "failed=0" in dry
        assert _snapshot_all(db) == before

        assert main(["--batch-size", "1"]) == 0
        assert "rotated_values=16" in capsys.readouterr().out
        _set_keys(monkeypatch, "new-jwt-secret", k1)
        after_k1 = _snapshot_all(db)
        assert after_k1[("oauth_client", oa[2], "client_secret_encrypted")] == ""
        assert after_k1[("oauth_client", oa[3], "client_secret_encrypted")] is None
        _decrypt_all_expected(after_k1, plain, before)

        assert main(["--batch-size", "1"]) == 0
        assert "rotated_values=0" in capsys.readouterr().out
        _set_keys(monkeypatch, "new-jwt-secret", f"{k2},{k1}")
        assert reencrypt_secrets(db, batch_size=1).rotated_values == 16
        _set_keys(monkeypatch, "new-jwt-secret", k2)
        _decrypt_all_expected(_snapshot_all(db), plain)


def test_reencrypt_cli_reports_corrupted_rows_without_secret_leak(
    minimal_demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    _, oid, uid = _org_ctx(db, minimal_demo)
    canary, bad, old_s, oid_c = "CANARY-VAL", "bad-cipher", "old-s", f"c-{uuid4().hex}"
    _set_keys(monkeypatch, old_s)
    kw: dict[str, Any] = {"org_id": oid, "updated_by_user_id": uid}
    enc_c = encrypt_secret(canary)
    ms = MS(**kw, api_key_ciphertext=enc_c, chatgpt_auth_ciphertext=bad)
    oc = _mk_oc(oid_c, client_secret_encrypted=enc_c)
    db.add_all([ms, IS(**kw, platform="telegram", credentials=bad), oc])
    db.commit()

    with _oauth_cleanup(db, [oid_c]):
        k1 = _fk()
        _set_keys(monkeypatch, old_s, k1)
        assert main(["--batch-size", "1"]) == 1
        cap = capsys.readouterr()
        assert "failed=2" in cap.out
        p1 = f"model_setting pk=org_id={oid} column=chatgpt_auth_ciphertext"
        p2 = f"im_setting pk=org_id={oid},platform=telegram column=credentials"
        assert p1 in cap.err and p2 in cap.err
        leaked = cap.out + cap.err + caplog.text
        assert all(s not in leaked for s in (canary, bad, old_s, k1))

        _set_keys(monkeypatch, "replaced-secret", k1)
        db.expire_all()
        m_row, o_row = db.get(MS, oid), db.get(OC, oid_c)
        assert m_row and m_row.api_key_ciphertext
        assert decrypt_secret(m_row.api_key_ciphertext) == canary
        assert o_row and o_row.client_secret_encrypted
        assert decrypt_secret(o_row.client_secret_encrypted) == canary


def test_reencrypt_cas_does_not_overwrite_concurrent_db_write(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    oid = f"cas-oauth-{uuid4().hex}"
    _set_keys(monkeypatch, "old-cas-secret")
    db.add(_mk_oc(oid, client_secret_encrypted=encrypt_secret("old")))
    db.commit()

    with _oauth_cleanup(db, [oid]):
        _set_keys(monkeypatch, "old-cas-secret", _fk())
        _set_target(monkeypatch, OC)
        orig_exec, raced = db.execute, False

        def racing_execute(stmt: Any, *a: Any, **kw: Any) -> Any:
            nonlocal raced
            if not raced and getattr(stmt, "is_update", False):
                raced = True
                with Session(engine) as c_db:
                    row = c_db.get(OC, oid)
                    assert row is not None
                    row.client_secret_encrypted = encrypt_secret("fresh-concurrent")
                    c_db.commit()
            return orig_exec(stmt, *a, **kw)

        monkeypatch.setattr(db, "execute", racing_execute)
        s = reencrypt_secrets(db, batch_size=1)
        assert raced and s.rotated_values == 0
        assert s.already_current_values == 1 and s.unresolved_values == 0
        db.expire_all()
        row = db.get(OC, oid)
        assert row and row.client_secret_encrypted
        assert decrypt_secret(row.client_secret_encrypted) == "fresh-concurrent"


def test_reencrypt_respects_chatgpt_refresh_lock_without_needs_relogin(
    minimal_demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, oid, uid = _org_ctx(db, minimal_demo)
    _set_keys(monkeypatch, "old-chatgpt-secret")
    monkeypatch.setattr(settings, "CHATGPT_LOCAL_AUTH", False)
    acct = {"account_id": "a1", "needs_relogin": False}
    auth_c = encrypt_secret(json.dumps(_tok("old-a", "old-r", -60)))
    kw: dict[str, Any] = {"org_id": oid, "updated_by_user_id": uid, "enabled": True}
    ms_k: dict[str, Any] = {"kind": "chatgpt_subscription", "chatgpt_account": acct}
    db.add(MS(**kw, **ms_k, chatgpt_auth_ciphertext=auth_c))
    db.commit()

    mp = monkeypatch
    _set_keys(mp, "old-chatgpt-secret", _fk())
    _set_target(mp, MS)
    entered, allow = threading.Event(), threading.Event()
    res: dict[str, Any] = {}
    orig_rs = chatgpt.refresh_session

    @contextmanager
    def paused_rs(org_id: UUID) -> Iterator[Session]:
        with orig_rs(org_id) as s:
            orig_commit = s.commit

            def pause_first() -> None:
                orig_commit()
                if not entered.is_set():
                    entered.set()
                    assert allow.wait(timeout=5)

            s.commit = pause_first  # type: ignore[method-assign]
            yield s

    mp.setattr(chatgpt, "refresh_session", paused_rs)
    af = lambda *_a, **_k: _tok("fresh-a", "fresh-r", 3600)  # noqa: E731
    mp.setattr(chatgpt, "auth_request", af)
    tf = lambda: res.__setitem__("t", chatgpt.access_token(oid))  # noqa: E731
    t = threading.Thread(target=tf)
    t.start()
    assert entered.wait(timeout=5)

    with Session(engine) as r_db:
        r_pid = r_db.execute(text("SELECT pg_backend_pid()")).scalar_one()
        rf = lambda: res.__setitem__("s", reencrypt_secrets(r_db, batch_size=1))  # noqa: E731
        rt = threading.Thread(target=rf)
        rt.start()
        sql = "SELECT 1 FROM pg_locks WHERE pid=:p AND locktype='advisory' AND NOT granted"
        q, blocked, end = text(sql), False, time.monotonic() + 5
        while time.monotonic() < end and rt.is_alive():
            if db.execute(q, {"p": r_pid}).first() is not None:
                blocked = True
                break
            time.sleep(0.01)
        allow.set()
        rt.join(timeout=5)
    t.join(timeout=5)

    assert blocked and res.get("t") == "fresh-a"
    s = res["s"]
    assert s.already_current_values == 1 and s.rotated_values == 0
    db.expire_all()
    saved = db.get(MS, oid)
    assert saved and saved.chatgpt_account == acct and saved.chatgpt_auth_ciphertext
    tok = decrypt_secret(saved.chatgpt_auth_ciphertext)
    assert json.loads(tok)["access"] == "fresh-a"


def test_im_rotation_preserves_gateway_delivery_binding_and_blocks_real_change(
    minimal_demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    emp, oid, uid = _org_ctx(db, minimal_demo)
    assert emp.work_email
    _set_keys(monkeypatch, "old-im-secret")
    old_c = encrypt_secret(json.dumps({"bot_id": "b1", "secret": "s1"}))
    wecom = (oid, "wecom")
    is_kw: dict[str, Any] = {"org_id": oid, "platform": "wecom", "enabled": True}
    db.add(IS(**is_kw, credentials=old_c, updated_by_user_id=uid))
    db.commit()
    _set_keys(monkeypatch, "old-im-secret", _fk())
    g, instances = gateway.Gateway(engine), []
    monkeypatch.setitem(gateway.ADAPTERS, "wecom", lambda *a: _FakeIm(instances, *a))
    ev_kw: dict[str, Any] = {"org_id": oid, "platform": "wecom", "event_id": "ev-1"}
    ev = Event(**ev_kw, external_user_id="eu1", external_chat_id="ec1", private=True)

    async def exercise() -> None:
        try:
            await g.refresh()
            for _ in range(50):
                if wecom in g.adapters:
                    break
                await asyncio.sleep(0.01)
            orig_task, orig_adapter = g.tasks[wecom][1], instances[0]
            with monkeypatch.context() as sub:
                _set_target(sub, IS)
                assert reencrypt_secrets(db, batch_size=1).rotated_values == 1

            assert g.enabled(*wecom, old_c)
            assert g.connection_state(*wecom, old_c, utc_now(), "b1")
            await g.refresh()
            assert g.tasks[wecom][1] is orig_task and not orig_adapter.closed
            assert binding.bind_email(db, ev, "b1", old_c, emp.work_email)
            iq: dict[str, Any] = {"org_id": oid, "recipient_employee_id": emp.id}
            add_item(db, InboxItem(**iq, kind=InboxKind.QUESTION, message="m"))
            db.commit()
            await notifications.send_pending(engine, g.adapters)
            n_q = sm_select(ImNotification).where(ImNotification.org_id == oid)
            assert db.exec(n_q).one().status == "sent"
            assert len(orig_adapter.sent) == 1

            row = db.get(IS, wecom)
            assert row is not None
            row.credentials = encrypt_secret('{"bot_id":"b1","secret":"s2"}')
            db.commit()
            assert not g.enabled(*wecom, old_c)
            assert not g.connection_state(*wecom, old_c, utc_now())
            assert not binding.bind_email(db, ev, "b1", old_c, emp.work_email)
            await g.refresh()
            assert orig_adapter.closed and g.tasks[wecom][1] is not orig_task
        finally:
            for _, t in g.tasks.values():
                t.cancel()
            ts = [t for _, t in g.tasks.values()]
            await asyncio.gather(*ts, return_exceptions=True)

    asyncio.run(exercise())
