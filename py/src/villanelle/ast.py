"""The directive-level facade over ``Syntax`` (layer 3; port of ts/src/ast). Read-only: it never changes the syntax
it wraps.

Identity: within one AstDocument, every directive node yields one AstDirective object, so ``is`` holds between the
results of any two accesses.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from typing import overload

from villanelle.span import SourceSpan
from villanelle.syntax.cst import Node, NodeKind, Syntax, ValueRef, span_of, text_of
from villanelle.syntax.parse import parse
from villanelle.syntax.tokens import Token, TokenKind
from villanelle.value import Value, value_of


class AstDocument:
    """A parsed document seen as directives. Build one with ``create_ast`` or ``parse_document``."""

    __slots__ = ("_children", "_directives", "_syntax")

    def __init__(self, syntax: Syntax) -> None:
        self._syntax = syntax
        # Identity cache: one AstDirective per directive node, keyed by the node's id (the syntax keeps it alive).
        self._directives: dict[int, AstDirective] = {}
        self._children = AstDirectiveList(self, _directives_of(syntax.root))

    @property
    def syntax(self) -> Syntax:
        """The syntax this facade wraps: tokens, tree and diagnostics."""
        return self._syntax

    @property
    def children(self) -> AstDirectiveList:
        """Top-level directives in source order. Error nodes are not directives and are skipped."""
        return self._children

    def _directive(self, node: Node) -> AstDirective:
        directive = self._directives.get(id(node))
        if directive is None:
            directive = AstDirective(self, node)
            self._directives[id(node)] = directive
        return directive


class AstDirectiveList(Sequence["AstDirective"]):
    """Directives of one scope (the document or one block), in source order. Indexes and slices behave as for any
    Python sequence (negative indexes count from the end; out of range raises IndexError); a slice is a list of the
    same scope."""

    __slots__ = ("_document", "_nodes")

    def __init__(self, document: AstDocument, nodes: tuple[Node, ...]) -> None:
        self._document = document
        self._nodes = nodes

    @overload
    def __getitem__(self, index: int) -> AstDirective: ...

    @overload
    def __getitem__(self, index: slice) -> AstDirectiveList: ...

    def __getitem__(self, index: int | slice) -> AstDirective | AstDirectiveList:
        if isinstance(index, slice):
            return AstDirectiveList(self._document, self._nodes[index])
        return self._document._directive(self._nodes[index])

    def __len__(self) -> int:
        return len(self._nodes)

    def __iter__(self) -> Iterator[AstDirective]:
        for node in self._nodes:
            yield self._document._directive(node)

    def __repr__(self) -> str:
        return f"AstDirectiveList({[d.name for d in self]!r})"

    def find_by_name(self, name: str) -> AstDirective | None:
        """The first directive named ``name``, or None."""
        return next((directive for directive in self if directive.name == name), None)

    def filter_by_name(self, name: str) -> list[AstDirective]:
        """Every directive named ``name``, in source order."""
        return [directive for directive in self if directive.name == name]


@dataclass(frozen=True, slots=True)
class AstArgument:
    """One value of a directive: a WORD or STRING token, a slice or a list."""

    ref: ValueRef
    text: str
    """The value's exact source text."""
    span: SourceSpan
    _document: AstDocument = field(repr=False, compare=False)

    def value(self) -> Value:
        """``value_of(document.syntax, ref)``, with the same errors."""
        return value_of(self._document.syntax, self.ref)


