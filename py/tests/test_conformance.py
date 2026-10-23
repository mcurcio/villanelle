from __future__ import annotations

import json
import re
from typing import Any

import pytest
from conftest import REPO

from villanelle import Node, Syntax, parse, text_of

CONFORMANCE = REPO / "conformance"
EXPECTED = CONFORMANCE / "expected"
FILES = ("cases.json", "extra.json", "depth.json", "edge.json", "tracer.json")
"""Every corpus file; each case's name is unique across them."""


def load(file: str) -> list[dict[str, str]]:
    cases: list[dict[str, str]] = json.loads((CONFORMANCE / file).read_text(encoding="utf-8"))
    return cases


def cst_json(node: Node) -> list[Any]:
    return [node.kind.value, node.start, node.end, [cst_json(child) for child in node.children]]


def fmt(syntax: Syntax) -> bytes:
    """conformance/format.md, format v0."""
    value = {
        "tokens": [[t.kind.value, t.text] for t in syntax.tokens],
        "cst": cst_json(syntax.root),
        "diagnostics": [[d.code.value, d.span.start.line, d.span.start.column] for d in syntax.diagnostics],
    }
    # Not ensure_ascii=True: it also escapes U+007F, which the format (and TypeScript) writes raw. Escape each
    # UTF-16 code unit above U+007F instead, as format.md says.
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return (re.sub(r"[\u0080-\U0010ffff]", _escape, text) + "\n").encode("ascii")


def _escape(match: re.Match[str]) -> str:
    units = match.group().encode("utf-16-le", "surrogatepass")
    return "".join(f"\\u{int.from_bytes(units[i : i + 2], 'little'):04x}" for i in range(0, len(units), 2))


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def check_coverage(node: Node) -> None:
    """Each token index is either directly in one node's range and in no child, or inside exactly one child;
    children are in order, do not overlap and lie inside their parent."""
    at = node.start
    for child in node.children:
        assert child.start >= at, f"{child.kind} child starts inside {node.kind}"
        assert child.end >= child.start
        assert child.end <= node.end, f"{child.kind} child ends inside {node.kind}"
        if child.kind == "error":
            assert child.children == ()
        check_coverage(child)
        at = child.end


CASES = [pytest.param(c, id=f"{file}:{c['name']}") for file in FILES for c in load(file)]


@pytest.mark.parametrize("case", CASES)
def test_lossless_cst(case: dict[str, str]) -> None:
    src = case["src"]
    syntax = parse(src)
    assert text_of(syntax, syntax.root) == src
    assert syntax.root.kind == "document"
    assert (syntax.root.start, syntax.root.end) == (0, len(syntax.tokens))
    offset = 0
    for token in syntax.tokens:
        assert token.text != ""
        assert token.span.start.offset == offset
        offset = token.span.end.offset
        assert offset - token.span.start.offset == utf16_length(token.text)
    assert offset == utf16_length(src)
    check_coverage(syntax.root)


@pytest.mark.parametrize("case", CASES)
def test_expected_output_is_byte_identical(case: dict[str, str]) -> None:
    expected = EXPECTED / f"{case['name']}.json"
    assert expected.is_file(), f"missing {expected}"
    assert fmt(parse(case["src"])) == expected.read_bytes()
