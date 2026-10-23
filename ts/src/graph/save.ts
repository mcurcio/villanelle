import { textOf } from "../syntax/cst.js";
import type { IDocumentGraph } from "./graph.js";
import type { IDocumentWriter } from "./io.js";

/**
 * Write back every document whose syntax text (`textOf(syntax, syntax.root)`) differs from the source it was
 * loaded from, one writer call per changed document, in `nodes` order.
 */
export async function save(graph: IDocumentGraph, writer: IDocumentWriter): Promise<void> {
  for (const node of graph.nodes.values()) {
    const { syntax } = node.document;
    const text = textOf(syntax, syntax.root);
    if (text !== node.source) await writer.write(node.resolvedPath, text);
  }
}
