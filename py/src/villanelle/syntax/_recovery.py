"""Part of the adapter (see parse.py): error recovery for the generated parser, the error-code classifier and the
nesting-depth guard. Private to villanelle.syntax. Ported from ts/src/syntax/recovery.ts (itself from
design/experiments/v4/antlr/ts/recovery.ts; the Python experiment is design/experiments/v4/antlr/py/recovery.py).

Recovery is per statement: the first error of a statement is reported at its real position, the rest of the
statement is skipped (it becomes one error node), and parsing resumes at the next statement, so later siblings are
kept. No token is ever conjured.

``classify_error`` and ``nesting_overflow`` are pure functions over token kinds, copied line for line from the
TypeScript ``classifyError`` and ``nestingOverflow``.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from antlr4 import Token as AntlrToken
from antlr4.error.Errors import InputMismatchException
from antlr4.error.ErrorStrategy import DefaultErrorStrategy

from villanelle._gen.VillanelleParser import VillanelleParser
from villanelle.diagnostics import DiagnosticCode
from villanelle.syntax.tokens import TokenKind

MAX_NESTING = 100
"""Blocks and lists may nest this deep; one more level is E2010 (owner, vil-bzv.3)."""


@dataclass(frozen=True, slots=True)
class RawDiagnostic:
    """A diagnostic located by token range [start, end); parse.py turns the range into a source span. The range is
    the offending token's, or the empty range at len(tokens) for the end of input."""

    code: DiagnosticCode
    start: int
    end: int
    message: str


def nesting_overflow(kinds: Sequence[TokenKind]) -> int | None:
    """The index of the ``{`` or ``[`` that opens nesting level MAX_NESTING + 1, or None when the tokens never nest
    that deep. One pass: ``{`` and ``[`` open a level, ``}`` and ``]`` close one (never below 0)."""
    depth = 0
    for i, kind in enumerate(kinds):
        if kind is TokenKind.LBRACE or kind is TokenKind.LBRACK:
            depth += 1
            if depth > MAX_NESTING:
                return i
        elif (kind is TokenKind.RBRACE or kind is TokenKind.RBRACK) and depth > 0:
            depth -= 1
    return None


def classify_error(kinds: Sequence[TokenKind], at: int, start: int, in_block: bool) -> DiagnosticCode:
    """The code for a syntax error at token ``at`` (``at == len(kinds)`` is the end of input), given the start of the
    statement it belongs to (``start``) and whether that statement is inside a block. First match wins."""
    # Brackets open in this statement before `at` (True = a slice bracket, one that follows a WORD) and braces.
    brackets: list[bool] = []
    braces = 0
    closes_value = False  # the token right before `at` is a `]` that closed a bracket
    for i in range(start, at):
        kind = kinds[i]
        closes_value = False
        if kind is TokenKind.LBRACK:
            brackets.append(i > 0 and kinds[i - 1] is TokenKind.WORD)
        elif kind is TokenKind.RBRACK:
            closes_value = len(brackets) > 0
            if brackets:
                brackets.pop()
        elif kind is TokenKind.LBRACE:
            braces += 1
        elif kind is TokenKind.RBRACE and braces > 0:
            braces -= 1
    t = kinds[at] if at < len(kinds) else None  # None at the end of input
    in_bracket = len(brackets) > 0
    in_slice = in_bracket and brackets[-1]

    # The token before `at` on its line, skipping spaces and comments.
    prev = at - 1
    while prev >= 0 and (kinds[prev] is TokenKind.SPACE or kinds[prev] is TokenKind.COMMENT):
        prev -= 1
    before = kinds[at - 1] if at > 0 else None

    if t is TokenKind.BAD_CHAR or (t is TokenKind.BOM and at > 0):
        return DiagnosticCode.UNEXPECTED_CHARACTER
    if t is TokenKind.UNTERMINATED_STRING:
        return DiagnosticCode.UNTERMINATED_STRING
    if in_slice:
        return DiagnosticCode.BAD_SLICE
    if t is TokenKind.RBRACK or (in_bracket and (t is TokenKind.RBRACE or t is None)):
        return DiagnosticCode.EXPECTED_CLOSING_BRACKET
    if t is TokenKind.LBRACE and (prev < 0 or kinds[prev] is TokenKind.NEWLINE):
        return DiagnosticCode.BRACE_ON_OWN_LINE
    if t is None and (in_block or braces > 0):
        return DiagnosticCode.EXPECTED_CLOSING_BRACE
    if (t is TokenKind.WORD or t is TokenKind.STRING or t is TokenKind.LBRACK) and (
        before is TokenKind.WORD or before is TokenKind.STRING or (before is TokenKind.RBRACK and closes_value)
    ):
        return DiagnosticCode.VALUES_TOUCH
    return DiagnosticCode.UNEXPECTED_TOKEN


