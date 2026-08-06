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

A backslash protects the next character, and is itself structural. Space,
`\ ( ) [ ] { } " ' : / ^ ~ * ? < > =` and a leading `-` or `+` are structural;
everything else is ordinary.

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
| `regexGuard`       | `true`      | refuse regexes the linear matcher cannot take, instead of running them on `RegExp` |
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

A tolerant engine also never throws for a query that is merely incomplete or
malformed. A half-typed clause is often well-formed but meaningless — `d:>=2020-`
compares against the string `"2020-"`, which has no ordering — so a clause whose
operands cannot be resolved is dropped along with the incomplete ones:

```ts
engine.filter('name:ada AND d:>=2020-', rows); // → the rows matching name:ada
```

This is the trade `tolerant: true` exists to make, and it is confined to it. A
default engine still refuses the same query, because a caller who did not ask
for leniency should hear about a broken query rather than quietly receive more
rows than they asked for:

```ts
filter('d:>=2020-', rows); // throws SiftQLOperandError
```

### Highlighting

```ts
highlight('status:active OR status:done', row);
// [{ path: 'status', segments: ['status'], ranges: [{ start: 0, end: 6 }] }]
```

Only clauses that actually contributed are reported: the losing branch of an
`OR`, and everything under a satisfied `NOT`, contribute nothing.

`ranges` is absent whenever there is no substring to point at: a range, a
comparison, a boolean, a number or date equality, `null` (including the absent
key it matches), a `matchKeys` hit on the key itself, and any value whose case
fold changes length — `name:*i*` against `İstanbul` matches, and no offset into
the original value would be meaningful. Write `hit.ranges ?? []` and all of them
fall out.

**Positions, not patterns.** `ranges` are half-open offsets into the value, and
they are what the built-in types report. That is not only about handing back a
`RegExp` a caller then has to run; it is about being able to state the answer at
all. Matching folds case with `toLowerCase`, and a `RegExp` applied by the caller
folds under its own rules, which disagree in both directions — `/s/iu` matches
`ſ`, which siftql does not, and `toLowerCase` maps the Kelvin sign `K` to `k`,
which `/k/i` refuses. Spans are computed against exactly the string the matcher
compared, so a span is reported if and only if the value really matched there.

Rendering them takes no library:

```tsx
const parts = [];
let at = 0;

for (const { start, end } of hit.ranges ?? []) {
  parts.push(value.slice(at, start), <mark>{value.slice(start, end)}</mark>);
  at = end;
}

parts.push(value.slice(at));
```

A custom value type may still report a `query` instead, and `Highlight.query` is
kept for that. A hit never carries both: the evaluator emits `ranges` and stops,
so a type defining `highlight` and `highlightSpans` reports only its spans.

## Comparison

Measured against `liqe@3.8.7` and `lucene-kit@1.3.0`. The query-behaviour rows
were produced by running the same query through all three packages; the last two
rows are API-surface and manifest facts rather than query runs.

|                                                    | liqe                       | lucene-kit           | siftql           |
| -------------------------------------------------- | -------------------------- | -------------------- | ---------------- |
| date field as an ISO **string**                    | throws                     | ✗ compared as text   | ✅ chronological |
| date field as an epoch **number**                  | throws                     | ✗ no match           | ✅               |
| date field as a `Date` **object**                  | throws                     | ✅                   | ✅               |
| timezone offset honoured                           | throws                     | `Date` fields only   | ✅ always        |
| **refuses `2021-02-29`** (not a real day)          | n/a — throws on every date | ✗ **silently 1 Mar** | ✅ throws        |
| declared `dateFormat`                              | ✗                          | ✗                    | ✅               |
| pluggable `parseDate`                              | ✗                          | ✗                    | ✅               |
| half-open range `[* TO 100]`                       | ✗ syntax error             | ✅                   | ✅               |
| refuses to order free text                         | ✅                         | ✗ `localeCompare`    | ✅               |
| value types with their own ordering (ranges free)  | ✗                          | ✗                    | ✅               |
| explicit case control                              | quoting                    | quoting              | `::`             |
| tolerant parsing (opt-in, recovered nodes flagged) | ✗                          | ✗                    | ✅               |
| `/^(a\|a)*$/` vs 40,000 non-matching characters    | >15 s (killed)             | >15 s (killed)       | **10 ms**        |
| runtime dependencies (direct / installed)          | 2 / 8                      | 0 / 0                | 0 / 0            |

The single sharpest difference:

```
query: created:>=2021-02-29        (a day that does not exist)

lucene-kit  → returns rows, having silently become 1 March
siftql      → SiftQLOperandError: datetime: "2021-02-29" is not a real date
```

liqe cannot compare dates at all: a date-only operand throws
`TypeError: Expected a number.`, and one carrying a time or an offset —
`created:>=2020-06-01T12:00:00+02:00` — fails earlier still, in its grammar.
That gap is what prompted this package.

**The regex row is a trade-off, not a free win.** The linear matcher refuses
backreferences, lookaround, and quantifiers whose body can match the empty
string (`(a*)*`) — all of which liqe and lucene-kit accept. `regexGuard: false`
runs those on `RegExp` instead.

