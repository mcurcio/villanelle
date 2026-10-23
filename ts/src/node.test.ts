import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DiagnosticCode } from "./diagnostics.js";
import { parseGraph } from "./graph/parse-graph.js";
import { save } from "./graph/save.js";
import { createFsLoader, createFsWriter } from "./node.js";

describe("villanelle/node", () => {
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "villanelle-node-"));
    await mkdir(join(dir, "conf.d"));
    await mkdir(join(dir, "conf.d", "sub.conf"));
    await writeFile(join(dir, "root.conf"), 'include "conf.d/*.conf";\ninclude "plain.conf";\n');
    await writeFile(join(dir, "plain.conf"), "plain 1;\n");
    for (const name of ["b.conf", "C.conf", "é.conf", "a.conf", "a.txt", "x[1].conf"]) {
      await writeFile(join(dir, "conf.d", name), "f;\n");
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves specs against the including file's directory and sorts glob matches by code point", async () => {
    const root = join(dir, "root.conf");
    const graph = await parseGraph(await readFile(root, "utf8"), { path: root, loader: createFsLoader() });
    expect(graph.diagnostics).toEqual([]);
    const [glob, plain] = graph.root.document.children.toArray().map((d) => graph.root.includes.get(d.node));
    // Files only (the sub.conf directory is skipped); the [ ] in a file name match themselves.
    expect(glob?.targets.map((t) => t.resolvedPath)).toEqual(
      ["C.conf", "a.conf", "b.conf", "x[1].conf", "é.conf"].map((name) => join(dir, "conf.d", name)),
    );
    expect(plain?.targets.map((t) => t.source)).toEqual(["plain 1;\n"]);
  });

  it("matches ? to one character", async () => {
    const found = await createFsLoader()("conf.d/?.conf", { parentPath: join(dir, "root.conf"), depth: 0 });
    expect(found.map((d) => d.resolvedPath)).toEqual(
      ["C.conf", "a.conf", "b.conf", "é.conf"].map((name) => join(dir, "conf.d", name)),
    );
  });

  it("rejects a missing plain file, which parseGraph reports as E3004", async () => {
    const loader = createFsLoader();
    await expect(loader("missing.conf", { parentPath: join(dir, "root.conf"), depth: 0 })).rejects.toThrow(/ENOENT/);
    const graph = await parseGraph('include "missing.conf";', { path: join(dir, "root.conf"), loader });
    expect(graph.diagnostics.map((d) => d.code)).toEqual([DiagnosticCode.IncludeResolverFailed]);
  });

  it("returns no documents for a glob without matches", async () => {
    const found = await createFsLoader()("conf.d/*.none", { parentPath: join(dir, "root.conf"), depth: 0 });
    expect(found).toEqual([]);
  });

  it("writes text back with the fs writer", async () => {
    const path = join(dir, "written.conf");
    await createFsWriter().write(path, "w 1;\n");
    expect(await readFile(path, "utf8")).toBe("w 1;\n");
    const graph = await parseGraph("w 1;\n", { path, loader: createFsLoader() });
    await save(graph, createFsWriter());
    expect(await readFile(path, "utf8")).toBe("w 1;\n");
  });
});
