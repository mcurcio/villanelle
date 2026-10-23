/**
 * Part of the adapter (see parse.ts): error recovery for the generated parser, the error-code classifier and the
 * nesting-depth guard. Private to src/syntax/. Ported from design/experiments/v4/antlr/ts/recovery.ts.
 *
 * Recovery is per statement: the first error of a statement is reported at its real position, the rest of the
 * statement is skipped (it becomes one error node), and parsing resumes at the next statement, so later siblings
 * are kept. No token is ever conjured.
 *
 * `classifyError` and `nestingOverflow` are pure functions over token kinds, so the Python port copies them line
 * for line.
 */

import * as antlr4 from "antlr4";

import { DiagnosticCode } from "../diagnostics.js";
import VillanelleParser from "../gen/VillanelleParser.js";
import type { ITokenRange } from "./cst.js";
import { TokenKind } from "./tokens.js";

/** Blocks and lists may nest this deep; one more level is E2010 (owner, vil-bzv.3). */
export const MAX_NESTING = 100;

/** A diagnostic located by token range; parse.ts turns the range into a source span. */
export interface IRawDiagnostic {
  readonly code: DiagnosticCode;
  /** The offending token's range, or the empty range at tokens.length for the end of input. */
  readonly range: ITokenRange;
  readonly message: string;
}

/**
 * The index of the `{` or `[` that opens nesting level MAX_NESTING + 1, or undefined when the tokens never nest
 * that deep. One pass: `{` and `[` open a level, `}` and `]` close one (never below 0).
 */
export function nestingOverflow(kinds: readonly TokenKind[]): number | undefined {
  let depth = 0;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    if (kind === TokenKind.LBrace || kind === TokenKind.LBrack) {
      depth++;
      if (depth > MAX_NESTING) return i;
    } else if ((kind === TokenKind.RBrace || kind === TokenKind.RBrack) && depth > 0) {
      depth--;
    }
  }
  return undefined;
}

/**
 * The code for a syntax error at token `at` (`at === kinds.length` is the end of input), given the start of the
 * statement it belongs to (`from`) and whether that statement is inside a block. First match wins.
 */
export function classifyError(kinds: readonly TokenKind[], at: number, from: number, inBlock: boolean): DiagnosticCode {
  // Brackets open in this statement before `at` (true = a slice bracket, one that follows a WORD) and braces.
  const brackets: boolean[] = [];
  let braces = 0;
  let closesValue = false; // the token right before `at` is a `]` that closed a bracket
  for (let i = from; i < at; i++) {
    const kind = kinds[i];
    closesValue = false;
    if (kind === TokenKind.LBrack) brackets.push(i > 0 && kinds[i - 1] === TokenKind.Word);
    else if (kind === TokenKind.RBrack) closesValue = brackets.pop() !== undefined;
    else if (kind === TokenKind.LBrace) braces++;
    else if (kind === TokenKind.RBrace && braces > 0) braces--;
  }
  const t = kinds[at]; // undefined at the end of input
  const inBracket = brackets.length > 0;
  const inSlice = brackets.at(-1) === true;

  // The token before `at` on its line, skipping spaces and comments.
  let prev = at - 1;
  while (prev >= 0 && (kinds[prev] === TokenKind.Space || kinds[prev] === TokenKind.Comment)) prev--;
  const before = kinds[at - 1];

  if (t === TokenKind.BadChar || (t === TokenKind.Bom && at > 0)) return DiagnosticCode.UnexpectedCharacter;
  if (t === TokenKind.UnterminatedString) return DiagnosticCode.UnterminatedString;
  if (inSlice) return DiagnosticCode.BadSlice;
  if (t === TokenKind.RBrack || (inBracket && (t === TokenKind.RBrace || t === undefined))) {
    return DiagnosticCode.ExpectedClosingBracket;
  }
  if (t === TokenKind.LBrace && (prev < 0 || kinds[prev] === TokenKind.Newline)) return DiagnosticCode.BraceOnOwnLine;
  if (t === undefined && (inBlock || braces > 0)) return DiagnosticCode.ExpectedClosingBrace;
  if (
    (t === TokenKind.Word || t === TokenKind.String || t === TokenKind.LBrack) &&
    (before === TokenKind.Word || before === TokenKind.String || (before === TokenKind.RBrack && closesValue))
  ) {
    return DiagnosticCode.ValuesTouch;
  }
  return DiagnosticCode.UnexpectedToken;
}

