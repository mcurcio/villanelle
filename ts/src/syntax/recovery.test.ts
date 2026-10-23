import { describe, expect, it } from "vitest";

import { DiagnosticCode } from "../diagnostics.js";
import { type INode, NodeKind, textOf } from "./cst.js";
import { parse } from "./parse.js";
import { MAX_NESTING } from "./recovery.js";

/** A node as [kind, source text, children], for readable tree assertions. */
type Shape = [kind: string, text: string, children: Shape[]];

function shape(text: string): { tree: Shape; codes: [string, number, number][] } {
  const syntax = parse(text);
  const of = (node: INode): Shape => [node.kind, textOf(syntax, node), node.children.map(of)];
  return {
    tree: of(syntax.root),
    codes: syntax.diagnostics.map((d) => [d.code, d.span.start.line, d.span.start.column]),
  };
}

describe("recovery", () => {
  it("makes a bad statement inside a block one error node and keeps the block and later siblings", () => {
    const text = "server {\n  listen 80 ]\n  root /x\n}\nnext 1\n";
    expect(shape(text)).toEqual({
      tree: [
        "document",
        text,
        [
          [
            "directive",
            "server {\n  listen 80 ]\n  root /x\n}",
            [
              [
                "block",
                "{\n  listen 80 ]\n  root /x\n}",
                [
                  ["error", "listen 80 ]\n", []],
                  ["directive", "root /x\n", []],
                ],
              ],
            ],
          ],
          ["directive", "next 1\n", []],
        ],
      ],
      codes: [["E2004", 1, 12]],
    });
  });

  it("reports the first error of each bad statement at its real position, and only that one", () => {
    expect(shape('a ]\nb 1\nc "x ] ]\nd 2\n')).toEqual({
      tree: [
        "document",
        'a ]\nb 1\nc "x ] ]\nd 2\n',
        [
          ["error", "a ]\n", []],
          ["directive", "b 1\n", []],
          ["error", 'c "x ] ]\n', []],
          ["directive", "d 2\n", []],
        ],
      ],
      codes: [
        ["E2004", 0, 2],
        ["E1001", 2, 2],
      ],
    });
  });

  it("reports where the statement breaks, never conjuring or deleting a token", () => {
    // ANTLR's default inline recovery would conjure the missing '}' and report it as a different error.
    expect(shape("a {\n b 1\n").codes).toEqual([["E2003", 2, 0]]);
    expect(shape("x [a b]\ny 1\n").codes).toEqual([["E2001", 0, 5]]);
    expect(shape("x a[1 2]\ny 1\n").codes).toEqual([["E2007", 0, 5]]);
    expect(shape("x a[1:2 z]\ny 1\n").tree[2].map((n) => n[0])).toEqual(["error", "directive"]);
  });

  it("gives a stray ']' and an unclosed '[' one located E2004 each", () => {
    expect(shape("x ]\ny 1\n").codes).toEqual([["E2004", 0, 2]]);
    expect(shape("a {\n x [1\n}\n").codes).toEqual([["E2004", 2, 0]]);
    expect(shape("x [1, 2").codes).toEqual([["E2004", 0, 7]]);
  });

  it("gives a '{' that starts its line E2008, and keeps the directive before it", () => {
    const { tree, codes } = shape("a\n  # c\n  {\n b 1\n}\nc 2\n");
    expect(codes).toEqual([["E2008", 2, 2]]);
    expect(tree[2].map((n) => [n[0], n[1]])).toEqual([
      ["directive", "a\n"],
      ["error", "{\n b 1\n}"],
      ["directive", "c 2\n"],
    ]);
  });

  it("gives touching values E2009", () => {
    expect(shape('x "a""b"').codes).toEqual([["E2009", 0, 5]]);
    expect(shape('x a"b"').codes).toEqual([["E2009", 0, 3]]);
    expect(shape("x [a][b]").codes).toEqual([["E2009", 0, 5]]);
    expect(shape("x a[0:1]b").codes).toEqual([["E2009", 0, 8]]);
  });

  it("resumes after a long run of bad statements in a loop, never overflowing the stack", () => {
    const run = 5000;
    const bad = "a ]\n".repeat(run);
    for (const text of [bad, "a ];".repeat(run), `a {\n${bad}}\n`, "a ]\nb 1\n".repeat(run / 2)]) {
      const syntax = parse(text);
      expect(syntax.diagnostics.length).toBe(text.startsWith("a ]\nb") ? run / 2 : run);
      expect(textOf(syntax, syntax.root)).toBe(text);
    }
    const top = shape(bad);
    expect(top.tree[2]).toEqual(Array.from({ length: run }, () => ["error", "a ]\n", []]));
    expect(top.codes[run - 1]).toEqual(["E2004", run - 1, 2]);
    const inBlock = shape(`a {\n${bad}}\n`).tree[2][0]?.[2][0];
    expect(inBlock?.[2]).toEqual(Array.from({ length: run }, () => ["error", "a ]\n", []]));
    expect(shape("a ]\nb 1\n".repeat(run / 2)).tree[2].slice(0, 4)).toEqual([
      ["error", "a ]\n", []],
      ["directive", "b 1\n", []],
      ["error", "a ]\n", []],
      ["directive", "b 1\n", []],
    ]);
  });

  it("parses wrong-format files and bad runs at full nesting depth without throwing", () => {
    const lines = (f: (i: number) => string): string => Array.from({ length: 600 }, (_, i) => f(i)).join("");
    for (const text of [
      lines((i) => `key${i}: [value, ${i}]]\n`),
      lines((i) => `"k${i}": "v",\n`),
      `${"a {".repeat(MAX_NESTING)}${"x ]\n".repeat(200)}${"}".repeat(MAX_NESTING)}`,
    ]) {
      const syntax = parse(text);
      expect(syntax.diagnostics.length).toBeGreaterThan(0);
      expect(textOf(syntax, syntax.root)).toBe(text);
    }
    const deep = parse(`${"a {".repeat(MAX_NESTING)}${"x ]\n".repeat(200)}${"}".repeat(MAX_NESTING)}`);
    expect(deep.diagnostics.map((d) => d.code)).toEqual(Array.from({ length: 200 }, () => "E2004"));
  });
});

