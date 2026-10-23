import type { IAstDirective } from "../ast/ast.js";
import type { IDocumentGraph, IDocumentNode } from "./graph.js";

/**
 * Every directive of the graph in include-expanded order (port of reference iterate.ts): depth-first from the
 * root; an include directive is not yielded, its targets' directives are yielded in its place. A document
 * already being expanded is skipped, so cycles terminate.
 */
export function* iterateDirectives(graph: IDocumentGraph): Generator<IAstDirective> {
  const expanding = new Set<string>();

  function* expandNode(node: IDocumentNode): Generator<IAstDirective> {
    if (expanding.has(node.resolvedPath)) return;
    expanding.add(node.resolvedPath);
    yield* expandList(node, node.document.children);
    expanding.delete(node.resolvedPath);
  }

  function* expandList(node: IDocumentNode, list: Iterable<IAstDirective>): Generator<IAstDirective> {
    for (const directive of list) {
      if (directive.name === "include") {
        for (const target of node.includes.get(directive.node)?.targets ?? []) yield* expandNode(target);
        continue;
      }
      yield directive;
      if (directive.body !== undefined) yield* expandList(node, directive.body);
    }
  }

  yield* expandNode(graph.root);
}
