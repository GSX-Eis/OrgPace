"""Symmetric credential encryption with MultiFernet key rotation support.

When ``settings.ENCRYPTION_KEYS`` is unset, encryption and decryption use a
Fernet key derived via HKDF-SHA256 from ``settings.SECRET_KEY`` with the fixed
context ``b"employee-profile/stored-credentials/v1"``.

When ``settings.ENCRYPTION_KEYS`` is set to one or more comma-separated standard
32-byte urlsafe base64 Fernet keys (``Fernet.generate_key()``), encryption uses
the first configured key while decryption tries all configured keys in order
before falling back to the legacy ``SECRET_KEY``-derived key.
"""

import base64
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import SecretStr

from app.core.config import parse_encryption_keys, settings

LEGACY_HKDF_INFO = b"employee-profile/stored-credentials/v1"


class SecretUnavailable(Exception):
    def __init__(self) -> None:
        super().__init__("保存的密钥已失效，请重新填写")


def _legacy_fernet(secret_key: str) -> Fernet:
    key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=LEGACY_HKDF_INFO,
    ).derive(secret_key.encode())
    return Fernet(base64.urlsafe_b64encode(key))


@lru_cache(maxsize=8)
def _build_cipher_pair(
    secret_key: str, raw_encryption_keys: str | None
) -> tuple[Fernet, MultiFernet]:
    legacy = _legacy_fernet(secret_key)
    if raw_encryption_keys is None:
        return legacy, MultiFernet([legacy])
    fernets = [Fernet(key) for key in parse_encryption_keys(raw_encryption_keys)]
    return fernets[0], MultiFernet([*fernets, legacy])


def _cipher_pair() -> tuple[Fernet, MultiFernet]:
    raw = settings.ENCRYPTION_KEYS
    raw_value = raw.get_secret_value() if isinstance(raw, SecretStr) else raw
    return _build_cipher_pair(settings.SECRET_KEY, raw_value)


def encrypt_secret(plain: str) -> str:
    _, cipher = _cipher_pair()
    return cipher.encrypt(plain.encode()).decode()


def decrypt_secret(token: str) -> str:
    _, cipher = _cipher_pair()
    try:
        return cipher.decrypt(token.encode()).decode()
    except InvalidToken, UnicodeError:
        raise SecretUnavailable() from None


def rotate_secret(token: str) -> str:
    _, cipher = _cipher_pair()
    try:
        token_bytes = token.encode()
        cipher.decrypt(token_bytes).decode()
        return cipher.rotate(token_bytes).decode()
    except InvalidToken, UnicodeError:
        raise SecretUnavailable() from None


def rotate_if_needed(token: str) -> str | None:
    """Return a rotated ciphertext if ``token`` is not encrypted with the primary key."""
    primary, _ = _cipher_pair()
    try:
        token_bytes = token.encode()
        primary.decrypt(token_bytes).decode()
        return None
    except InvalidToken:
        return rotate_secret(token)
    except UnicodeError:
        raise SecretUnavailable() from None
