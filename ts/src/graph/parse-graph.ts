import { findDirectives, type IAstDirective, parseDocument } from "../ast/ast.js";
import { DiagnosticCode } from "../diagnostics.js";
import type { INode } from "../syntax/cst.js";
import { ValueKind } from "../value.js";
import type { IDocumentEdge, IDocumentGraph, IDocumentNode, IGraphDiagnostic } from "./graph.js";
import { composeLoaders, type DocumentLoader, type ILoadedDocument } from "./io.js";
import { compareCodePoints } from "./order.js";

const DEFAULT_ROOT_PATH = "<root>";
const DEFAULT_MAX_INCLUDE_DEPTH = 16;

/** Options for parseGraph. */
export interface IParseGraphOptions {
  /** Identity of the root document, passed to loaders as the first parentPath. Default "<root>". */
  readonly path?: string;
  /** Required: the core does no I/O. Several loaders are combined with composeLoaders. */
  readonly loader: DocumentLoader | readonly DocumentLoader[];
  /** Deepest include nesting allowed; an include deeper than this gives E3003 and an edge with no targets. Default 16. */
  readonly maxIncludeDepth?: number;
}

/**
 * Parse a root text and resolve its includes into a document graph (port of reference parse.ts).
 *
 * An include is a directive named `include` whose first value is a string literal (vil-bgz: include paths are
 * quoted); any other first value gives E2006. Include diagnostics (E2006, E3001-E3004) carry the span of the
 * include directive and the resolvedPath of the document that contains it. A document reached twice is parsed
 * once; a cycle gives E3002 and leaves that edge's target the already-open node.
 *
 * Never rejects for anything in the texts or for a loader failure; those become diagnostics. The only rejection
 * is a TypeError when `options.loader` is missing (an async function: it rejects, it does not throw).
 */
export async function parseGraph(source: string, options: IParseGraphOptions): Promise<IDocumentGraph> {
  // A JavaScript caller can omit what the types require.
  if (!options?.loader) throw new TypeError("parseGraph options: loader is required");
  const loader = typeof options.loader === "function" ? options.loader : composeLoaders(options.loader);
  const maxDepth = options.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;

  const nodes = new Map<string, IDocumentNode>();
  const diagnostics: IGraphDiagnostic[] = [];
  /** Documents whose includes are still being resolved: reaching one again is a cycle. */
  const open = new Set<string>();

  const report = (code: DiagnosticCode, message: string, directive: IAstDirective, resolvedPath: string): void => {
    diagnostics.push({ code, message, span: directive.span, resolvedPath });
  };

  /** Parse a document, add it to the graph and resolve its includes depth-first. */
  const visit = async (text: string, resolvedPath: string, depth: number): Promise<IDocumentNode> => {
    const document = parseDocument(text);
    const includes = new Map<INode, IDocumentEdge>();
    const node: IDocumentNode = { resolvedPath, source: text, document, includes };
    nodes.set(resolvedPath, node);
    for (const diagnostic of document.syntax.diagnostics) diagnostics.push({ ...diagnostic, resolvedPath });
    open.add(resolvedPath);
    for (const directive of findDirectives(document, "include")) {
      const edge = await resolveInclude(directive, resolvedPath, depth);
      if (edge !== undefined) includes.set(directive.node, edge);
    }
    open.delete(resolvedPath);
    return node;
  };

  /** The edge of one include directive, or undefined when its first value is not a string literal (E2006). */
  const resolveInclude = async (
    directive: IAstDirective,
    parentPath: string,
    depth: number,
  ): Promise<IDocumentEdge | undefined> => {
    const spec = includeSpec(directive);
    if (spec === undefined) {
      report(DiagnosticCode.ExpectedStringLiteral, "include requires a string literal path", directive, parentPath);
      return undefined;
    }
    const failed = (code: DiagnosticCode, message: string): IDocumentEdge => {
      report(code, message, directive, parentPath);
      return { directive, spec, targets: [] };
    };
    if (depth + 1 > maxDepth) {
      return failed(DiagnosticCode.IncludeDepthExceeded, `include depth exceeded (max ${maxDepth}): ${spec}`);
    }
    let found: readonly ILoadedDocument[];
    try {
      found = await loader(spec, { parentPath, depth });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return failed(DiagnosticCode.IncludeResolverFailed, `include loader failed for "${spec}": ${reason}`);
    }
    if (found.length === 0) return failed(DiagnosticCode.IncludeNotFound, `include not found: ${spec}`);

    const targets: IDocumentNode[] = [];
    for (const loaded of [...found].sort((a, b) => compareCodePoints(a.resolvedPath, b.resolvedPath))) {
      const existing = nodes.get(loaded.resolvedPath);
      if (open.has(loaded.resolvedPath)) {
        report(DiagnosticCode.IncludeCycle, `circular include: ${loaded.resolvedPath}`, directive, parentPath);
      }
      targets.push(existing ?? (await visit(loaded.source, loaded.resolvedPath, depth + 1)));
    }
    return { directive, spec, targets };
  };

  const root = await visit(source, options.path ?? DEFAULT_ROOT_PATH, 0);
  return { root, nodes, diagnostics };
}

/** The decoded string literal an include names, or undefined when its first value is anything else. */
function includeSpec(directive: IAstDirective): string | undefined {
  const first = directive.args[0];
  // Only a token can be a string; slices and lists are nodes (and valueOf throws for some of them).
  if (first === undefined || typeof first.ref !== "number") return undefined;
  const value = first.value();
  return value.kind === ValueKind.String ? value.value : undefined;
}
