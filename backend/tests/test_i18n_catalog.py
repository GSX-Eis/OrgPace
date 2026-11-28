"""AST guard ensuring backend Chinese error/i18n strings exist in EN_CATALOG."""

import ast
import re
import string
from pathlib import Path

import pytest

from app.i18n import EN_CATALOG

pytestmark = pytest.mark.unit

HAN_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
FORMATTER = string.Formatter()
APP_DIR = Path(__file__).resolve().parents[1] / "app"


def _placeholders(template: str) -> set[str]:
    return {
        field_name
        for _, field_name, _, _ in FORMATTER.parse(template)
        if field_name is not None
    }


def _call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return ""


def _check_expr(
    expr: ast.AST,
    rel_path: str,
    context: str,
    catalog: dict[str, str],
    errors: list[str],
    seen: set[tuple[str, int, str, str]],
) -> None:
    if isinstance(expr, ast.Compare):
        return
    if isinstance(expr, ast.JoinedStr):
        parts = [
            v.value
            if isinstance(v, ast.Constant) and isinstance(v.value, str)
            else "{...}"
            for v in expr.values
        ]
        preview = "".join(parts)
        if HAN_RE.search(preview):
            key = (rel_path, expr.lineno, f"{context}-fstr", preview)
            if key not in seen:
                seen.add(key)
                errors.append(
                    f"{rel_path}:{expr.lineno} ({context}): untagged Chinese f-string {preview!r}; use tr(..., **params)"
                )
        return
    if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        text = expr.value
        if HAN_RE.search(text):
            key = (rel_path, expr.lineno, context, text)
            if key in seen:
                return
            seen.add(key)
            if text not in catalog:
                errors.append(
                    f"{rel_path}:{expr.lineno} ({context}): missing EN_CATALOG translation for {text!r}"
                )
            else:
                expected = _placeholders(text)
                actual = _placeholders(catalog[text])
                if expected != actual:
                    errors.append(
                        f"{rel_path}:{expr.lineno} ({context}): placeholder mismatch for {text!r}: key={sorted(expected)}, en={sorted(actual)}"
                    )
        return
    for child in ast.iter_child_nodes(expr):
        _check_expr(child, rel_path, context, catalog, errors, seen)


