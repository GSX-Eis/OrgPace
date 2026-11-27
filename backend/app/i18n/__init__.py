import importlib
import pkgutil
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Literal

Locale = Literal["zh-CN", "en"]
LOCALES: tuple[Locale, ...] = ("zh-CN", "en")

current_locale: ContextVar[Locale] = ContextVar("current_locale", default="zh-CN")


def parse_accept_language(header: str | None) -> Locale:
    """Resolve the active UI locale from an Accept-Language header."""
    # shortcut: Does not parse q-weights; add q-weight parsing when supporting a third language.
    if header and header.strip().lower().startswith("en"):
        return "en"
    return "zh-CN"


@contextmanager
def use_locale(locale: Locale | None) -> Iterator[None]:
    """Temporarily bind ``current_locale`` for background workers and IM delivery."""
    target: Locale = "en" if locale == "en" else "zh-CN"
    token = current_locale.set(target)
    try:
        yield
    finally:
        current_locale.reset(token)


def _load_catalog() -> dict[str, str]:
    catalog: dict[str, str] = {}
    for module_info in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
        if not module_info.name.startswith("en_"):
            continue
        module = importlib.import_module(f"{__name__}.{module_info.name}")
        entries: dict[str, str] = getattr(module, "EN", {})
        for key, translation in entries.items():
            if key in catalog and catalog[key] != translation:
                raise RuntimeError(
                    f"Conflicting English translation for key {key!r} in {module_info.name}"
                )
            catalog[key] = translation
    return catalog


EN_CATALOG: dict[str, str] = _load_catalog()


def tr(text: str, **params: object) -> str:
    """Translate a Chinese template string according to ``current_locale``."""
    template = EN_CATALOG.get(text, text) if current_locale.get() == "en" else text
    return template.format(**params) if params else template


def bilingual(text: str, **params: object) -> tuple[str, str]:
    """Render both Chinese and English variants for dual-language storage."""
    zh = text.format(**params) if params else text
    en_template = EN_CATALOG.get(text, text)
    en = en_template.format(**params) if params else en_template
    return zh, en


def reply_language_instruction() -> str:
    """Return an auxiliary system-prompt instruction when replying in English."""
    if current_locale.get() == "en":
        return (
            "请始终用英文回复用户，工具返回的中文提示也转述为英文，"
            "业务数据（如姓名、部门名、能力条目、工作记录标题、证据原文与画像陈述）保留原文。"
        )
    return ""
