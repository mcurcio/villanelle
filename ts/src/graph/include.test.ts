/**
 * The include graph (port of reference include.test.ts), plus the located-diagnostic, code-point order,
 * iterateDirectives and save behaviour of vil-g7n.1.4.
 */

import { describe, expect, it } from "vitest";

import { type IAstDirective, parseDocument } from "../ast/ast.js";
import { DiagnosticCode } from "../diagnostics.js";
import type { ISourceSpan } from "../span.js";
import type { IDocumentEdge, IDocumentGraph, IDocumentNode, IGraphDiagnostic } from "./graph.js";
import {
  composeLoaders,
  type DocumentLoader,
  type IDocumentWriter,
  type ILoadContext,
  type ILoadedDocument,
} from "./io.js";
import { iterateDirectives } from "./iterate.js";
import { compareCodePoints } from "./order.js";
import { parseGraph } from "./parse-graph.js";
import { save } from "./save.js";

/** A loader over an in-memory map, keyed and resolved by the spec itself. */
const filesLoader =
  (files: Record<string, string>): DocumentLoader =>
  (spec) => {
    const source = files[spec];
    return Promise.resolve(source === undefined ? [] : [{ source, resolvedPath: spec }]);
  };

/** A loader from a synchronous function. */
const syncLoader =
  (find: (spec: string, context: ILoadContext) => ILoadedDocument[]): DocumentLoader =>
  (spec, context) =>
    Promise.resolve(find(spec, context));

const first = (node: IDocumentNode): IAstDirective => node.document.children.at(0) as IAstDirective;
const edgeOf = (node: IDocumentNode, directive: IAstDirective = first(node)): IDocumentEdge | undefined =>
  node.includes.get(directive.node);
const codes = (graph: IDocumentGraph, code: DiagnosticCode): IGraphDiagnostic[] =>
  graph.diagnostics.filter((d) => d.code === code);

