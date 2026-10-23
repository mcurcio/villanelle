import { describe, expect, it } from "vitest";

import { type INode, NodeKind } from "../syntax/cst.js";
import { parse } from "../syntax/parse.js";
import { createAst, findDirectives, type IAstDirective, parseDocument, walkDirectives } from "./ast.js";

const names = (directives: Iterable<IAstDirective>): string[] => [...directives].map((d) => d.name);

const NESTED = `http {
  server {
    listen 80;
    location / { root /var/www; }
  }
  server { listen 443 }
}
events { worker 4 }
`;

describe("parseDocument", () => {
  it("gives top-level directives with names, ending at ; or a newline", () => {
    const doc = parseDocument("a 1;\nb 2\nc; d\n");
    expect(doc.syntax.diagnostics).toEqual([]);
    expect(names(doc.children)).toEqual(["a", "b", "c", "d"]);
    expect(doc.children.length).toBe(4);
  });

  it("parses empty input to an empty list", () => {
    const doc = parseDocument("");
    expect(doc.children.length).toBe(0);
    expect(doc.children.at(0)).toBeUndefined();
  });

  it("gives args in source order: word, string, slice, index and list refs, without spaces or comments", () => {
    const doc = parseDocument('listen 80 "a b" foo[1:2] bar[3] [1, 2]  # trailing\n');
    expect(doc.syntax.diagnostics).toEqual([]);
    const directive = doc.children.at(0) as IAstDirective;
    expect(directive.name).toBe("listen");
    expect(directive.args.map((a) => a.text)).toEqual(["80", '"a b"', "foo[1:2]", "bar[3]", "[1, 2]"]);
    const [word, string, slice, index, list] = directive.args;
    expect(word?.ref).toBe(2);
    expect(word?.value()).toMatchObject({ kind: "word", text: "80" });
    expect(string?.value()).toMatchObject({ kind: "string", value: "a b" });
    expect((slice?.ref as INode).kind).toBe(NodeKind.Slice);
    expect(slice?.value()).toMatchObject({ kind: "slice", name: "foo", start: 1, end: 2 });
    expect(index?.value()).toMatchObject({ kind: "index", name: "bar", index: 3 });
    expect((list?.ref as INode).kind).toBe(NodeKind.List);
    expect(() => list?.value()).toThrow(new Error("unsupported value kind: list"));
  });

  it("gives each argument its span and the directive its span from name to terminator", () => {
    const doc = parseDocument("x\n  key 'v';\n");
    const directive = doc.children.at(1) as IAstDirective;
    expect(directive.span).toEqual({
      start: { offset: 4, line: 1, column: 2 },
      end: { offset: 12, line: 1, column: 10 },
    });
    expect(directive.args[0]?.span).toEqual({
      start: { offset: 8, line: 1, column: 6 },
      end: { offset: 11, line: 1, column: 9 },
    });
    expect(directive.node).toBe(doc.syntax.root.children[1]);
  });

  it("gives a body for a block and undefined without one; a list arg is not a body", () => {
    const doc = parseDocument(NESTED);
    expect(doc.syntax.diagnostics).toEqual([]);
    const http = doc.children.findByName("http") as IAstDirective;
    expect(http.args).toEqual([]);
    expect(names(http.body ?? [])).toEqual(["server", "server"]);
    const server = http.body?.at(0) as IAstDirective;
    expect(names(server.body ?? [])).toEqual(["listen", "location"]);
    const location = server.body?.at(-1) as IAstDirective;
    expect(location.args.map((a) => a.text)).toEqual(["/"]);
    expect(names(location.body ?? [])).toEqual(["root"]);
    expect(location.body?.at(0)?.body).toBeUndefined();
    expect(parseDocument("a [1];").children.at(0)?.body).toBeUndefined();
  });

  it("walks depth-first, each directive before its children, with its parent", () => {
    const visits: string[] = [];
    walkDirectives(parseDocument(NESTED), (d, parent) => visits.push(`${parent?.name ?? "-"}>${d.name}`));
    expect(visits).toEqual([
      "->http",
      "http>server",
      "server>listen",
      "server>location",
      "location>root",
      "http>server",
      "server>listen",
      "->events",
      "events>worker",
    ]);
  });

  it("finds directives at any depth, in walk order", () => {
    const doc = parseDocument(NESTED);
    expect(findDirectives(doc, "listen").map((d) => d.args[0]?.text)).toEqual(["80", "443"]);
    expect(findDirectives(doc, "root")).toHaveLength(1);
    expect(findDirectives(doc, "missing")).toEqual([]);
  });

  it("supports find, filter, findByName, filterByName, at(), toArray and iteration", () => {
    const list = parseDocument("a 1; b 2; a 3; c 4;").children;
    expect(list.findByName("a")?.args[0]?.text).toBe("1");
    expect(list.findByName("z")).toBeUndefined();
    expect(list.filterByName("a").map((d) => d.args[0]?.text)).toEqual(["1", "3"]);
    expect(list.find((d) => d.args[0]?.text === "2")?.name).toBe("b");
    expect(names(list.filter((d) => d.name !== "a"))).toEqual(["b", "c"]);
    expect(list.at(-1)?.name).toBe("c");
    expect(list.at(-4)?.name).toBe("a");
    expect(list.at(-5)).toBeUndefined();
    expect(list.at(4)).toBeUndefined();
    expect(names(list.toArray())).toEqual(["a", "b", "a", "c"]);
    expect(names(list)).toEqual(["a", "b", "a", "c"]);
  });

  it("keeps one directive object per node across accesses", () => {
    const doc = parseDocument(NESTED);
    const http = doc.children.at(0);
    expect(doc.children.toArray()[0]).toBe(http);
    expect(doc.children.findByName("http")).toBe(http);
    expect(findDirectives(doc, "server")[0]).toBe(http?.body?.at(0));
    expect(findDirectives(doc, "root")[0]).toBe(findDirectives(doc, "root")[0]);
    expect(findDirectives(doc, "root")[0]?.document).toBe(doc);
  });

  it("skips error nodes, keeps the directives around them, and never throws on broken input", () => {
    const text = "a {\n b;\n : x;\n c;\n}\nd;\n";
    const doc = parseDocument(text);
    expect(doc.syntax.diagnostics.map((d) => d.code)).toEqual(["E2001"]);
    const errors = (node: INode): number =>
      node.children.reduce((n, child) => n + errors(child), node.kind === NodeKind.Error ? 1 : 0);
    expect(errors(doc.syntax.root)).toBe(1);
    const all: string[] = [];
    walkDirectives(doc, (d) => all.push(d.name));
    // The bad statement `: x;` is one error node: the block keeps `b` and `c`, and `d` follows the block.
    expect(names(doc.children)).toEqual(["a", "d"]);
    expect(names(doc.children.at(0)?.body ?? [])).toEqual(["b", "c"]);
    expect(all).toEqual(["a", "b", "c", "d"]);
    for (const broken of ["a {", '"', "}", "a [", "\u0001", 'a "b\nc;']) {
      const brokenDoc = parseDocument(broken);
      expect(brokenDoc.syntax.diagnostics.length).toBeGreaterThan(0);
      expect(() => walkDirectives(brokenDoc, (d) => d.args.map((a) => a.text))).not.toThrow();
    }
  });

  it("is createAst over parse", () => {
    const syntax = parse("a b;");
    const doc = createAst(syntax);
    expect(doc.syntax).toBe(syntax);
    expect(doc.children.at(0)?.args[0]?.value()).toMatchObject({ kind: "word", text: "b" });
  });
});