class AstDirective:
    """One directive: ``name value... ;``, ``name value...`` at a line end, or ``name value... { ... }``.
    Built by its AstDocument on first access; never construct one directly."""

    __slots__ = ("_args", "_body", "_document", "_name", "_node", "_span")

    def __init__(self, document: AstDocument, node: Node) -> None:
        syntax = document.syntax
        name, args, block = _anatomy_of(syntax.tokens, node)
        self._document = document
        self._node = node
        self._name = syntax.tokens[name].text
        self._args = tuple(_argument(document, ref) for ref in args)
        self._body = None if block is None else AstDirectiveList(document, _directives_of(block))
        self._span = span_of(syntax, node)

    @property
    def document(self) -> AstDocument:
        return self._document

    @property
    def name(self) -> str:
        """The text of the directive's first token."""
        return self._name

    @property
    def args(self) -> tuple[AstArgument, ...]:
        """The values after the name, in source order, without spaces, comments or punctuation."""
        return self._args

    @property
    def body(self) -> AstDirectiveList | None:
        """The block's directives, or None when the directive has no block."""
        return self._body

    @property
    def span(self) -> SourceSpan:
        """From the name to the directive's last token (its ``;``, its newline or its ``}``)."""
        return self._span

    @property
    def node(self) -> Node:
        """The underlying ``directive`` node."""
        return self._node

    def __repr__(self) -> str:
        return f"AstDirective({self._name!r}, args={[a.text for a in self._args]!r})"


def create_ast(syntax: Syntax) -> AstDocument:
    """Wrap a syntax in the facade. Pure and cheap: directives are built on first access."""
    return AstDocument(syntax)


def parse_document(text: str) -> AstDocument:
    """``create_ast(parse(text))``: the synchronous single-document entry point (vil-m8w). Never raises."""
    return create_ast(parse(text))


def walk_directives(document: AstDocument) -> Iterator[tuple[AstDirective, AstDirective | None]]:
    """Every directive with its parent (None at the top level), depth-first in source order: each directive comes
    before its children."""
    stack: list[tuple[AstDirective, AstDirective | None]] = [(d, None) for d in reversed(document.children)]
    while stack:
        directive, parent = stack.pop()
        yield directive, parent
        if directive.body is not None:
            stack.extend((child, directive) for child in reversed(directive.body))


def find_directives(document: AstDocument, name: str) -> list[AstDirective]:
    """Every directive named ``name`` at any depth, in walk_directives order."""
    return [directive for directive, _ in walk_directives(document) if directive.name == name]


# Directive anatomy (vil-g7n.1.3; the one home is ts/src/ast/anatomy.ts, ported here).

_VALUE_TOKENS = frozenset({TokenKind.WORD, TokenKind.STRING})
_VALUE_NODES = frozenset({NodeKind.SLICE, NodeKind.LIST})


def _anatomy_of(tokens: tuple[Token, ...], node: Node) -> tuple[int, list[ValueRef], Node | None]:
    """Split a directive node into (name token index, args, block). The name is ``node.start`` (a WORD). Args, in
    source order: each WORD or STRING token after the name that no child covers, and each slice or list child.
    Spaces, comments, separators, punctuation and error children are never args."""
    args: list[ValueRef] = []
    block: Node | None = None
    children = node.children
    following = 0
    i = node.start + 1
    while i < node.end:
        child = children[following] if following < len(children) else None
        if child is not None and child.start == i:
            if child.kind in _VALUE_NODES:
                args.append(child)
            elif child.kind is NodeKind.BLOCK:
                block = child
            following += 1
            i = max(child.end, i + 1)
            continue
        if tokens[i].kind in _VALUE_TOKENS:
            args.append(i)
        i += 1
    return node.start, args, block


def _directives_of(scope: Node) -> tuple[Node, ...]:
    """The directive children of a scope (the document or a block), in source order; error nodes are skipped."""
    return tuple(child for child in scope.children if child.kind is NodeKind.DIRECTIVE)


@dataclass(frozen=True, slots=True)
class _Range:
    start: int
    end: int


def _argument(document: AstDocument, ref: ValueRef) -> AstArgument:
    syntax = document.syntax
    rng = _Range(ref, ref + 1) if isinstance(ref, int) else ref
    return AstArgument(ref, text_of(syntax, rng), span_of(syntax, rng), document)
