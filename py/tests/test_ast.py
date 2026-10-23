"""The directive facade: ports ts/src/ast/ast.test.ts case by case (vil-g7n.2.3)."""

from __future__ import annotations

from collections.abc import Iterable

import pytest

from villanelle import (
    AstDirective,
    IndexValue,
    Node,
    NodeKind,
    SliceValue,
    SourcePosition,
    SourceSpan,
    StringValue,
    WordValue,
    create_ast,
    find_directives,
    parse,
    parse_document,
    walk_directives,
)


def names(directives: Iterable[AstDirective]) -> list[str]:
    return [d.name for d in directives]


NESTED = """http {
  server {
    listen 80;
    location / { root /var/www; }
  }
  server { listen 443 }
}
events { worker 4 }
"""


def test_gives_top_level_directives_with_names_ending_at_a_semicolon_or_a_newline() -> None:
    doc = parse_document("a 1;\nb 2\nc; d\n")
    assert doc.syntax.diagnostics == ()
    assert names(doc.children) == ["a", "b", "c", "d"]
    assert len(doc.children) == 4


def test_parses_empty_input_to_an_empty_list() -> None:
    doc = parse_document("")
    assert len(doc.children) == 0
    with pytest.raises(IndexError):
        doc.children[0]


def test_gives_args_in_source_order_without_spaces_or_comments() -> None:
    doc = parse_document('listen 80 "a b" foo[1:2] bar[3] [1, 2]  # trailing\n')
    assert doc.syntax.diagnostics == ()
    directive = doc.children[0]
    assert directive.name == "listen"
    assert [a.text for a in directive.args] == ["80", '"a b"', "foo[1:2]", "bar[3]", "[1, 2]"]
    word, string, slc, index, lst = directive.args
    assert word.ref == 2
    assert isinstance(word.value(), WordValue)
    assert word.value() == WordValue("80", word.span)
    assert string.value() == StringValue("a b", string.span)
    assert isinstance(slc.ref, Node)
    assert slc.ref.kind is NodeKind.SLICE
    slice_value = slc.value()
    assert isinstance(slice_value, SliceValue)
    assert (slice_value.name, slice_value.start, slice_value.end) == ("foo", 1, 2)
    index_value = index.value()
    assert isinstance(index_value, IndexValue)
    assert (index_value.name, index_value.index) == ("bar", 3)
    assert isinstance(lst.ref, Node)
    assert lst.ref.kind is NodeKind.LIST
    with pytest.raises(NotImplementedError, match=r"^unsupported value kind: list$"):
        lst.value()


def test_gives_each_argument_its_span_and_the_directive_its_span_from_name_to_terminator() -> None:
    doc = parse_document("x\n  key 'v';\n")
    directive = doc.children[1]
    assert directive.span == SourceSpan(SourcePosition(4, 1, 2), SourcePosition(12, 1, 10))
    assert directive.args[0].span == SourceSpan(SourcePosition(8, 1, 6), SourcePosition(11, 1, 9))
    assert directive.node is doc.syntax.root.children[1]


def test_gives_a_body_for_a_block_and_none_without_one_a_list_arg_is_not_a_body() -> None:
    doc = parse_document(NESTED)
    assert doc.syntax.diagnostics == ()
    http = doc.children.find_by_name("http")
    assert http is not None
    assert http.args == ()
    assert http.body is not None
    assert names(http.body) == ["server", "server"]
    server = http.body[0]
    assert server.body is not None
    assert names(server.body) == ["listen", "location"]
    location = server.body[-1]
    assert [a.text for a in location.args] == ["/"]
    assert location.body is not None
    assert names(location.body) == ["root"]
    assert location.body[0].body is None
    assert parse_document("a [1];").children[0].body is None


def test_walks_depth_first_each_directive_before_its_children_with_its_parent() -> None:
    visits = [f"{parent.name if parent else '-'}>{d.name}" for d, parent in walk_directives(parse_document(NESTED))]
    assert visits == [
        "->http",
        "http>server",
        "server>listen",
        "server>location",
        "location>root",
        "http>server",
        "server>listen",
        "->events",
        "events>worker",
    ]


def test_finds_directives_at_any_depth_in_walk_order() -> None:
    doc = parse_document(NESTED)
    assert [d.args[0].text for d in find_directives(doc, "listen")] == ["80", "443"]
    assert len(find_directives(doc, "root")) == 1
    assert find_directives(doc, "missing") == []


def test_supports_find_by_name_filter_by_name_indexes_slices_and_iteration() -> None:
    lst = parse_document("a 1; b 2; a 3; c 4;").children
    first_a = lst.find_by_name("a")
    assert first_a is not None
    assert first_a.args[0].text == "1"
    assert lst.find_by_name("z") is None
    assert [d.args[0].text for d in lst.filter_by_name("a")] == ["1", "3"]
    assert lst.filter_by_name("z") == []
    assert lst[-1].name == "c"
    assert lst[-4].name == "a"
    with pytest.raises(IndexError):
        lst[-5]
    with pytest.raises(IndexError):
        lst[4]
    assert names(lst[1:3]) == ["b", "a"]
    assert lst[1:3][0] is lst[1]
    assert names(lst) == ["a", "b", "a", "c"]
    assert names(reversed(lst)) == ["c", "a", "b", "a"]
    assert lst[2] in lst
    assert lst.index(lst[2]) == 2


def test_keeps_one_directive_object_per_node_across_accesses() -> None:
    doc = parse_document(NESTED)
    http = doc.children[0]
    assert next(iter(doc.children)) is http
    assert doc.children.find_by_name("http") is http
    assert http.body is not None
    assert find_directives(doc, "server")[0] is http.body[0]
    assert find_directives(doc, "root")[0] is find_directives(doc, "root")[0]
    assert find_directives(doc, "root")[0].document is doc


def count_errors(node: Node) -> int:
    return (1 if node.kind is NodeKind.ERROR else 0) + sum(count_errors(child) for child in node.children)


def test_skips_error_nodes_keeps_the_directives_around_them_and_never_raises_on_broken_input() -> None:
    doc = parse_document("a {\n b;\n : x;\n c;\n}\nd;\n")
    assert [d.code for d in doc.syntax.diagnostics] == ["E2001"]
    assert count_errors(doc.syntax.root) == 1
    # The bad statement `: x;` is one error node: the block keeps `b` and `c`, and `d` follows the block.
    assert names(doc.children) == ["a", "d"]
    body = doc.children[0].body
    assert body is not None
    assert names(body) == ["b", "c"]
    assert [d.name for d, _ in walk_directives(doc)] == ["a", "b", "c", "d"]
    for broken in ["a {", '"', "}", "a [", "\u0001", 'a "b\nc;']:
        broken_doc = parse_document(broken)
        assert len(broken_doc.syntax.diagnostics) > 0
        for directive, _ in walk_directives(broken_doc):
            [a.text for a in directive.args]


def test_is_create_ast_over_parse() -> None:
    syntax = parse("a b;")
    doc = create_ast(syntax)
    assert doc.syntax is syntax
    assert doc.children[0].args[0].value() == WordValue("b", syntax.tokens[2].span)
