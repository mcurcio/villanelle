/**
 * The "villanelle/node" entry: filesystem I/O edges for Node.js.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { hasGlob } from "./graph/glob.js";
import type { DocumentLoader, IDocumentWriter, ILoadedDocument } from "./graph/io.js";
import { compareCodePoints } from "./graph/order.js";

/**
 * A loader over the filesystem. Specs resolve against the directory of `context.parentPath`. A glob (* and ? in
 * the last path segment only) lists that directory and returns every matching file, sorted by compareCodePoints.
 * A missing file without a glob rejects (parseGraph reports E3004).
 */
export function createFsLoader(): DocumentLoader {
  return async (spec, context) => {
    const path = resolve(dirname(context.parentPath), spec);
    if (!hasGlob(spec)) return [{ source: await readFile(path, "utf8"), resolvedPath: path }];

    const directory = dirname(path);
    const pattern = globToRegExp(basename(path));
    const entries = await readdir(directory, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => resolve(directory, entry.name))
      .sort(compareCodePoints);
    const found: ILoadedDocument[] = [];
    for (const match of matches) found.push({ source: await readFile(match, "utf8"), resolvedPath: match });
    return found;
  };
}

/** A writer that replaces the file at resolvedPath with the text, as UTF-8. */
export function createFsWriter(): IDocumentWriter {
  return {
    async write(resolvedPath, source) {
      await writeFile(resolvedPath, source, "utf8");
    },
  };
}

/** A file-name pattern: * matches any run of characters, ? one character, everything else itself. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "su");
}