Two rows were removed rather than kept, because a comparison that flatters is
worth less than none. `mixed brackets [1 TO 3}` behaved identically in all three.
`leading wildcard *bar` looked identical and was not: liqe's `*` is one-or-more,
so `*bar` does not match `"bar"` there, and three ticks were hiding a real
divergence. The leap-day row also credited liqe with a check it does not perform
— it throws the same error for `2021-02-29`, for `2021-13-01` and for a
perfectly valid date, because it never examines the value at all.


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

## On regular expressions

User-supplied regexes are matched by a **linear-time automaton**, not by
JavaScript's `RegExp`. Cost is `O(pattern × input)` for every pattern that
exists — no pattern makes it exponential, and there is no catastrophic
backtracking to trigger.

**That bounds the shape of the cost, not its size.** Both factors are still
controlled by whoever types the query, and linear is not free:

```
pattern of 963 chars (under the 1000 default), value of 4,000 chars:    93 ms per row
the same pattern against a 20,000-char value:                         480 ms per row
```

So a hostile query is a slow query rather than a hung process: predictable,
proportional, and tunable through `maxPatternLength` and the instruction budget —
where before it was 2ⁿ and unbounded. If your search box is open to people you do
not trust, lower `maxPatternLength`, cap the size of the fields you search, or
put the filter behind a worker you can abort. An earlier version of this section
said "there is no such thing as a query that hangs the process", which is the
kind of absolute that stops a reader from doing any of that.

That matters because `RegExp` backtracks, and backtracking is exponential.
`/^(a|a)*$/` against 27 characters blocks for seconds — the measured figure
swings by 6x between processes on one machine, so the fact to hold onto is that
it DOUBLES per added character, not any single number — and a few more characters
make it minutes. Nothing can interrupt a running regex in JavaScript. That is a
denial of service with a twelve-character payload; the automaton raises the
payload to roughly a thousand characters and makes the cost proportional.

```rb
name:/^(a|a)*$/     # 40,000-character value: 8 ms
name:/(a+)+/        # linear, like everything else
```

This is Thompson's construction with a Pike VM — the same approach `grep`, RE2,
Rust's `regex` and Go's `regexp` take. It walks the input once, holding every
state the pattern could be in at the same time, so it never enumerates the
exponentially many ways a pattern might match.

`highlight()` reports a user regex as **ranges** rather than a `RegExp`, so
nothing a consumer runs can backtrack either — see the highlight section.

**Two features are refused**, because no engine can match them in guaranteed
linear time:

```rb
name:/(a+)\1/       # backreference    -> SiftQLOperandError, code UNSAFE_PATTERN
name:/(?=x)y/       # lookahead        -> same
```

`regexGuard: false` runs those on `RegExp` instead, for callers who need them
and trust whoever writes the queries. The default is safe; the escape hatch is
explicit.

**A third is refused, and this one is a limitation rather than an
impossibility**: a quantifier whose body can match the empty string.

```rb
name:/(a*)*/        # -> refused
name:/(?:a?)+/      # -> refused
name:/(x|)*/        # -> refused
```

JavaScript fails a loop iteration that consumes nothing once the minimum is
satisfied. This matcher holds no per-thread state, so it cannot detect that, and
match POSITIONS came out short — `(?:.*?)?\w+` over `a,b,,c` reported three
matches where `RegExp` reports two. Implementing the rule was tried and reverted:
it needs state carried per path, which made a 992-character pattern cost two
seconds per kilobyte of value — reintroducing, through the fix, the exact hang
the matcher exists to remove.

Refusing is the honest answer while that is true. Only a body that can match
*nothing* is affected: `a*`, `(?:ab)*`, `(\s*,\s*)+` and `(\w+\s?)*` are all
fine, as are the catastrophic shapes this section opens with.

Everything else works: literals, character classes, `.`, `\d \w \s \b`, `\cX`,
`* + ? {n,m}` and their lazy forms, alternation, groups (including named and
non-capturing), anchors, and the `i`, `m` and `s` flags. The `u` and `v` flags
are **refused**: this matcher works on UTF-16 code units, and accepting them
while ignoring their code-point semantics would give silently different
answers. `maxPatternLength` still caps pattern size, and a pattern whose counted
repetitions expand past the instruction budget is refused rather than run.

Patterns that `RegExp` itself rejects are rejected here too — `a{2}{3}`, `^*`,
`{2}`, `(?<>x)` — so a query cannot mean one thing under `regexGuard: true` and
another under `false`.

One cost is worth stating plainly. `highlight()` on a regex walks the value once
per match, and a pattern that matches at *every* position while keeping a match
alive to the right — `(?:.*;)?` — costs O(value²) to locate. `RegExp` is
quadratic on the same patterns; this matcher's constant is larger. Rather than
run away, the walk is bounded and reports **no ranges** for such a pattern: the
field still matches, and the highlight degrades to "matched, but not where",
exactly as it does for a range or a boolean.

**Wildcards are not regexes and never were an exposure.** `name:*a*a*a*b` is
matched by a two-pointer glob: 200 stars against a 5,000-character value takes
under a millisecond.

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