describe("nesting depth guard", () => {
  const blocks = (n: number): string => "a {".repeat(n) + "}".repeat(n);
  const lists = (n: number): string => `x ${"[".repeat(n)}${"]".repeat(n)}`;

  it(`parses ${MAX_NESTING} levels of blocks and lists clean`, () => {
    expect(MAX_NESTING).toBe(100);
    for (const text of [blocks(MAX_NESTING), lists(MAX_NESTING), `a {${"x [".repeat(MAX_NESTING - 1)}`]) {
      const syntax = parse(text);
      expect(syntax.diagnostics.filter((d) => d.code === DiagnosticCode.NestingTooDeep)).toEqual([]);
    }
    expect(parse(blocks(MAX_NESTING)).diagnostics).toEqual([]);
    expect(parse(lists(MAX_NESTING)).diagnostics).toEqual([]);
  });

  it("rejects one level more with one E2010 at the opener of that level and one error node over everything", () => {
    for (const [text, column] of [
      [blocks(MAX_NESTING + 1), 3 * MAX_NESTING + 2],
      [lists(MAX_NESTING + 1), 2 + MAX_NESTING],
      [`a {${"x [".repeat(MAX_NESTING)}`, 3 + 3 * (MAX_NESTING - 1) + 2],
    ] as const) {
      const syntax = parse(text);
      expect(syntax.diagnostics.map((d) => [d.code, d.span.start.column])).toEqual([["E2010", column]]);
      expect(syntax.root).toEqual({
        kind: NodeKind.Document,
        start: 0,
        end: syntax.tokens.length,
        children: [{ kind: NodeKind.Error, start: 0, end: syntax.tokens.length, children: [] }],
      });
      expect(textOf(syntax, syntax.root)).toBe(text);
    }
  });

  it("counts closers so sequential nesting never adds up, and never throws", () => {
    expect(parse(`${blocks(MAX_NESTING)}\n${blocks(MAX_NESTING)}`).diagnostics).toEqual([]);
    expect(() => parse("}".repeat(500) + blocks(MAX_NESTING))).not.toThrow();
    expect(parse("]".repeat(500) + "[".repeat(MAX_NESTING + 1)).diagnostics.map((d) => d.code)).toEqual(["E2010"]);
    expect(() => parse("{".repeat(100_000))).not.toThrow();
  });
});