describe("parseGraph", () => {
  describe("basic includes", () => {
    it("rejects with a TypeError if loader is missing", async () => {
      await expect(parseGraph("listen 8080;", undefined as unknown as never)).rejects.toThrow(/loader is required/);
      await expect(parseGraph("listen 8080;", {} as never)).rejects.toThrow(TypeError);
    });

    it("resolves a single include", async () => {
      const graph = await parseGraph('include "other.conf";', {
        path: "/root/root.conf",
        loader: filesLoader({ "other.conf": "listen 8080;" }),
      });
      const edge = edgeOf(graph.root);
      expect(edge?.spec).toBe("other.conf");
      expect(edge?.directive).toBe(first(graph.root));
      expect(edge?.targets).toHaveLength(1);
      expect(edge?.targets[0]?.document.children.length).toBe(1);
      expect(graph.diagnostics).toEqual([]);
    });

    it("resolves nested includes", async () => {
      const graph = await parseGraph('include "a.conf";', {
        path: "/root/root.conf",
        loader: filesLoader({ "a.conf": 'include "b.conf";', "b.conf": "listen 8080;" }),
      });
      expect([...graph.nodes.keys()]).toEqual(["/root/root.conf", "a.conf", "b.conf"]);
    });

    it("uses <root> as the default root path and passes parentPath and depth to the loader", async () => {
      const calls: Array<[string, string, number]> = [];
      const loader = syncLoader((spec, context) => {
        calls.push([spec, context.parentPath, context.depth]);
        return spec === "a" ? [{ source: 'include "b";', resolvedPath: "A" }] : [{ source: "", resolvedPath: "B" }];
      });
      const graph = await parseGraph('include "a";', { loader });
      expect(graph.root.resolvedPath).toBe("<root>");
      expect(calls).toEqual([
        ["a", "<root>", 0],
        ["b", "A", 1],
      ]);
    });

    it("finds includes inside blocks and keys each edge by its own directive node", async () => {
      const graph = await parseGraph('include "one";\nhttp {\n  include "two";\n}\n', {
        loader: filesLoader({ one: "a 1;", two: "b 2;" }),
      });
      const http = graph.root.document.children.at(1) as IAstDirective;
      const nested = http.body?.at(0) as IAstDirective;
      expect(graph.root.includes.size).toBe(2);
      expect(edgeOf(graph.root)?.spec).toBe("one");
      expect(edgeOf(graph.root, nested)?.spec).toBe("two");
      expect(graph.root.includes.get(http.node)).toBeUndefined();
    });

    it("decodes the string literal spec", async () => {
      const graph = await parseGraph(String.raw`include "a\"b.conf";`, { loader: filesLoader({ 'a"b.conf': "x;" }) });
      expect(edgeOf(graph.root)?.spec).toBe('a"b.conf');
      expect(edgeOf(graph.root)?.targets).toHaveLength(1);
    });
  });

  describe("glob support", () => {
    it("resolves multiple files from a glob", async () => {
      const loader = syncLoader((spec) =>
        spec === "*.conf"
          ? [
              { source: "a 1;", resolvedPath: "a.conf" },
              { source: "b 2;", resolvedPath: "b.conf" },
              { source: "c 3;", resolvedPath: "c.conf" },
            ]
          : [],
      );
      const graph = await parseGraph('include "*.conf";', { path: "/root/root.conf", loader });
      expect(edgeOf(graph.root)?.targets).toHaveLength(3);
    });

    it("sorts glob matches by resolved path", async () => {
      const loader = syncLoader(() => [
        { source: "c 3;", resolvedPath: "c.conf" },
        { source: "a 1;", resolvedPath: "a.conf" },
        { source: "b 2;", resolvedPath: "b.conf" },
      ]);
      const graph = await parseGraph('include "*.conf";', { path: "/root/root.conf", loader });
      expect(edgeOf(graph.root)?.targets.map((t) => t.resolvedPath)).toEqual(["a.conf", "b.conf", "c.conf"]);
    });

    it("sorts matches by code point: upper case before lower, accents after ASCII, BMP before astral", async () => {
      // Code-point order. localeCompare would put "a" before "B" and "é" next to "e"; UTF-16 `<` would put the
      // astral "😀" (surrogates 0xD83D...) before "～" (U+FF5E).
      const expected = ["B.conf", "Z.conf", "a.conf", "e.conf", "z.conf", "é.conf", "～.conf", "😀.conf"];
      const shuffled = ["z.conf", "😀.conf", "é.conf", "a.conf", "～.conf", "Z.conf", "e.conf", "B.conf"];
      const loader = syncLoader(() => shuffled.map((resolvedPath) => ({ source: "", resolvedPath })));
      const graph = await parseGraph('include "*.conf";', { loader });
      expect(edgeOf(graph.root)?.targets.map((t) => t.resolvedPath)).toEqual(expected);
    });

    it("errors on no glob matches", async () => {
      const graph = await parseGraph('include "*.conf";', { path: "/root/root.conf", loader: syncLoader(() => []) });
      expect(codes(graph, DiagnosticCode.IncludeNotFound)).toHaveLength(1);
      expect(edgeOf(graph.root)?.targets).toEqual([]);
    });
  });

  describe("cycle detection", () => {
    it("detects a direct cycle and targets the open node", async () => {
      const graph = await parseGraph('include "self.conf";', {
        path: "root.conf",
        loader: filesLoader({ "self.conf": 'include "self.conf";' }),
      });
      expect(codes(graph, DiagnosticCode.IncludeCycle)).toHaveLength(1);
      const self = graph.nodes.get("self.conf") as IDocumentNode;
      expect(edgeOf(self)?.targets).toEqual([self]);
    }, 2000);

    it("detects an indirect cycle", async () => {
      const graph = await parseGraph('include "a.conf";', {
        path: "root.conf",
        loader: filesLoader({ "a.conf": 'include "b.conf";', "b.conf": 'include "a.conf";' }),
      });
      expect(codes(graph, DiagnosticCode.IncludeCycle)).toHaveLength(1);
      expect(graph.nodes.size).toBe(3);
    }, 2000);
  });

  describe("depth limiting", () => {
    it("enforces the max include depth without adding stand-in documents", async () => {
      const loader = syncLoader((spec) => {
        const level = Number.parseInt(spec.replace("level", ""), 10);
        return [{ source: `include "level${level + 1}";`, resolvedPath: spec }];
      });
      const graph = await parseGraph('include "level0";', { path: "root.conf", loader, maxIncludeDepth: 3 });
      expect(codes(graph, DiagnosticCode.IncludeDepthExceeded)).toHaveLength(1);
      // root (0), level0 (1), level1 (2), level2 (3); level2's include would sit at depth 4.
      expect([...graph.nodes.keys()]).toEqual(["root.conf", "level0", "level1", "level2"]);
      expect(edgeOf(graph.nodes.get("level2") as IDocumentNode)?.targets).toEqual([]);
    });

    it("defaults to a maximum of 16", async () => {
      const loader = syncLoader((spec) => {
        const level = Number.parseInt(spec, 10);
        return [{ source: `include "${level + 1}";`, resolvedPath: spec }];
      });
      const graph = await parseGraph('include "1";', { loader });
      expect(graph.nodes.size).toBe(17);
      expect(codes(graph, DiagnosticCode.IncludeDepthExceeded)).toHaveLength(1);
    });
  });

  describe("error handling", () => {
    it("handles resolver failures", async () => {
      const graph = await parseGraph('include "remote.conf";', {
        path: "/root/root.conf",
        loader: () => Promise.reject(new Error("Network error")),
      });
      const failures = codes(graph, DiagnosticCode.IncludeResolverFailed);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toContain("Network error");
      expect(edgeOf(graph.root)?.targets).toEqual([]);
    });

    it("requires a string literal for the include path", async () => {
      for (const source of ["include some_var;", "include;", "include a[1:2];", "include [a, b];"]) {
        const graph = await parseGraph(source, { loader: syncLoader(() => []) });
        expect(codes(graph, DiagnosticCode.ExpectedStringLiteral), source).toHaveLength(1);
        expect(graph.root.includes.size, source).toBe(0);
      }
    });
  });

  describe("located diagnostics", () => {
    it("gives include diagnostics the include's span and the including document's resolvedPath", async () => {
      const files: Record<string, string> = {
        "a.conf": 'x 1;\n  include "missing";\n',
        "b.conf": 'include "a.conf";',
        "c.conf": "include bare;",
        "deep.conf": 'include "deeper";',
      };
      const loader: DocumentLoader = (spec, context) => {
        if (spec === "boom") return Promise.reject(new Error("boom"));
        if (spec === "deeper") return Promise.resolve([{ source: "", resolvedPath: "deeper" }]);
        return filesLoader(files)(spec, context);
      };
      const graph = await parseGraph('include "a.conf";\ninclude "boom";\ninclude "c.conf";\n', {
        path: "root",
        loader: composeLoaders([loader]),
      });
      const a = graph.nodes.get("a.conf") as IDocumentNode;
      const pick = (code: DiagnosticCode): Array<{ path: string; span: ISourceSpan }> =>
        codes(graph, code).map((d) => ({ path: d.resolvedPath, span: d.span }));
      expect(pick(DiagnosticCode.IncludeNotFound)).toEqual([
        { path: "a.conf", span: (a.document.children.at(1) as IAstDirective).span },
      ]);
      expect(pick(DiagnosticCode.IncludeResolverFailed)).toEqual([
        { path: "root", span: (graph.root.document.children.at(1) as IAstDirective).span },
      ]);
      expect(pick(DiagnosticCode.ExpectedStringLiteral)).toEqual([
        { path: "c.conf", span: first(graph.nodes.get("c.conf") as IDocumentNode).span },
      ]);
      // The not-found include sits on line 1, column 2 of a.conf.
      expect(codes(graph, DiagnosticCode.IncludeNotFound)[0]?.span.start).toEqual({ offset: 7, line: 1, column: 2 });

      const cyclic = await parseGraph('include "b.conf";', { path: "a.conf", loader: filesLoader(files) });
      const b = cyclic.nodes.get("b.conf") as IDocumentNode;
      expect(
        codes(cyclic, DiagnosticCode.IncludeCycle).map((d) => ({ path: d.resolvedPath, span: d.span })),
      ).toEqual([{ path: "b.conf", span: first(b).span }]);

      const deep = await parseGraph('include "deep.conf";', { path: "r", loader, maxIncludeDepth: 1 });
      const deepNode = deep.nodes.get("deep.conf") as IDocumentNode;
      expect(
        codes(deep, DiagnosticCode.IncludeDepthExceeded).map((d) => ({ path: d.resolvedPath, span: d.span })),
      ).toEqual([{ path: "deep.conf", span: first(deepNode).span }]);
    });

    it("adds each document's syntax diagnostics with its resolvedPath, in the order found", async () => {
      const graph = await parseGraph('a "open\ninclude "x";\n', {
        path: "root",
        loader: filesLoader({ x: "b {\n" }),
      });
      expect(graph.diagnostics.map((d) => [d.code, d.resolvedPath])).toEqual([
        [DiagnosticCode.UnterminatedString, "root"],
        [DiagnosticCode.ExpectedClosingBrace, "x"],
      ]);
    });
  });

  describe("document graph", () => {
    it("parses a shared document once", async () => {
      let loads = 0;
      const files = filesLoader({
        "shared.conf": "shared_setting 1;",
        "a.conf": 'include "shared.conf"; a_setting 2;',
        "b.conf": 'include "shared.conf"; b_setting 3;',
      });
      const loader: DocumentLoader = (spec, context) => {
        loads++;
        return files(spec, context);
      };
      const graph = await parseGraph('include "a.conf"; include "b.conf";', { path: "root.conf", loader });
      expect(graph.nodes.size).toBe(4);
      const shared = graph.nodes.get("shared.conf");
      const a = graph.nodes.get("a.conf") as IDocumentNode;
      const b = graph.nodes.get("b.conf") as IDocumentNode;
      expect(edgeOf(a)?.targets[0]).toBe(shared);
      expect(edgeOf(b)?.targets[0]).toBe(shared);
      expect(loads).toBe(4);
      expect(codes(graph, DiagnosticCode.IncludeCycle)).toEqual([]);
    });

    it("preserves include order in edges", async () => {
      const loader = syncLoader((spec) => [{ source: `from_${spec};`, resolvedPath: spec }]);
      const graph = await parseGraph('include "first.conf"; include "second.conf";', { path: "root.conf", loader });
      const [one, two] = graph.root.document.children.toArray();
      expect(edgeOf(graph.root, one)?.spec).toBe("first.conf");
      expect(edgeOf(graph.root, two)?.spec).toBe("second.conf");
    });
  });
});