_MESSAGES: dict[DiagnosticCode, str] = {
    DiagnosticCode.UNTERMINATED_STRING: "unterminated string",
    DiagnosticCode.UNEXPECTED_CHARACTER: "unexpected character",
    DiagnosticCode.UNEXPECTED_TOKEN: "unexpected token",
    DiagnosticCode.EXPECTED_CLOSING_BRACE: "expected '}' to close the block",
    DiagnosticCode.EXPECTED_CLOSING_BRACKET: "unmatched bracket",
    DiagnosticCode.EXPECTED_STRING_LITERAL: "expected a string literal",
    DiagnosticCode.BAD_SLICE: "malformed slice",
    DiagnosticCode.BRACE_ON_OWN_LINE: "'{' must open on its directive's line",
    DiagnosticCode.VALUES_TOUCH: "values must be separated by a space or comment",
    DiagnosticCode.NESTING_TOO_DEEP: f"blocks and lists nest deeper than {MAX_NESTING} levels",
    DiagnosticCode.INCLUDE_NOT_FOUND: "include not found",
    DiagnosticCode.INCLUDE_CYCLE: "include cycle",
    DiagnosticCode.INCLUDE_DEPTH_EXCEEDED: "includes nest too deep",
    DiagnosticCode.INCLUDE_RESOLVER_FAILED: "include resolver failed",
    DiagnosticCode.NON_INTEGER_BOUND: "bound is not an integer",
}


def message_of(code: DiagnosticCode) -> str:
    """The message for a code; not part of the cross-language contract."""
    return _MESSAGES[code]


# --- the ANTLR strategy -------------------------------------------------------------------------------------------

P = VillanelleParser
_EOF = AntlrToken.EOF


def _rule_of(c: Any) -> int | None:
    return c.getRuleIndex() if c is not None and hasattr(c, "getRuleIndex") else None


def _is_statements(c: Any) -> bool:
    return bool(_rule_of(c) == P.RULE_statements)


def _scope(p: Any) -> tuple[Any, bool]:
    """The statements context the parser is in, and whether it sits inside a block."""
    c = p._ctx
    if _rule_of(c) in (P.RULE_block, P.RULE_document):
        statements = next((k for k in reversed(c.children or []) if _is_statements(k)), None)
        return statements, _rule_of(c) == P.RULE_block
    while c is not None and not _is_statements(c):
        c = c.parentCtx
    q = c  # statements re-entered by recovery nest inside each other
    while q is not None and _is_statements(q.parentCtx):
        q = q.parentCtx
    return c, _rule_of(q.parentCtx if q is not None else None) == P.RULE_block


def _statement_start(statements: Any, current: int) -> int:
    """The first token index of the statement being parsed in ``statements`` (or ``current`` before any)."""
    kids = [
        k
        for k in ((statements.children or []) if statements is not None else [])
        if _rule_of(k) in (P.RULE_directive, P.RULE_lastDirective)
    ]
    return int(kids[-1].start.tokenIndex) if kids else current


