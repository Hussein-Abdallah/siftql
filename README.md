# siftql

> A complete, extensible Lucene-like query language for JavaScript and TypeScript —
> hand-written parser, serializer, and in-memory search engine, with real
> chronological date/time support. Zero runtime dependencies.

[![CI](https://github.com/Hussein-Abdallah/siftql/actions/workflows/ci.yml/badge.svg)](https://github.com/Hussein-Abdallah/siftql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/siftql.svg)](https://www.npmjs.com/package/siftql)
[![license](https://img.shields.io/npm/l/siftql.svg)](./LICENSE)

```sh
npm install siftql
```

```ts
import { filter } from 'siftql';

filter('status:active AND created:>=2020-06-01', tasks);
```

---

## What it is

`siftql` turns a Lucene-style query string into a documented AST, evaluates it
against plain JavaScript objects, and serializes it back to a string.

It is a **query-language parser and in-memory filter engine**, not a full-text
search index. If you want relevance-ranked fuzzy search over a document corpus,
reach for [Fuse.js](https://fusejs.io), [MiniSearch](https://lucaong.github.io/minisearch/)
or [Lunr](https://lunrjs.com). If you want a person to type
`status:active AND created:>=2020-06-01` into a box and have it filter an array
correctly, this is the package.

## Two rules that explain most of the language

**1. Naming a field means you want precision.**

```
ada          contains "ada"        →  matches "Ada Lovelace"
name:ada     exactly "ada"         →  does NOT match "Ada Lovelace"
name:*ada*   contains, explicitly  →  matches "Ada Lovelace"
```

A bare word is browsing, so it matches anywhere. Naming a field is an assertion,
so it matches the whole value. This is why `status:active` never matches
`"inactive"` — a class of wrong result that substring-by-default produces
constantly.

**2. Everything ignores case unless you double the colon.**

```
status:active      ignores capitals
status::Active     respects them
```

Quotes hold a value together so it can contain spaces and reserved characters.
They say nothing about case:

```
status:"in progress"      finds "In Progress"
status::"In Progress"     finds only that exact capitalisation
```

Those two rules compose into the whole matching grid:

|             | case-insensitive  | case-sensitive     |
| ----------- | ----------------- | ------------------ |
| exactly     | `status:active`   | `status::Active`   |
| contains    | `status:*active*` | `status::*Active*` |
| starts with | `status:active*`  | `status::Active*`  |
| ends with   | `status:*active`  | `status::*Active`  |

## Syntax reference

### Terms and fields

```rb
foo                     # bare term: contains "foo", any field, ignoring case
"foo bar"               # quoted: holds spaces and reserved characters
name:foo                # field match: name is exactly "foo"
"full name":foo         # quoted field name
name.first:foo          # nested path  -> { name: { first: 'foo' } }
"name.first":foo        # a literal key containing a dot
tags.0:red              # array index
first-name:foo          # hyphens are ordinary inside a name
```

### Values

```rb
member:true             # boolean keyword
member:false
member:null             # null, and also an absent key
member:"true"           # the four-character STRING, not the keyword
height:100              # number
height:"007"            # quoted, so it stays text and keeps its zeros
```

### Comparison and ranges

```rb
height:=100             # equality (same as `:` for a fielded clause)
height:>100  height:>=100  height:<100  height:<=100

height:[100 TO 200]     # inclusive both ends
height:{100 TO 200}     # exclusive both ends
height:[100 TO 200}     # mixed — inclusivity is per boundary
height:[* TO 200]       # half-open
height:[100 TO *]
```

### Wildcards and regular expressions

```rb
name:foo*bar            # * matches any run of characters
name:*bar               # leading wildcards work
name:foo?bar            # ? matches exactly one character
name:"*is just*"        # wildcards are live inside quotes too
name:foo\*bar           # escaped: a literal asterisk
name:/^a.*z$/           # regular expression
name:/foo/i             # a regex keeps its OWN case flags; `:`/`::` never touch them
```

### Boolean structure

```rb
name:foo AND height:>=100
name:foo OR name:bar
name:foo height:>=100          # juxtaposition is an implicit AND
NOT foo        -foo            # two spellings of the same negation
name:foo AND (bio:bar OR bio:baz)
status:(active OR pending)     # field group — the field distributes
```

Precedence, loosest to tightest: `OR` < `AND` < `NOT`/`-`. All binary operators
are left-associative. `AND` and implicit AND bind identically.

### Dates

```rb
date:2020-06-01                       # bare — no quoting needed
date:>=2020-06-01T00:00:00Z           # …even with colons in it
date:<2020-06-01T12:00:00+02:00       # …even with an offset
start:14:30                           # a wall-clock time
date:[2020-01-01 TO 2020-12-31]       # temporal range
date:[2020-01-01 TO *]                # half-open temporal
```

### Escaping

A backslash protects the next character. Space, `( ) [ ] { } " ' : / ^ ~ * ?`
and a leading `-` or `+` are structural; everything else is ordinary.

```rb
status:in\ progress     # an escaped space, instead of quoting
name:foo\*bar           # a literal asterisk
a\.b:x                  # a field key that literally contains a dot
\true                   # the text "true", not the boolean
```

`isSafeUnquotedExpression(value)` tells you whether a string needs any of this.

## Real dates

This is the reason the package exists. Dates are resolved to real timestamps and
compared chronologically, so timezone offsets, mixed precision and several
storage shapes all work — and a date that does not exist is refused rather than
quietly rolled over.

```ts
filter('created:>=2020-01-01', [
  { id: 'iso', created: '2020-06-15T10:00:00Z' }, // ISO string
  { id: 'epoch', created: 1592179200000 }, // epoch milliseconds
  { id: 'date', created: new Date('2021-03-01') }, // Date object
]);
// → all three
```

```ts
// 14:00 at +02:00 IS 12:00Z — the same instant, two spellings.
test('t:2020-06-01T12:00:00Z', { t: '2020-06-01T14:00:00+02:00' }); // true
```

**No `new Date(string)` anywhere.** Native parsing rolls impossible dates over
instead of rejecting them (`new Date("2021-02-29")` is 1 March 2021), and it is
inconsistent about zones within one API — `new Date("2020-06-01")` is midnight
UTC while `new Date("2020-06-01T00:00:00")` is midnight _local_. siftql refuses
what it cannot resolve:

```ts
filter('created:>=2021-02-29', rows);
// SiftQLOperandError: datetime: "2021-02-29" is not a real date
```

Offset-less values are read as UTC, deliberately, so the same query cannot
return different rows on a London server and a Tokyo browser.

### Other layouts

```ts
createEngine({ dateFormat: 'DD-MM-YYYY' }).filter('created:>=01-06-2020', rows);
```

`DD-MM-YYYY` and `MM-DD-YYYY` are different declarations and siftql never guesses
between them. An array is tried in order. Tokens: `YYYY MM DD HH mm ss SSS`.
Two-digit years are deliberately unsupported — a century pivot is a guess.

For anything else, plug in a date library:

```ts
createEngine({
  parseDate: (value) => {
    const d = DateTime.fromFormat(String(value), 'dd-MM-yyyy', { zone: 'utc' });
    return d.isValid ? d.toMillis() : null; // null = "not mine", continue
  },
});
```

> **Watch the zone.** Luxon's `fromFormat` and Day.js without its UTC plugin
> resolve in the _host's_ zone unless told otherwise, which silently shifts every
> result. siftql takes the instant your hook returns at face value — it is the
> one place the fail-loud guarantee cannot reach.

Resolution order: `Date` objects → canonical ISO → `parseDate` → `dateFormat` →
epoch milliseconds → refuse.

## Custom value types

`datetime` is not special-cased anywhere in the engine — it is a registration
like any other. The same extension point is public, so a `semver`, `ipaddress`
or `currency` type is a first-class citizen without forking.

```ts
import { createEngine, defineValueType, claimed, DECLINED, MISS, resolved } from 'siftql';

const semver = defineValueType({
  name: 'semver',
  parseOperand: (operand) => {
    const parsed = parse(operand.kind === 'text' ? operand.text : '');
    return parsed ? claimed(parsed) : DECLINED;
  },
  coerceValue: (value) => {
    const parsed = typeof value === 'string' ? parse(value) : null;
    return parsed ? resolved(parsed) : MISS;
  },
  equals: (value, operand) => value.every((p, i) => p === operand[i]),
  ordering: { compare: (value, operand) => /* -1 | 0 | 1 */ },
});

const engine = createEngine({ types: [semver] });

engine.filter('v:>=1.2.3', releases);          // 1.2.3, 1.10.0, 2.0.0
engine.filter('v:[1.0.0 TO 1.99.99]', releases); // ranges, for free
```

Lexically `"1.10.0" < "1.2.3"`; semantically it is greater. **Ranges are
implemented once in core** on top of `compare`, so the type above never writes
range code and gets `[a TO b]`, `{a TO b}`, `[a TO *]` and every mixed form
automatically.

Registries are **per engine**. A library using siftql internally and an
application using it in the same process cannot see each other's types — and
that is what lets two engines disagree about what `01-06-2020` means:

```ts
createEngine({ dateFormat: 'DD-MM-YYYY' }); // 1 June
createEngine({ dateFormat: 'MM-DD-YYYY' }); // 6 January
```

Built-in resolution order, first non-declining type wins:

```
regex → null → boolean → wildcard → datetime → number → string
```

`string` is last because it claims every text operand. It deliberately has **no
ordering**, which is the entire mechanism behind `name:>="m"` throwing: free text
has no defensible order, so rather than inventing one the type does not support
the operators.

## API

|                                    |                                              |
| ---------------------------------- | -------------------------------------------- |
| `parse(query, options?)`           | string → AST. Throws `SiftQLSyntaxError`.    |
| `serialize(ast)`                   | AST → string.                                |
| `filter(query, items, options?)`   | the matching items, in input order.          |
| `test(query, item, options?)`      | does one item match?                         |
| `highlight(query, item, options?)` | which fields matched, and what to underline. |
| `createEngine(options?)`           | an engine with its own registry and options. |
| `isSafeUnquotedExpression(value)`  | does this string need quoting?               |

Every AST node type is exported and documented. The AST is **pure JSON** — no
`RegExp`, no `Date`, no parsed numbers — so it can be cached, hashed as a query
key, and posted to a worker.

### Options

| option             | default     | meaning                                           |
| ------------------ | ----------- | ------------------------------------------------- |
| `types`            | `[]`        | custom value types                                |
| `typeStrategy`     | `'prepend'` | `prepend` \| `append` \| `replace`                |
| `dateFormat`       | —           | declared non-ISO layout(s)                        |
| `parseDate`        | —           | pluggable date parser                             |
| `matchKeys`        | `false`     | also match object _keys_                          |
| `onValueError`     | `'skip'`    | `'skip'` \| `'throw'` for unreadable field values |
| `onRecovered`      | `'prune'`   | `'prune'` \| `'throw'` for tolerant-mode holes    |
| `tolerant`         | `false`     | best-effort parsing for search-as-you-type        |
| `regexGuard`       | `true`      | screen user regexes for catastrophic backtracking |
| `maxPatternLength` | `1000`      | longest accepted regex source                     |

### Errors: wrong query vs dirty data

These are different failures and are handled differently.

A **wrong query** always throws, and is not configurable:

```ts
filter('name:>="m"', rows); // SiftQLOperandError — string has no ordering
filter('created:>=2021-02-29', rows); // SiftQLOperandError — not a real date
```

A **dirty field value** is a policy. The default skips the row; `'throw'` is for
pipelines that must not proceed on bad data:

```ts
filter('when:>=2020-01-01', [{ when: 'n/a' }]); // []
filter('when:>=2020-01-01', [{ when: 'n/a' }], { onValueError: 'throw' }); // throws
```

A bare-keyword scan **never** errors, whatever the setting — one dirty column
must not be able to destroy a free-text search.

All errors extend `SiftQLError` and carry a machine-readable `code`;
`SiftQLSyntaxError` also carries a source span and prints a caret:

```
Expected a value immediately after the operator; a space here ends the clause.
Did you mean status:"in progress"? (at 7)
status: in progress
       ^
```

### Search-as-you-type

```ts
const engine = createEngine({ tolerant: true });

engine.filter('name:ada AND ', rows); // → the rows matching name:ada
engine.filter('name:', rows); // → everything; nothing is constrained yet
```

Incomplete clauses are pruned rather than treated as false, so the result list
does not blank out mid-keystroke. Recovered nodes are flagged in the AST, so a UI
can grey out the clause in flight. Set `onRecovered: 'throw'` where acting on a
guess is unacceptable.

### Highlighting

```ts
highlight('status:active OR status:done', row);
// [{ path: 'status', segments: ['status'], query: /^active$/giu }]
```

Only clauses that actually contributed are reported: the losing branch of an
`OR`, and everything under a satisfied `NOT`, contribute nothing. `query` is
absent when the whole value is the match (a range, a comparison, a boolean).

It plugs straight into a highlighter component, since `query` is a `RegExp`:

```tsx
<Highlighter
  searchWords={highlights.map((h) => h.query)}
  textToHighlight={value}
/>
```

## Comparison

Measured, not asserted — every row below was produced by running the same query
through all three packages (`liqe@3.8.7`, `lucene-kit@1.3.0`, `siftql@0.1.0`).

|                                           | liqe           | lucene-kit         | siftql    |
| ----------------------------------------- | -------------- | ------------------ | --------- |
| date field as an ISO string               | throws         | ✅                 | ✅        |
| date field as epoch **number**            | throws         | ✗ no match         | ✅        |
| date field as a `Date` object             | throws         | ✅                 | ✅        |
| timezone offset in the operand            | throws         | ✅                 | ✅        |
| **refuses `2021-02-29`** (not a real day) | ✅ throws      | ✗ **returns rows** | ✅ throws |
| declared `dateFormat`                     | ✗              | ✗                  | ✅        |
| pluggable `parseDate`                     | ✗              | ✗                  | ✅        |
| half-open range `[* TO 100]`              | ✗ syntax error | ✅                 | ✅        |
| mixed brackets `[1 TO 3}`                 | ✅             | ✅                 | ✅        |
| leading wildcard `*bar`                   | ✅             | ✅                 | ✅        |
| refuses to order free text                | ✅             | ✗                  | ✅        |
| custom value types                        | ✗              | ✗                  | ✅        |
| explicit case control                     | quoting        | quoting            | `::`      |
| tolerant parsing                          | ✗              | ✗                  | ✅        |
| ReDoS screening                           | ✗              | ✗                  | heuristic |
| runtime dependencies                      | 2              | 0                  | 0         |

The single sharpest difference:

```
query: created:>=2021-02-29        (a day that does not exist)

lucene-kit  → returns rows, having silently become 1 March
siftql      → SiftQLOperandError: "2021-02-29" is not a real date
```

liqe throws `TypeError: Expected a number.` for _any_ date comparison — that gap
is what prompted this package.

## Migrating from liqe

The syntax is compatible; two behaviours are not.

**1. `:` is equality, not substring.**

```
liqe    name:smith   → Smith, Smithers, SMITH
siftql  name:smith   → Smith, SMITH          (Smithers needs name:*smith*)
```

Mechanical rewrite: `f:x` → `f:*x*`, and `f:"x"` → `f::"*x*"`.

**2. Quoting no longer means case-sensitive.** It means "hold this together".
Use `::` for case.

Also worth knowing: `Surname:` (a field with no value) parses in liqe as a Tag
that matches nothing; in siftql it is a syntax error, so a `catch` around
`parse()` surfaces it instead of silently emptying a grid.

> **Queries stored as data** — saved searches, bookmarked URLs, alert rules —
> are not covered by a source codemod and will change behaviour on upgrade.
> `f:x` narrows (visible: an empty result); `f:"x"` widens (invisible). Plan a
> pass over stored query strings.

## On ReDoS screening

User-supplied regexes are screened for shapes that backtrack exponentially, and
refused with a located error and a rewrite hint.

**It is a heuristic, not a guarantee.** You cannot reliably decide whether an
arbitrary backtracking regex is safe in synchronous JavaScript: there is no
timeout, no interruption, and no way to bound the engine's work once `test()` is
running. A pattern that passes this screen can still be slow.

It catches the shape behind essentially every real report — a quantified group
that itself contains a quantifier — plus a length cap. Precision is weighted over
recall, so `(a|b)*` and `(abc)*` are allowed. Turn it off with
`regexGuard: false` where the query author is trusted.

**Wildcards are not exempt either.** They compile to `[\s\S]*` and `[\s\S]`
with no nested quantifier, but several stars separated by literals still
partition the input exponentially when the match _fails_ — every star must try
every split before the engine can conclude there is none:

```
value: 40 "a"s     name:*a*a*a*b          2.5ms
                   name:*a*a*a*a*a*b       36ms
                   name:*a*a*a*a*a*a*a*b  852ms     ~6x per star
```

Nesting is not the only route to catastrophic backtracking, and a benchmark
that only measures _matching_ patterns misses this — `*a*a*a*a*` succeeds
greedily on the first attempt and never backtracks. Treat a query box that
accepts unbounded stars from untrusted users as a denial-of-service surface.

## Development

```sh
npm run playground   # a scratch file of runnable examples — edit and re-run
npm run verify       # lint, format, typecheck, coverage, build
```

## Releasing

```sh
npm login
npm version <patch|minor|major>
npm publish          # prepublishOnly rebuilds, so dist can never be stale
```

Verify what ships first with `npm pack --dry-run` — it should be `dist/`,
`README.md`, `LICENSE` and `package.json`, nothing else.

## Acknowledgements

The query syntax is compatible with [liqe](https://github.com/gajus/liqe) by
Gajus Kuizinas, which inspired this project. siftql is an independent
implementation written from a specification rather than derived from liqe's
source, with a different architecture: a hand-written tokenizer and parser with
no parser generator, an extensible value-type registry, and a chronological
temporal engine.

## License

MIT © [Hussein Abdallah](https://github.com/Hussein-Abdallah)