describe("compareCodePoints", () => {
  it("orders by Unicode code point, prefixes first", () => {
    const words = ["b", "", "ab", "a", "😀", "～", "\u{10000}", "￿", "A", "é"];
    expect([...words].sort(compareCodePoints)).toEqual(["", "A", "a", "ab", "b", "é", "～", "￿", "\u{10000}", "😀"]);
    expect(compareCodePoints("same", "same")).toBe(0);
    expect(Math.sign(compareCodePoints("a😀", "a～"))).toBe(1);
  });
});

describe("composeLoaders", () => {
  const fixed =
    (resolvedPaths: string[], tag: string): DocumentLoader =>
    () =>
      Promise.resolve(resolvedPaths.map((resolvedPath) => ({ source: tag, resolvedPath })));

  it("takes the first non-empty result for a plain spec", async () => {
    const loader = composeLoaders([fixed([], "none"), fixed(["x"], "one"), fixed(["y"], "two")]);
    expect(await loader("x.conf", { parentPath: "p", depth: 0 })).toEqual([{ source: "one", resolvedPath: "x" }]);
    expect(await composeLoaders([fixed([], "none")])("x", { parentPath: "p", depth: 0 })).toEqual([]);
  });

  it("merges every loader's result for a glob, the last one for a resolvedPath winning", async () => {
    const loader = composeLoaders([fixed(["x", "y"], "one"), fixed(["y", "z"], "two")]);
    expect(await loader("*.conf", { parentPath: "p", depth: 0 })).toEqual([
      { source: "one", resolvedPath: "x" },
      { source: "two", resolvedPath: "y" },
      { source: "two", resolvedPath: "z" },
    ]);
  });

  it("is used by parseGraph for an array of loaders", async () => {
    const graph = await parseGraph('include "x";', { loader: [fixed([], "none"), fixed(["x"], "y;")] });
    expect(edgeOf(graph.root)?.targets[0]?.source).toBe("y;");
  });
});