class _Recovery(DefaultErrorStrategy):  # type: ignore[misc]
    def __init__(self, report: Callable[[RawDiagnostic], None]) -> None:
        super().__init__()
        self._report = report
        self._kinds: list[TokenKind] | None = None

    def sync(self, recognizer: Any) -> None:
        """Errors surface at prediction or match, never in sync."""

    def recoverInline(self, recognizer: Any) -> Any:
        """Never conjure or delete a token: unwind to the statement-level recovery instead."""
        raise InputMismatchException(recognizer)

    def reportError(self, recognizer: Any, e: Any) -> None:
        p = recognizer
        if self.inErrorRecoveryMode(p):
            return
        self.beginErrorCondition(p)
        kinds = self._kinds_of(p)
        offending = e.offendingToken or p.getCurrentToken()
        at = len(kinds) if offending.type == _EOF else int(offending.tokenIndex)
        statements, in_block = _scope(p)
        code = classify_error(kinds, at, _statement_start(statements, p._input.index), in_block)
        what = "end of input" if offending.type == _EOF else json.dumps(offending.text)
        self._report(RawDiagnostic(code, at, min(at + 1, len(kinds)), f"{message_of(code)}: {what}"))

    def _skip(self, p: Any) -> None:
        """Consume to the end of the bad statement: a ``;`` or newline outside brackets and braces, or a whole nested
        block; stop before the ``}`` that closes the enclosing block, or at the end of input."""
        statements, in_block = _scope(p)
        current: int = p._input.index
        kinds = self._kinds_of(p)
        brackets = 0
        braces = 0
        for i in range(_statement_start(statements, current), current):
            kind = kinds[i]
            if kind is TokenKind.LBRACK:
                brackets += 1
            elif kind is TokenKind.RBRACK:
                brackets = max(0, brackets - 1)
            elif kind is TokenKind.LBRACE:
                braces += 1
            elif kind is TokenKind.RBRACE and braces > 0:
                braces -= 1
        while True:
            t = p._input.LA(1)
            if t == _EOF:
                return
            if t == P.RBRACE and braces == 0:
                if in_block:
                    return
                p.consume()
                continue
            p.consume()
            if t == P.LBRACK:
                brackets += 1
            elif t == P.RBRACK:
                brackets = max(0, brackets - 1)
            elif t == P.LBRACE:
                braces += 1
            elif t == P.RBRACE:
                braces -= 1
            if (t == P.RBRACE and braces == 0 and brackets == 0) or (
                t in (P.NEWLINE, P.SEMI) and brackets == 0 and braces == 0
            ):
                # The statement ended: the next error gets reported.
                self.endErrorCondition(p)
                return

    def _junk(self, p: Any) -> None:
        """statements() can return early at a bad token without raising: report it (a no-op while recovering)."""
        self.reportError(p, InputMismatchException(p))

    def recover(self, recognizer: Any, e: Any) -> None:
        p = recognizer

        def la() -> int:
            return int(p._input.LA(1))

        rule = _rule_of(p._ctx)
        if _is_statements(p._ctx):
            self._skip(p)
            # Resume in a loop, not by recursion, so a long run of bad statements cannot overflow the stack: a resumed
            # statements() that fails again returns here after its skip, and this loop resumes once more.
            if _is_statements(p._ctx.parentCtx):
                return
            resumed = True
            while resumed and la() not in (_EOF, P.RBRACE):
                resumed = p.statements().exception is not None
        elif rule == P.RULE_document:
            while la() != _EOF:
                self._junk(p)
                self._skip(p)
                if la() != _EOF:
                    p.statements()
        elif rule == P.RULE_block and la() != _EOF:
            while la() not in (_EOF, P.RBRACE):
                self._junk(p)
                self._skip(p)
                if la() not in (_EOF, P.RBRACE):
                    p.statements()
            p.match(P.RBRACE)  # raises at the end of input: unwinds as an unclosed block
        else:
            raise e  # unwind to the nearest recovery point

    def _kinds_of(self, p: Any) -> list[TokenKind]:
        """Our token kinds for the parser's (filled) token stream, without EOF; computed once."""
        if self._kinds is None:
            self._kinds = [TokenKind(P.symbolicNames[t.type]) for t in p._input.tokens if t.type != _EOF]
        return self._kinds


def install_recovery(parser: VillanelleParser, report: Callable[[RawDiagnostic], None]) -> None:
    """Install per-statement recovery on a parser whose token stream is already filled. Each error is passed to
    ``report`` once, in the order found."""
    parser._errHandler = _Recovery(report)
    # Report a failed prediction where it fails, not after ANTLR's guess at an alternative that ends the rule.
    parser._interp.getSynValidOrSemInvalidAltThatFinishedDecisionEntryRule = lambda configs, outer_context: 0