def scan_i18n_catalog(root: Path, catalog: dict[str, str] | None = None) -> list[str]:
    active_catalog = EN_CATALOG if catalog is None else catalog
    errors: list[str] = []
    seen: set[tuple[str, int, str, str]] = set()

    for file_path in sorted(root.rglob("*.py")):
        rel = file_path.relative_to(root).as_posix()
        if rel.startswith("i18n/") or rel.startswith("alembic/"):
            continue
        tree = ast.parse(file_path.read_text(encoding="utf-8"), filename=str(file_path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Raise) and node.exc is not None:
                _check_expr(node.exc, rel, "raise", active_catalog, errors, seen)
            elif isinstance(node, ast.Call):
                name = _call_name(node)
                if name == "HTTPException":
                    detail_expr = next(
                        (kw.value for kw in node.keywords if kw.arg == "detail"),
                        node.args[1] if len(node.args) >= 2 else None,
                    )
                    if detail_expr is not None:
                        _check_expr(
                            detail_expr,
                            rel,
                            "HTTPException.detail",
                            active_catalog,
                            errors,
                            seen,
                        )
                elif name in {"tr", "bilingual"}:
                    text_expr = (
                        node.args[0]
                        if node.args
                        else next(
                            (kw.value for kw in node.keywords if kw.arg == "text"),
                            None,
                        )
                    )
                    if text_expr is not None:
                        _check_expr(text_expr, rel, name, active_catalog, errors, seen)
    return errors


def _docstring_node_ids(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(
            node,
            (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef),
        ) and (
            node.body
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)
        ):
            ids.add(id(node.body[0].value))
    return ids


def _eval_static_str(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _eval_static_str(node.left)
        right = _eval_static_str(node.right)
        if left is not None and right is not None:
            return left + right
    return None


def _collect_referenced_strings(tree: ast.AST) -> set[str]:
    docstrings = _docstring_node_ids(tree)
    referenced: set[str] = set()

    def visit(node: ast.AST) -> None:
        if id(node) in docstrings:
            return
        if isinstance(node, ast.JoinedStr):
            for part in node.values:
                if isinstance(part, ast.FormattedValue):
                    visit(part.value)
                    if part.format_spec is not None:
                        visit(part.format_spec)
            return
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            combined = _eval_static_str(node)
            if combined is not None:
                referenced.add(combined)
                return
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            referenced.add(node.value)
            return
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(tree)
    return referenced


def find_orphan_catalog_keys(
    root: Path, catalog: dict[str, str] | None = None
) -> list[str]:
    active_catalog = EN_CATALOG if catalog is None else catalog
    referenced: set[str] = set()
    for file_path in sorted(root.rglob("*.py")):
        rel = file_path.relative_to(root).as_posix()
        if rel.startswith("i18n/") or rel.startswith("alembic/"):
            continue
        tree = ast.parse(file_path.read_text(encoding="utf-8"), filename=str(file_path))
        referenced.update(_collect_referenced_strings(tree))
    return sorted(key for key in active_catalog if key not in referenced)


def test_backend_i18n_catalog_covers_all_chinese_literals() -> None:
    assert scan_i18n_catalog(APP_DIR) == []


def test_backend_i18n_catalog_has_no_orphan_keys() -> None:
    assert find_orphan_catalog_keys(APP_DIR) == []


def test_i18n_catalog_orphan_detector_rejects_unused_keys(tmp_path: Path) -> None:
    sample = tmp_path / "sample.py"
    sample.write_text(
        "\n".join(
            [
                '"""仅文档字符串中的废话"""',
                "from fastapi import HTTPException",
                "from app.i18n import bilingual, tr",
                "",
                'CONST_MSG = "模块常量文案"',
                'LABELS = {"a": "字典文案"}',
                'ITEMS = ["列表文案", ("元组文案",)]',
                "",
                "def handle(flag: bool, msg: str = '默认参数文案') -> str:",
                "    if flag:",
                '        raise ValueError("异常字面量")',
                '    HTTPException(400, detail="接口报错")',
                '    bilingual("双语文案")',
                '    return tr("翻译文案")',
            ]
        ),
        encoding="utf-8",
    )
    fake_catalog = {
        "模块常量文案": "Const copy",
        "字典文案": "Dict copy",
        "列表文案": "List copy",
        "元组文案": "Tuple copy",
        "默认参数文案": "Default arg copy",
        "异常字面量": "Exception literal",
        "接口报错": "API error",
        "双语文案": "Bilingual copy",
        "翻译文案": "Translated copy",
        "仅文档字符串中的废话": "Docstring only",
        "彻底废弃的文案": "Completely unused",
    }
    assert find_orphan_catalog_keys(tmp_path, catalog=fake_catalog) == [
        "仅文档字符串中的废话",
        "彻底废弃的文案",
    ]


def test_orphan_key_full_constant_not_fstring_fragment(tmp_path: Path) -> None:
    sample = tmp_path / "sample.py"
    sample.write_text(
        "from app.i18n import tr\n"
        'LABEL = "前置" + "条件"\n'
        "def display() -> str:\n"
        "    return tr(LABEL)\n",
        encoding="utf-8",
    )
    assert find_orphan_catalog_keys(tmp_path, {"前置条件": "Precondition"}) == []

    sample.write_text(
        "from app.i18n import tr\n"
        "def display(name: str) -> str:\n"
        "    return f\"前置{tr('内部提示')}{name}\"\n",
        encoding="utf-8",
    )
    assert find_orphan_catalog_keys(
        tmp_path, {"前置": "Prefix", "内部提示": "Inner hint"}
    ) == ["前置"]


def test_i18n_catalog_scanner_rejects_missing_fstring_and_mismatch(
    tmp_path: Path,
) -> None:
    sample = tmp_path / "sample.py"
    sample.write_text(
        "\n".join(
            [
                "from fastapi import HTTPException",
                "from app.i18n import bilingual, tr",
                "",
                "def ok(reason: str) -> None:",
                "    if not reason:",
                '        raise RuntimeError(tr("已知错误"), "估计" in reason)',
                "",
                "def broken(x: str) -> None:",
                '    raise ValueError("新增未翻译异常")',
                '    HTTPException(400, detail="新增未翻译详情")',
                '    tr("未翻译模板 {name}", name=x)',
                '    bilingual("未翻译双语")',
                '    raise RuntimeError(f"拼接中文 {x}")',
                '    tr("占位符不匹配 {a}", a=x)',
            ]
        ),
        encoding="utf-8",
    )
    fake_catalog = {
        "已知错误": "Known error",
        "占位符不匹配 {a}": "Placeholder mismatch {b}",
    }
    errors = scan_i18n_catalog(tmp_path, catalog=fake_catalog)
    joined = "\n".join(errors)
    assert "新增未翻译异常" in joined
    assert "新增未翻译详情" in joined
    assert "未翻译模板 {name}" in joined
    assert "未翻译双语" in joined
    assert "untagged Chinese f-string" in joined
    assert "placeholder mismatch" in joined
    assert "已知错误" not in joined
    assert "估计" not in joined