const MESSAGES: Readonly<Record<DiagnosticCode, string>> = {
  E1001: "unterminated string",
  E1003: "unexpected character",
  E2001: "unexpected token",
  E2003: "expected '}' to close the block",
  E2004: "unmatched bracket",
  E2006: "expected a string literal",
  E2007: "malformed slice",
  E2008: "'{' must open on its directive's line",
  E2009: "values must be separated by a space or comment",
  E2010: `blocks and lists nest deeper than ${MAX_NESTING} levels`,
  E3001: "include not found",
  E3002: "include cycle",
  E3003: "includes nest too deep",
  E3004: "include resolver failed",
  E4001: "bound is not an integer",
};

/** The message for a code; not part of the cross-language contract. */
export function messageOf(code: DiagnosticCode): string {
  return MESSAGES[code];
}

// --- the ANTLR strategy -----------------------------------------------------------------------------------------

const P = VillanelleParser;
const EOF = -1;

/** The parts of an ANTLR rule context the strategy reads (antlr4's typings are incomplete). */
interface IContext {
  readonly ruleIndex: number;
  readonly parentCtx: IContext | null;
  readonly children: readonly IContext[] | null;
  readonly start: { readonly tokenIndex: number };
}

interface IStreamToken {
  readonly type: number;
  readonly tokenIndex: number;
  readonly text: string;
}

/** The parts of the generated parser and its runtime the strategy reads or calls. */
interface IParser {
  readonly _ctx: IContext;
  readonly _input: {
    readonly index: number;
    readonly tokens: readonly IStreamToken[];
    LA(i: number): number;
  };
  _errHandler: unknown;
  readonly _interp: { getSynValidOrSemInvalidAltThatFinishedDecisionEntryRule: () => number };
  getCurrentToken(): IStreamToken;
  consume(): void;
  match(type: number): void;
  statements(): { readonly exception: unknown };
}

/** The parts of ANTLR's DefaultErrorStrategy the strategy overrides or calls. */
interface IErrorStrategy {
  inErrorRecoveryMode(recognizer: IParser): boolean;
  beginErrorCondition(recognizer: IParser): void;
  endErrorCondition(recognizer: IParser): void;
  sync(recognizer: IParser): void;
  recoverInline(recognizer: IParser): unknown;
  reportError(recognizer: IParser, e: IRecognitionException): void;
  recover(recognizer: IParser, e: IRecognitionException): void;
}

/** ANTLR's RecognitionException (an Error). */
interface IRecognitionException extends Error {
  readonly offendingToken: IStreamToken | null;
}

/** antlr4 4.13.2 exports these at runtime, but its typings do not re-export the error classes. */
const { DefaultErrorStrategy, InputMismatchException } = antlr4 as unknown as {
  readonly DefaultErrorStrategy: new () => IErrorStrategy;
  readonly InputMismatchException: new (recognizer: IParser) => IRecognitionException;
};

const isStatements = (c: IContext | null | undefined): boolean => c?.ruleIndex === P.RULE_statements;

/** The statements context the parser is in, and whether it sits inside a block. */
function scope(p: IParser): { statements: IContext | undefined; inBlock: boolean } {
  let c: IContext | null = p._ctx;
  if (c.ruleIndex === P.RULE_block || c.ruleIndex === P.RULE_document) {
    return { statements: [...(c.children ?? [])].reverse().find(isStatements), inBlock: c.ruleIndex === P.RULE_block };
  }
  while (c !== null && !isStatements(c)) c = c.parentCtx;
  let q = c; // statements re-entered by recovery nest inside each other
  while (q !== null && isStatements(q.parentCtx)) q = q.parentCtx;
  return { statements: c ?? undefined, inBlock: q?.parentCtx?.ruleIndex === P.RULE_block };
}

/** The first token index of the statement being parsed in `statements` (or `current` before any). */
function statementStart(statements: IContext | undefined, current: number): number {
  const kids = (statements?.children ?? []).filter(
    (k) => k.ruleIndex === P.RULE_directive || k.ruleIndex === P.RULE_lastDirective,
  );
  return kids.at(-1)?.start.tokenIndex ?? current;
}

class Recovery extends DefaultErrorStrategy {
  private kinds: TokenKind[] | undefined;

  constructor(private readonly report: (diagnostic: IRawDiagnostic) => void) {
    super();
  }

  /** Errors surface at prediction or match, never in sync. */
  override sync(): void {}

  /** Never conjure or delete a token: unwind to the statement-level recovery instead. */
  override recoverInline(recognizer: IParser): never {
    throw new InputMismatchException(recognizer);
  }

