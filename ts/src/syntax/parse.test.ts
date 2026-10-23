import { describe, expect, it } from "vitest";

import { DiagnosticCode } from "../diagnostics.js";
import { NodeKind, spanOf, textOf } from "./cst.js";
import { parse } from "./parse.js";
import { TokenKind } from "./tokens.js";

describe("parse", () => {
  it("parses the tracer slice into a directive holding a slice node", () => {
    const syntax = parse("connect hyperhdr_color[144:152];");
    expect(syntax.diagnostics).toEqual([]);
    expect(syntax.tokens.map((t) => [t.kind, t.text])).toEqual([
      ["WORD", "connect"],
      ["SPACE", " "],
      ["WORD", "hyperhdr_color"],
      ["LBRACK", "["],
      ["WORD", "144"],
      ["COLON", ":"],
      ["WORD", "152"],
      ["RBRACK", "]"],
      ["SEMI", ";"],
    ]);
    expect(syntax.root).toEqual({
      kind: NodeKind.Document,
      start: 0,
      end: 9,
      children: [
        { kind: NodeKind.Directive, start: 0, end: 9, children: [{ kind: NodeKind.Slice, start: 2, end: 8, children: [] }] },
      ],
    });
  });

  it("parses the index form foo[1]", () => {
    const syntax = parse("connect foo[1];");
    expect(syntax.diagnostics).toEqual([]);
    expect(syntax.root.children[0]?.children[0]).toMatchObject({ kind: NodeKind.Slice, start: 2, end: 6 });
  });

  it("covers leading and trailing whitespace with the document node", () => {
    const syntax = parse(" \tconnect foo[1]; ");
    expect(syntax.root).toMatchObject({ start: 0, end: syntax.tokens.length });
    expect(syntax.tokens[0]?.kind).toBe(TokenKind.Space);
    expect(syntax.tokens.at(-1)?.kind).toBe(TokenKind.Space);
  });

  it("reports [:] as one located diagnostic", () => {
    const syntax = parse("connect foo[:];");
    expect(syntax.diagnostics).toHaveLength(1);
    expect(syntax.diagnostics[0]).toMatchObject({
      code: DiagnosticCode.BadSlice,
      span: { start: { offset: 13, line: 0, column: 13 }, end: { offset: 14, line: 0, column: 14 } },
    });
    expect(textOf(syntax, syntax.root)).toBe("connect foo[:];");
  });

  it("codes lexical errors by the offending token", () => {
    expect(parse("a \u0001").diagnostics.map((d) => d.code)).toEqual([DiagnosticCode.UnexpectedCharacter]);
    expect(parse('a "b').diagnostics.map((d) => d.code)).toEqual([DiagnosticCode.UnterminatedString]);
    expect(parse("a ﻿").diagnostics.map((d) => d.code)).toEqual([DiagnosticCode.UnexpectedCharacter]);
    expect(parse("﻿a").diagnostics).toEqual([]);
  });

  it("locates an unexpected end of input at the end of the text", () => {
    const syntax = parse("a {\n  b");
    expect(syntax.diagnostics[0]).toMatchObject({
      code: DiagnosticCode.ExpectedClosingBrace,
      span: { start: { offset: 7, line: 1, column: 3 }, end: { offset: 7, line: 1, column: 3 } },
    });
  });

  it("counts positions in UTF-16 code units, lines after each \\n", () => {
    const syntax = parse("a '\u{1F600}'\r\nb");
    const b = syntax.tokens.at(-1);
    expect(b?.text).toBe("b");
    expect(b?.span.start).toEqual({ offset: 8, line: 1, column: 0 });
    expect(syntax.tokens[2]?.span).toEqual({
      start: { offset: 2, line: 0, column: 2 },
      end: { offset: 6, line: 0, column: 6 },
    });
  });

  it("never throws", () => {
    for (const text of ["", "]", "{", "}}}", "a[", "a[1:2", "[[[", "\uD800", "a;;;b c d", "#"]) {
      const syntax = parse(text);
      expect(textOf(syntax, syntax.root)).toBe(text);
    }
  });
});

describe("spanOf and textOf", () => {
  const syntax = parse("a b\nc");

  it("give the span and text of a token range", () => {
    expect(textOf(syntax, { start: 1, end: 4 })).toBe(" b\n");
    expect(spanOf(syntax, { start: 2, end: 5 })).toEqual({
      start: { offset: 2, line: 0, column: 2 },
      end: { offset: 5, line: 1, column: 1 },
    });
  });

  it("give a zero-width span at a token start, or at the end of the text", () => {
    expect(spanOf(syntax, { start: 2, end: 2 })).toEqual({
      start: { offset: 2, line: 0, column: 2 },
      end: { offset: 2, line: 0, column: 2 },
    });
    const end = { offset: 5, line: 1, column: 1 };
    expect(spanOf(syntax, { start: 5, end: 5 })).toEqual({ start: end, end });
    expect(textOf(syntax, { start: 5, end: 5 })).toBe("");
    const empty = parse("");
    expect(spanOf(empty, empty.root)).toEqual({
      start: { offset: 0, line: 0, column: 0 },
      end: { offset: 0, line: 0, column: 0 },
    });
  });

  it("throw RangeError outside [0, tokens.length] or when start > end", () => {
    for (const range of [
      { start: -1, end: 0 },
      { start: 0, end: 6 },
      { start: 3, end: 2 },
    ]) {
      expect(() => spanOf(syntax, range)).toThrow(RangeError);
      expect(() => textOf(syntax, range)).toThrow(RangeError);
    }
  });
});
