# Conformance expected-output format, v0

The TypeScript and Python parsers must produce these files byte for byte from the same input.

## Files

- Inputs: `conformance/*.json`, each a JSON array of `{"name": ..., "src": ...}` cases. A name is unique
  across all of them. `cases.json` and `extra.json` hold the general and recovery cases, `depth.json` the long
  and deeply nested inputs, `edge.json` the alphabet-edge inputs (characters at the edges of what each token
  kind accepts), and `tracer.json` the tracer cases (vil-g7n.1.1).
- Expected output: one file per case, `conformance/expected/<name>.json`, for every case.

## Content

One JSON object with exactly these keys, in this order:

```
{"tokens":[[kind,text],...],"cst":[kind,start,end,[children...]],"diagnostics":[[code,line,column],...]}
```

- `tokens`: every token of the input in order, as `[kind, text]`. `kind` is the grammar's token name
  (`WORD`, `SPACE`, ...). There is no end-of-file token.
- `cst`: the root node, as `[kind, start, end, children]`. `kind` is a CST node kind (`document`,
  `directive`, `block`, `list`, `slice`, `error`). `start` and `end` are the token range: indices
  into `tokens`, half-open. `children` is an array of nodes in the same 4-element form.
- `diagnostics`: `[code, line, column]` per diagnostic, in the order reported. `line` and `column`
  are the 0-based start of the diagnostic's span. The column counts UTF-16 code units. The message
  is not part of the contract.

## Bytes

- No insignificant whitespace.
- Every character above U+007F is written as a lowercase `\uXXXX` escape of its UTF-16 code
  units: an astral character becomes two surrogate escapes, and a lone surrogate is escaped as
  itself. Other characters follow standard JSON escaping (`\n`, `\t`, `\"`, `\\`, `\b`, `\f`,
  `\r`, and a lowercase `\u00xx` for the remaining control characters).
- The file ends with one `"\n"`.

TypeScript: `JSON.stringify(value)`, then replace each code unit in U+0080 to U+FFFF with its
`\uXXXX` escape. Python: `json.dumps(value, ensure_ascii=True, separators=(",", ":"))`. Both
give the same bytes.
