import { describe, expect, it } from "vitest";

import { createFetchLoader, createFetchWriter } from "./browser.js";
import { parseGraph } from "./graph/parse-graph.js";

/** A fetch over a map of URL to body that records every call. */
const fakeFetch = (
  pages: Record<string, string>,
): { calls: Array<[string, RequestInit | undefined]>; fetchImpl: typeof fetch } => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push([url, init]);
    const body = pages[url];
    return Promise.resolve(body === undefined ? new Response("nope", { status: 404 }) : new Response(body));
  };
  return { calls, fetchImpl };
};

describe("villanelle/browser", () => {
  it("loads specs as URLs relative to the including document", async () => {
    const { fetchImpl } = fakeFetch({
      "https://h.test/conf/a.conf": 'include "../b.conf";',
      "https://h.test/b.conf": "b 1;",
    });
    const graph = await parseGraph('include "conf/a.conf";', {
      path: "https://h.test/root.conf",
      loader: createFetchLoader(fetchImpl),
    });
    expect(graph.diagnostics).toEqual([]);
    expect([...graph.nodes.keys()]).toEqual([
      "https://h.test/root.conf",
      "https://h.test/conf/a.conf",
      "https://h.test/b.conf",
    ]);
  });

  it("returns no documents for a non-2xx response or a glob", async () => {
    const { calls, fetchImpl } = fakeFetch({});
    const loader = createFetchLoader(fetchImpl);
    const context = { parentPath: "https://h.test/root.conf", depth: 0 };
    expect(await loader("missing.conf", context)).toEqual([]);
    expect(await loader("*.conf", context)).toEqual([]);
    expect(calls.map(([url]) => url)).toEqual(["https://h.test/missing.conf"]);
  });

  it("writes with PUT text/plain by default, or the given method and content type", async () => {
    const { calls, fetchImpl } = fakeFetch({});
    await createFetchWriter(fetchImpl).write("https://h.test/a", "a;");
    await createFetchWriter(fetchImpl, { method: "POST", contentType: "text/x-conf" }).write("https://h.test/b", "b;");
    expect(calls).toEqual([
      ["https://h.test/a", { method: "PUT", headers: { "content-type": "text/plain" }, body: "a;" }],
      ["https://h.test/b", { method: "POST", headers: { "content-type": "text/x-conf" }, body: "b;" }],
    ]);
  });
});
