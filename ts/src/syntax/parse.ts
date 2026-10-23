/**
 * The adapter: the only module that touches the ANTLR runtime and the generated parser (src/gen/, made by
 * tools/gen.sh). Everything it returns is ours: IToken, INode, IDiagnostic.
 */

import { CharStreams, CommonTokenStream } from "antlr4";

import { DiagnosticCode, type IDiagnostic } from "../diagnostics.js";
import VillanelleLexer from "../gen/VillanelleLexer.js";
import VillanelleParser from "../gen/VillanelleParser.js";
import type { ISourcePosition } from "../span.js";
import { type INode, type ISyntax, NodeKind, spanOf } from "./cst.js";
import { type IRawDiagnostic, installRecovery, messageOf, nestingOverflow } from "./recovery.js";
import { type IToken, TokenKind } from "./tokens.js";
import { type IAntlrToken, type IAntlrTree, toCst } from "./walk.js";

/** ANTLR token type -> our TokenKind, from the generated lexer's names; throws at load on a name we do not know. */
const KIND_BY_TYPE: ReadonlyMap<number, TokenKind> = (() => {
  const known = new Set<string>(Object.values(TokenKind));
  const map = new Map<number, TokenKind>();
  VillanelleLexer.symbolicNames.forEach((name, type) => {
    if (name === null) return;
    if (!known.has(name)) throw new Error(`grammar token ${name} is not a TokenKind`);
    map.set(type, name as TokenKind);
  });
  return map;
})();

/** The parts of antlr4's CommonTokenStream the adapter reads (its typings do not make it a TokenStream). */
interface IAntlrTokenStream {
  readonly tokens: readonly IAntlrToken[];
  fill(): void;
}

/** The recognizer surface the adapter uses; the lexer's and parser's inherited typings are incomplete. */
interface IAntlrRecognizer {
  removeErrorListeners(): void;
}

interface IAntlrParser extends IAntlrRecognizer {
  document(): IAntlrTree;
}

const EOF = -1;
const ORIGIN: ISourcePosition = { offset: 0, line: 0, column: 0 };

/** The position after `text`, starting at `position` (UTF-16 units; a line ends after each "\n"). */
function advance(position: ISourcePosition, text: string): ISourcePosition {
  const offset = position.offset + text.length;
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { offset, line: position.line, column: position.column + text.length };
  const newlines = text.split("\n").length - 1;
  return { offset, line: position.line + newlines, column: text.length - lastNewline - 1 };
}

/** Our tokens, with positions computed from the token texts (ANTLR's columns count code points, not UTF-16). */
function toTokens(antlrTokens: readonly IAntlrToken[]): IToken[] {
  const tokens: IToken[] = [];
  let at = ORIGIN;
  for (const token of antlrTokens) {
    if (token.type === EOF) continue;
    const kind = KIND_BY_TYPE.get(token.type);
    if (kind === undefined) throw new Error(`unknown ANTLR token type ${token.type}`);
    const end = advance(at, token.text);
    tokens.push({ kind, text: token.text, span: { start: at, end } });
    at = end;
  }
  return tokens;
}

/**
 * Parse one text. Synchronous, pure and total: it never throws for any input string, and never reads files.
 * Errors are reported in `diagnostics`; the tree still covers every token.
 */
export function parse(text: string): ISyntax {
  // antlr4's typings do not line up with the generated classes' parameter types: cast at the call.
  const input = CharStreams.fromString(text) as unknown as ConstructorParameters<typeof VillanelleLexer>[0];
  const lexer = new VillanelleLexer(input);
  // The lexer is total by construction (BAD_CHAR matches every character no other token can start with), so it
  // never reports an error; its default listener would print to the console.
  (lexer as unknown as IAntlrRecognizer).removeErrorListeners();
  const stream = new CommonTokenStream(lexer);
  const antlrStream = stream as unknown as IAntlrTokenStream;
  antlrStream.fill();
  const tokens = toTokens(antlrStream.tokens);
  const n = tokens.length;

  // The depth guard runs first: deep enough nesting would overflow the call stack of the recursive parser.
  const tooDeep = nestingOverflow(tokens.map((t) => t.kind));
  if (tooDeep !== undefined) {
    const root: INode = { kind: NodeKind.Document, start: 0, end: n, children: [{ kind: NodeKind.Error, start: 0, end: n, children: [] }] };
    const code = DiagnosticCode.NestingTooDeep;
    return located(tokens, root, [{ code, range: { start: tooDeep, end: tooDeep + 1 }, message: messageOf(code) }]);
  }

  const parser = new VillanelleParser(stream as unknown as ConstructorParameters<typeof VillanelleParser>[0]);
  const raw: IRawDiagnostic[] = [];
  // With recovery installed the parser reports nothing to listeners; drop the default console listener anyway.
  (parser as unknown as IAntlrRecognizer).removeErrorListeners();
  installRecovery(parser, (diagnostic) => raw.push(diagnostic));
  const root = toCst((parser as unknown as IAntlrParser).document());
  return located(tokens, root, raw);
}

/** The syntax result, with each token-range diagnostic turned into a source span (the one place that does). */
function located(tokens: readonly IToken[], root: INode, raw: readonly IRawDiagnostic[]): ISyntax {
  const unlocated: ISyntax = { tokens, root, diagnostics: [] };
  const diagnostics: IDiagnostic[] = raw.map((d) => ({ code: d.code, message: d.message, span: spanOf(unlocated, d.range) }));
  return { tokens, root, diagnostics };
}
