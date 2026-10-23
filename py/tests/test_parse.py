from __future__ import annotations

import pytest

from villanelle import (
    DiagnosticCode,
    Node,
    NodeKind,
    SourcePosition,
    SourceSpan,
    TokenKind,
    parse,
    span_of,
    text_of,
)


def pos(offset: int, line: int, column: int) -> SourcePosition:
    return SourcePosition(offset, line, column)


def test_parses_the_tracer_slice_into_a_directive_holding_a_slice_node() -> None:
    syntax = parse("connect hyperhdr_color[144:152];")
    assert syntax.diagnostics == ()
    assert [(t.kind, t.text) for t in syntax.tokens] == [
        ("WORD", "connect"),
        ("SPACE", " "),
        ("WORD", "hyperhdr_color"),
        ("LBRACK", "["),
        ("WORD", "144"),
        ("COLON", ":"),
        ("WORD", "152"),
        ("RBRACK", "]"),
        ("SEMI", ";"),
    ]
    assert syntax.root == Node(
        NodeKind.DOCUMENT, 0, 9, (Node(NodeKind.DIRECTIVE, 0, 9, (Node(NodeKind.SLICE, 2, 8, ()),)),)
    )


def test_parses_the_index_form() -> None:
    syntax = parse("connect foo[1];")
    assert syntax.diagnostics == ()
    assert syntax.root.children[0].children[0] == Node(NodeKind.SLICE, 2, 6, ())


def test_document_node_covers_leading_and_trailing_whitespace() -> None:
    syntax = parse(" \tconnect foo[1]; ")
    assert (syntax.root.start, syntax.root.end) == (0, len(syntax.tokens))
    assert syntax.tokens[0].kind is TokenKind.SPACE
    assert syntax.tokens[-1].kind is TokenKind.SPACE


def test_reports_empty_slice_as_one_located_diagnostic() -> None:
    syntax = parse("connect foo[:];")
    assert len(syntax.diagnostics) == 1
    assert syntax.diagnostics[0].code is DiagnosticCode.BAD_SLICE
    assert syntax.diagnostics[0].span == SourceSpan(pos(13, 0, 13), pos(14, 0, 14))
    assert text_of(syntax, syntax.root) == "connect foo[:];"


def test_codes_lexical_errors_by_the_offending_token() -> None:
    assert [d.code for d in parse("a \u0001").diagnostics] == [DiagnosticCode.UNEXPECTED_CHARACTER]
    assert [d.code for d in parse('a "b').diagnostics] == [DiagnosticCode.UNTERMINATED_STRING]
    assert [d.code for d in parse("a ﻿").diagnostics] == [DiagnosticCode.UNEXPECTED_CHARACTER]
    assert parse("﻿a").diagnostics == ()


def test_locates_unexpected_end_of_input_at_the_end_of_the_text() -> None:
    syntax = parse("a {\n  b")
    assert syntax.diagnostics[0].code is DiagnosticCode.EXPECTED_CLOSING_BRACE
    assert syntax.diagnostics[0].span == SourceSpan(pos(7, 1, 3), pos(7, 1, 3))


def test_counts_positions_in_utf16_code_units_lines_after_each_newline() -> None:
    syntax = parse("a '\U0001f600'\r\nb")
    b = syntax.tokens[-1]
    assert b.text == "b"
    assert b.span.start == pos(8, 1, 0)
    assert syntax.tokens[2].span == SourceSpan(pos(2, 0, 2), pos(6, 0, 6))


@pytest.mark.parametrize("text", ["", "]", "{", "}}}", "a[", "a[1:2", "[[[", "\ud800", "a;;;b c d", "#"])
def test_never_raises(text: str) -> None:
    syntax = parse(text)
    assert text_of(syntax, syntax.root) == text


class TestSpanOfAndTextOf:
    syntax = parse("a b\nc")

    def test_give_the_span_and_text_of_a_token_range(self) -> None:
        assert text_of(self.syntax, Node(NodeKind.ERROR, 1, 4, ())) == " b\n"
        assert span_of(self.syntax, Node(NodeKind.ERROR, 2, 5, ())) == SourceSpan(pos(2, 0, 2), pos(5, 1, 1))

    def test_give_a_zero_width_span_at_a_token_start_or_the_end_of_the_text(self) -> None:
        assert span_of(self.syntax, Node(NodeKind.ERROR, 2, 2, ())) == SourceSpan(pos(2, 0, 2), pos(2, 0, 2))
        end = pos(5, 1, 1)
        assert span_of(self.syntax, Node(NodeKind.ERROR, 5, 5, ())) == SourceSpan(end, end)
        assert text_of(self.syntax, Node(NodeKind.ERROR, 5, 5, ())) == ""
        empty = parse("")
        assert span_of(empty, empty.root) == SourceSpan(pos(0, 0, 0), pos(0, 0, 0))

    @pytest.mark.parametrize(("start", "end"), [(-1, 0), (0, 6), (3, 2)])
    def test_raise_value_error_outside_the_tokens_or_when_start_exceeds_end(self, start: int, end: int) -> None:
        rng = Node(NodeKind.ERROR, start, end, ())
        with pytest.raises(ValueError):
            span_of(self.syntax, rng)
        with pytest.raises(ValueError):
            text_of(self.syntax, rng)