describe("iterateDirectives", () => {
  it("yields directives depth-first with each include replaced by its targets' directives", async () => {
    const graph = await parseGraph('a;\nhttp {\n  include "*.conf";\n  b;\n}\ninclude "c";\nz;\n', {
      loader: syncLoader((spec) =>
        spec === "c"
          ? [{ source: "c1 { c2; }", resolvedPath: "c" }]
          : [
              { source: 'y1; include "c";', resolvedPath: "y" },
              { source: "x1;", resolvedPath: "x" },
            ],
      ),
    });
    expect([...iterateDirectives(graph)].map((d) => d.name)).toEqual([
      "a",
      "http",
      "x1",
      "y1",
      "c1",
      "c2",
      "b",
      "c1",
      "c2",
      "z",
    ]);
  });

  it("terminates on cycles and skips unresolved includes", async () => {
    const graph = await parseGraph('r; include "self"; include bare; include "gone";', {
      path: "root",
      loader: filesLoader({ root: "unused;", self: 's; include "root"; include "self";' }),
    });
    expect(codes(graph, DiagnosticCode.IncludeCycle)).toHaveLength(2);
    expect([...iterateDirectives(graph)].map((d) => d.name)).toEqual(["r", "s"]);
  });
});

describe("save", () => {
  const recorder = (): IDocumentWriter & { writes: Array<[string, string]> } => {
    const writes: Array<[string, string]> = [];
    return {
      writes,
      write(resolvedPath, source) {
        writes.push([resolvedPath, source]);
        return Promise.resolve();
      },
    };
  };

  it("writes nothing for an unchanged graph", async () => {
    const graph = await parseGraph('a;\ninclude "x";', { loader: filesLoader({ x: "b  1 ;\n" }) });
    const writer = recorder();
    await save(graph, writer);
    expect(writer.writes).toEqual([]);
  });

  it("writes each document whose syntax text differs from its source, in nodes order", async () => {
    const node = (resolvedPath: string, source: string, text: string): IDocumentNode => ({
      resolvedPath,
      source,
      document: parseDocument(text),
      includes: new Map(),
    });
    const root = node("r", "old;", "new;");
    const graph: IDocumentGraph = {
      root,
      nodes: new Map([
        ["r", root],
        ["same", node("same", "s;", "s;")],
        ["t", node("t", "", "t 1;")],
      ]),
      diagnostics: [],
    };
    const writer = recorder();
    await save(graph, writer);
    expect(writer.writes).toEqual([
      ["r", "new;"],
      ["t", "t 1;"],
    ]);
  });
});
