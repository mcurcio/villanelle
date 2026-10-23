"""Typed values: the view over the CST that consumers read instead of re-parsing tokens (vil-9ze).

The ``Value`` union grows one kind at a time; kinds not yet supported raise NotImplementedError (see value_of).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import ClassVar

from villanelle.diagnostics import Diagnostic, DiagnosticCode, DiagnosticError
from villanelle.span import SourceSpan
from villanelle.syntax.cst import Node, NodeKind, Syntax, ValueRef, span_of
from villanelle.syntax.tokens import Token, TokenKind


class ValueKind(StrEnum):
    WORD = "word"
    STRING = "string"
    SLICE = "slice"
    INDEX = "index"


@dataclass(frozen=True, slots=True)
class WordValue:
    """A bare word, such as ``listen`` or ``/*.conf``, exactly as written."""

    kind: ClassVar[ValueKind] = ValueKind.WORD
    text: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class StringValue:
    """A quoted string literal, decoded: the text between the quotes with the v1 escapes \\\\ \\n \\t \\r \\" \\'
    (vil-m8w). Any other backslash escape decodes to the escaped character itself (``\\q`` gives ``q``), as the rasl
    lexer did."""

    kind: ClassVar[ValueKind] = ValueKind.STRING
    value: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class SliceValue:
    """``name[start:end]``, ``name[start:]`` or ``name[:end]``; the absent side is None. The span runs from the first
    character of the name to the closing ``]``."""

    kind: ClassVar[ValueKind] = ValueKind.SLICE
    name: str
    start: int | None
    end: int | None
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class IndexValue:
    """``name[index]``: one element (vil-9ze.2)."""

    kind: ClassVar[ValueKind] = ValueKind.INDEX
    name: str
    index: int
    span: SourceSpan


Value = WordValue | StringValue | SliceValue | IndexValue


def value_of(syntax: Syntax, ref: ValueRef) -> Value:
    """The typed value a reference points to.

    Bounds and indexes are integers (vil-9ze.3): an optional "-" then ASCII digits, with absolute value at most
    2**53 - 1 (the TypeScript package's safe-integer range, so both languages agree). Their meaning is the consumer's.

    Raises DiagnosticError E4001 (NON_INTEGER_BOUND), spanning the bad bound token, for any other bound;
    NotImplementedError "unsupported value kind: <kind>" for a kind the union does not have yet (lists, until vil-9ze);
    TypeError when ``ref`` is not a WORD/STRING token index or a slice/list node of ``syntax``.
    """
    if isinstance(ref, Node):
        if ref.kind is NodeKind.SLICE:
            return _slice_value(syntax, ref)
        if ref.kind is NodeKind.LIST:
            raise NotImplementedError("unsupported value kind: list")
        raise TypeError(f"not a value: a {ref.kind} node")
    if isinstance(ref, bool) or not isinstance(ref, int):
        raise TypeError(f"not a value reference: {ref!r}")
    return _token_value(syntax, ref)


def _token_value(syntax: Syntax, index: int) -> Value:
    if not 0 <= index < len(syntax.tokens):
        raise TypeError(f"not a token index: {index}")
    token = syntax.tokens[index]
    if token.kind is TokenKind.WORD:
        return WordValue(token.text, token.span)
    if token.kind is TokenKind.STRING:
        return StringValue(_decode_string(token.text), token.span)
    raise TypeError(f"not a value: a {token.kind} token")


# Backslash escapes with their own meaning; any other ``\x`` (``\\``, ``\"``, ``\'`` among them) decodes to ``x``.
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r"}
_ESCAPE = re.compile(r"\\(.)", re.DOTALL)


def _decode_string(text: str) -> str:
    """The text between a STRING token's quotes, escapes decoded (see StringValue). One escape is one code point."""
    return _ESCAPE.sub(lambda m: _ESCAPES.get(m[1], m[1]), text[1:-1])


_W = TokenKind.WORD
_C = TokenKind.COLON
# grammar rule bounds: W, W:W, W: or :W
_BOUNDS_SHAPES: tuple[tuple[TokenKind, ...], ...] = ((_W,), (_W, _C, _W), (_W, _C), (_C, _W))


def _slice_value(syntax: Syntax, node: Node) -> SliceValue | IndexValue:
    """A slice node holds exactly ``WORD [ bounds ]``."""
    tokens = syntax.tokens[node.start : node.end]
    bounds = tokens[2:-1]
    if (
        len(tokens) < 3
        or tokens[0].kind is not TokenKind.WORD
        or tokens[1].kind is not TokenKind.LBRACK
        or tokens[-1].kind is not TokenKind.RBRACK
        or tuple(t.kind for t in bounds) not in _BOUNDS_SHAPES
    ):
        raise TypeError(f"not a well-formed slice: [{node.start}, {node.end})")
    name = tokens[0].text
    span = span_of(syntax, node)
    if len(bounds) == 1:
        return IndexValue(name, _integer_bound(bounds[0]), span)
    start = _integer_bound(bounds[0]) if bounds[0].kind is TokenKind.WORD else None
    end_token = bounds[1] if bounds[0].kind is TokenKind.COLON else (bounds[2] if len(bounds) > 2 else None)
    end = None if end_token is None else _integer_bound(end_token)
    return SliceValue(name, start, end, span)


_INTEGER = re.compile(r"-?[0-9]+")
_MAX_SAFE_INTEGER = 2**53 - 1


def _integer_bound(token: Token) -> int:
    """The integer a bound token spells (vil-9ze.3), or a located E4001."""
    if _INTEGER.fullmatch(token.text):
        value = int(token.text)
        if abs(value) <= _MAX_SAFE_INTEGER:
            return value
    raise DiagnosticError(
        Diagnostic(DiagnosticCode.NON_INTEGER_BOUND, f'slice bound "{token.text}" is not an integer', token.span)
    )