  override reportError(p: IParser, e: IRecognitionException): void {
    if (this.inErrorRecoveryMode(p)) return;
    this.beginErrorCondition(p);
    const kinds = this.kindsOf(p);
    const offending = e.offendingToken ?? p.getCurrentToken();
    const at = offending.type === EOF ? kinds.length : offending.tokenIndex;
    const { statements, inBlock } = scope(p);
    const code = classifyError(kinds, at, statementStart(statements, p._input.index), inBlock);
    const range = { start: at, end: Math.min(at + 1, kinds.length) };
    const what = offending.type === EOF ? "end of input" : JSON.stringify(offending.text);
    this.report({ code, range, message: `${messageOf(code)}: ${what}` });
  }

  /**
   * Consume to the end of the bad statement: a `;` or newline outside brackets and braces, or a whole nested
   * block; stop before the `}` that closes the enclosing block, or at the end of input.
   */
  private skip(p: IParser): void {
    const { statements, inBlock } = scope(p);
    const current = p._input.index;
    const kinds = this.kindsOf(p);
    let brackets = 0;
    let braces = 0;
    for (let i = statementStart(statements, current); i < current; i++) {
      const kind = kinds[i];
      if (kind === TokenKind.LBrack) brackets++;
      else if (kind === TokenKind.RBrack) brackets = Math.max(0, brackets - 1);
      else if (kind === TokenKind.LBrace) braces++;
      else if (kind === TokenKind.RBrace && braces > 0) braces--;
    }
    for (;;) {
      const t = p._input.LA(1);
      if (t === EOF) return;
      if (t === P.RBRACE && braces === 0) {
        if (inBlock) return;
        p.consume();
        continue;
      }
      p.consume();
      if (t === P.LBRACK) brackets++;
      else if (t === P.RBRACK) brackets = Math.max(0, brackets - 1);
      else if (t === P.LBRACE) braces++;
      else if (
        (t === P.RBRACE && --braces === 0 && brackets === 0) ||
        ((t === P.NEWLINE || t === P.SEMI) && brackets === 0 && braces === 0)
      ) {
        // The statement ended: the next error gets reported.
        this.endErrorCondition(p);
        return;
      }
    }
  }

  /** statements() can return early at a bad token without throwing: report it (a no-op while recovering). */
  private junk(p: IParser): void {
    this.reportError(p, new InputMismatchException(p));
  }

  override recover(p: IParser, e: IRecognitionException): void {
    const la = (): number => p._input.LA(1);
    const rule = p._ctx.ruleIndex;
    if (isStatements(p._ctx)) {
      this.skip(p);
      // Resume in a loop, not by recursion, so a long run of bad statements cannot overflow the stack: a resumed
      // statements() that fails again returns here after its skip, and this loop resumes once more.
      if (isStatements(p._ctx.parentCtx)) return;
      let resumed = true;
      while (resumed && la() !== EOF && la() !== P.RBRACE) resumed = p.statements().exception !== null;
    } else if (rule === P.RULE_document) {
      while (la() !== EOF) {
        this.junk(p);
        this.skip(p);
        if (la() !== EOF) p.statements();
      }
    } else if (rule === P.RULE_block && la() !== EOF) {
      while (la() !== EOF && la() !== P.RBRACE) {
        this.junk(p);
        this.skip(p);
        if (la() !== EOF && la() !== P.RBRACE) p.statements();
      }
      p.match(P.RBRACE); // throws at the end of input: unwinds as an unclosed block
    } else {
      throw e; // unwind to the nearest recovery point
    }
  }

  /** Our token kinds for the parser's (filled) token stream, without EOF; computed once. */
  private kindsOf(p: IParser): TokenKind[] {
    this.kinds ??= p._input.tokens.filter((t) => t.type !== EOF).map((t) => P.symbolicNames[t.type] as TokenKind);
    return this.kinds;
  }
}

/**
 * Install per-statement recovery on a parser whose token stream is already filled. Each error is passed to
 * `report` once, in the order found.
 */
export function installRecovery(parser: VillanelleParser, report: (diagnostic: IRawDiagnostic) => void): void {
  const p = parser as unknown as IParser;
  p._errHandler = new Recovery(report);
  // Report a failed prediction where it fails, not after ANTLR's guess at an alternative that ends the rule.
  p._interp.getSynValidOrSemInvalidAltThatFinishedDecisionEntryRule = () => 0;
}
