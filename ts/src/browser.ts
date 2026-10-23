/**
 * The "villanelle/browser" entry: fetch-based I/O edges.
 */

import { hasGlob } from "./graph/glob.js";
import type { DocumentLoader, IDocumentWriter } from "./graph/io.js";

/** Options for createFetchWriter. */
export interface IFetchWriterOptions {
  /** HTTP method. Default "PUT". */
  readonly method?: string;
  /** Content-Type header. Default "text/plain". */
  readonly contentType?: string;
}

/**
 * A loader over fetch. Specs resolve as URLs against `context.parentPath`. Globs are not supported (they return
 * no documents); a non-2xx response returns no documents.
 */
export function createFetchLoader(fetchImpl: typeof fetch): DocumentLoader {
  return async (spec, context) => {
    if (hasGlob(spec)) return [];
    const url = new URL(spec, context.parentPath).toString();
    const response = await fetchImpl(url);
    if (!response.ok) return [];
    return [{ source: await response.text(), resolvedPath: url }];
  };
}

/** A writer that sends the text to resolvedPath with fetch. */
export function createFetchWriter(fetchImpl: typeof fetch, options?: IFetchWriterOptions): IDocumentWriter {
  const method = options?.method ?? "PUT";
  const contentType = options?.contentType ?? "text/plain";
  return {
    async write(resolvedPath, source) {
      await fetchImpl(resolvedPath, { method, headers: { "content-type": contentType }, body: source });
    },
  };
}
