import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { INode, ISyntax } from "./syntax/cst.js";
import { textOf } from "./syntax/cst.js";
import { parse } from "./syntax/parse.js";

const CONFORMANCE = new URL("../../conformance/", import.meta.url);
const EXPECTED = new URL("expected/", CONFORMANCE);

interface ICase {
  readonly name: string;
  readonly src: string;
}

/** Every corpus file; each case's name is unique across them. */
const FILES = ["cases.json", "extra.json", "depth.json", "edge.json", "tracer.json"];

function load(file: string): ICase[] {
  return JSON.parse(readFileSync(new URL(file, CONFORMANCE), "utf8")) as ICase[];
}

type CstJson = [kind: string, start: number, end: number, children: CstJson[]];

function cstJson(node: INode): CstJson {
  return [node.kind, node.start, node.end, node.children.map(cstJson)];
}

/** conformance/format.md, format v0. */
function format(syntax: ISyntax): string {
  const value = {
    tokens: syntax.tokens.map((t) => [t.kind, t.text]),
    cst: cstJson(syntax.root),
    diagnostics: syntax.diagnostics.map((d) => [d.code, d.span.start.line, d.span.start.column]),
  };
  const json = JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${json}\n`;
}

/**
 * Each token index is either directly in one node's range and in no child, or inside exactly one child; children
 * are in order, do not overlap and lie inside their parent.
 */
function checkCoverage(node: INode): void {
  let at = node.start;
  for (const child of node.children) {
    expect(child.start, `${child.kind} child starts inside ${node.kind}`).toBeGreaterThanOrEqual(at);
    expect(child.end).toBeGreaterThanOrEqual(child.start);
    expect(child.end, `${child.kind} child ends inside ${node.kind}`).toBeLessThanOrEqual(node.end);
    if (child.kind === "error") expect(child.children).toEqual([]);
    checkCoverage(child);
    at = child.end;
  }
}

describe.each(FILES)("lossless CST over %s", (file) => {
  it.each(load(file).map((c) => [c.name, c] as const))("%s", (_name, { src }) => {
    const syntax = parse(src);
    expect(textOf(syntax, syntax.root)).toBe(src);
    expect(syntax.root).toMatchObject({ kind: "document", start: 0, end: syntax.tokens.length });
    let offset = 0;
    for (const token of syntax.tokens) {
      expect(token.text).not.toBe("");
      expect(token.span.start.offset).toBe(offset);
      expect(src.slice(offset, token.span.end.offset)).toBe(token.text);
      offset = token.span.end.offset;
    }
    expect(offset).toBe(src.length);
    checkCoverage(syntax.root);
  });
});

describe.each(FILES)("expected output (format v0) for %s", (corpus) => {
  it.each(load(corpus).map((c) => [c.name, c] as const))("%s", (name, { src }) => {
    const file = new URL(`${name}.json`, EXPECTED);
    const actual = format(parse(src));
    if (process.env.VILLANELLE_WRITE_EXPECTED === "1") {
      mkdirSync(EXPECTED, { recursive: true });
      writeFileSync(file, actual);
    }
    expect(existsSync(file), `missing ${file.pathname}`).toBe(true);
    expect(actual).toBe(readFileSync(file, "utf8"));
  });
});
