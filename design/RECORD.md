# Config grammar: design record (system layer)

The answer page holds the full discussion:
https://claude.ai/artifact/H64AiZ7yuHTkzod9WauPLf (rounds 1 and 2). This file is the short
durable record. Every choice below is current and can be revised.

## Requirements

| # | Requirement | Source |
|---|---|---|
| R1 | "I want a formal language spec, but I don't care if it's EBNF. I'm ok with some other/better spec variant" (refines 2026-10-21: "I think we need a formal EBNF that describes the language so that we can prove its sound") | owner, 2026-10-22 |
| R1b | "I'm still hopeful we can build on some existing parser generator or code generator so that we can simplify the cross-language support." | owner, 2026-10-22 |
| R2 | Sound = "Both": (a) the grammar is unambiguous, checked by a tool; (b) the parser accepts exactly the grammar's language | owner, 2026-10-21 |
| R3 | "An EBNF gives a language independent syntax. And then parsers can be written against it, and then finally language-specific idiomatic sugar APIs can be layered on top" | owner, 2026-10-21 |
| R4 | "the TS *config* is canonical. The python version of the full runtime is still more comprehensive" | owner, 2026-10-21 |
| R5 | Slices `[n:m]`, `[n:]` and `[:m]`; `[:]` is rejected with a located error | `vil-9ze.1` |
| R6 | "A is ideal if we don't sacrifice the CST. Otherwise, C." (the condition on choosing ANTLR4) | owner, 2026-10-22 |

## Owner answers

| Question | Answer | Recorded in |
|---|---|---|
| Comments, and `:` in words | B: `#` only, where a token starts. A word that starts with a digit or `-` cannot contain `:` | `vil-m8w.1` |
| Values touching | A: values are separated by a space or comment; a slice touches its word; punctuation may touch | `vil-9ze` |
| Which tool | A: ANTLR4, provided the CST is kept. The check below says it is | `vil-k2e` |
| What a slice bound may be (2026-10-23) | "Integers only (Recommended)": `valueOf` gives integer start and end; any other bound is a located error with its own code (E4001) | `vil-9ze.3` |
| Is `foo[1]` a slice form (2026-10-23) | "Yes, add it now", and "Its own kind: index (Recommended)": `valueOf` gives `{kind: 'index', name, index}` | `vil-9ze.2` |
| Depth limit and bad lines (2026-10-23) | "Yes to both (Recommended)": nesting deeper than 100 is its own error (E2010); a bad line becomes one error node and later siblings are kept | `vil-bzv.3` |
| Licence (2026-10-23) | "MIT (Recommended)" | `vil-m8w.4` |
| Real rasl configs in the corpus (2026-10-23) | "Neutral here, real ones to rasl (Recommended)" | `vil-m8w.5` |
| Generated parser code (2026-10-23) | "Don't commit the generated code, just the source": every build and test regenerates it | `vil-g7n.2` |
| Releases (2026-10-23) | "Key from semantic-release and conventional commit on every PR merge"; "GitHub Release assets only"; "Dry-run until I enable it" (the repository variable `RELEASE_ENABLED`) | `vil-g7n.3` |

## Current choices

- **The spec.**
  - [grammar/Villanelle.g4](../grammar/Villanelle.g4) is the one grammar file.
  - Whitespace, comments and newlines are ordinary grammar tokens: nothing goes on a hidden
    channel and nothing is skipped.
  - Lists and value runs are written as loops, not recursion.
  - `*` and `?` are word characters, so include globs work (`vil-trv`).
  - [grammar/villanelle.ebnf](../grammar/villanelle.ebnf) stays as the readable EBNF view and the
    reference used in testing.
- **Soundness (a)**, checked by `tools/check.sh`, which CI runs on every push:
  - `g4bison.py` translates the parser rules mechanically, and Bison must report 0 conflicts
    with `%expect 0`.
  - `g4overlap.py` proves that no two token kinds can match the same text.
  - Both checks fail on the planted grammars.
  - The translator refuses predicates, actions, lexer modes and other features that could hide
    a conflict.
- **Soundness (b):** ANTLR4 generates both the TS and the Python parser from that file. On
  14,900 inputs:
  - the TS and Python trees and diagnostics are byte-identical;
  - they match the `villanelle.ebnf` reference parser;
  - there were 0 round-trip failures.
- **The CST**, the condition in R6:
  - It is lossless: every character is in exactly one token, for valid and broken input alike.
  - Node kinds: document, directive, block, list, slice, error.
  - The parts of a slice stay separate tokens.
- **Recovery:**
  - A custom ANTLR error strategy, about 95 lines per language, meets `vil-bzv.1`.
  - The first error is reported at the real position.
  - A bad statement becomes one error node, and later siblings are kept.
- **Runtime:** the official `antlr4` 4.13.2 for TS (sync, pure JS, about 36 KB gzip in the
  browser) and `antlr4-python3-runtime` 4.13.2 for Python, both pinned to the generator
  version. The fallback is antlr4ng, if CI should not need Java.

## Design rules (design choices)

1. **One file defines the language.** Every parser and every check comes from
   `grammar/Villanelle.g4`.
2. **Every character is in exactly one token, and no two token kinds overlap.** So ANTLR's
   tie-break by rule order never decides anything.
3. **ANTLR stays behind the adapter.** Layers above see only our tokens, CST, stable codes and
   `IValue`.

## Recommended as shown (can be reopened)

- **Error codes tidied** (landed with recovery, `vil-g7n.1.2` and `vil-g7n.2.2`):
  - E2007 for a bad slice;
  - E2008 for `{` on its own line;
  - E2009 for touching values;
  - E2002 and E2005 removed.

The depth limit, the one-node bad line and `foo[1]` were recommendations here; the owner has
since answered them (see Owner answers).

## Bead outline (under `vil-g7n`; ported beads keep their old rasl numbers with the `vil-` prefix)

1. **Spec and CI checks:**
   - `grammar/Villanelle.g4`, with the parsers generated by `tools/gen.sh` on every build and
     test, never committed;
   - `g4bison.py`, `g4overlap.py` and the planted grammars;
   - the conformance corpus with alphabet-edge inputs.
2. **TS parser on ANTLR (the tracer):**
   - `connect hyperhdr_color[144:152];` goes from `grammar/Villanelle.g4` through the TS adapter
     to `valueOf`;
   - the generated parser replaces the hand-written `lexer.ts` and `parser.ts` (copies stay in
     `reference/`);
   - rasl's part, under `rasl-8st` in mcurcio/rasl: the value goes on to rasl's engine, and
     rasl deletes its `parseSliceTokens`.
3. **Recovery and stable codes** (`vil-bzv.1`), in TS.
4. **Python parser on ANTLR** (`rasl-9pn (mcurcio/rasl)`): the same corpus, replacing crossplane.
5. **Value rules and typed values** (`vil-9ze`), then the delegator and definitions
   (`vil-stq`, `vil-xlo`).

## NOT RUN

- A `tsc` type-check of the adapters.
- A real browser.
- Bison 3.x.
- Linux CI.
- Python versions other than 3.13.
- Performance on large files.
