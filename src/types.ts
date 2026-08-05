/**
 * siftql — PUBLIC AST CONTRACT (v0.1.0).
 *
 * Every exported name here is semver-major surface. Four invariants govern it,
 * and each one is testable rather than aspirational.
 *
 * I1. STRUCTURAL COMPLETENESS. Every leaf carries enough typed fields for
 *     `serialize()` to reconstruct its text without consulting the source
 *     string. There is deliberately no `raw` slice on any node: `raw` is
 *     redundant with the structured fields, desyncs silently under AST
 *     transforms, and is unauthorable for hand-built nodes. If a leaf cannot be
 *     printed from its fields, the fields are wrong — that is a bug in this
 *     file, not something `raw` is allowed to paper over.
 *
 * I2. PURE JSON. No `RegExp`, no `Date`, no functions, no numbers parsed from
 *     text. `structuredClone`, `JSON.stringify` and `deepStrictEqual` all
 *     behave, so ASTs can be cached, hashed as query keys, and sent across a
 *     worker boundary.
 *
 * I3. NO PUBLISHED UNION EVER GROWS. When a later feature is semantically
 *     adjacent to an existing union member, it lands as a sibling optional slot
 *     rather than a new member, because adding a member breaks every exhaustive
 *     `switch` a consumer has written. This is why `+term` (required) is a
 *     modifier slot and not a third `UnaryOperator.operator`, and why
 *     `RecoveryInfo.reason` is a plain `string`.
 *
 * I4. ROUND-TRIP LAW.
 *       deepEqualIgnoring('location', parse(serialize(parse(q))), parse(q))
 *     for every `q` the parser accepts. `serialize()` normalises exactly three
 *     things and nothing else: whitespace runs, redundant escapes, and the
 *     bracket on an unbounded range end. Each provably carries no AST-visible
 *     information.
 */

/* ------------------------------------------------------------------------- *
 * 1. Foundations
 * ------------------------------------------------------------------------- */

/** A half-open character range into the original query string. */
export interface SourceLocation {
  /** Index of the first character, inclusive. */
  readonly start: number;
  /** Index one past the last character, exclusive. */
  readonly end: number;
}

/** A `readonly T[]` that is non-empty at the type level. */
export type NonEmptyArray<T> = readonly [T, ...T[]];

/** Zero-width location used by programmatically built nodes. */
export const SYNTHETIC_LOCATION: SourceLocation = Object.freeze({
  start: 0,
  end: 0,
});

/**
 * Why a node was invented or patched up by `parse(q, { tolerant: true })`.
 *
 * `reason` is a plain `string`, not a closed union, precisely so that new
 * recovery situations never widen a published union (I3). The reasons v0.1
 * emits are enumerated in {@link RECOVERY_REASONS}.
 */
export interface RecoveryInfo {
  readonly reason: string;
  /**
   * True when the node has no source text at all and was invented to keep the
   * tree well-formed; its `location` is then zero-width at the recovery point.
   */
  readonly synthetic: boolean;
}

/** The recovery reasons the v0.1 parser produces. Deliberately not a closed set. */
export const RECOVERY_REASONS = Object.freeze({
  unterminatedQuote: 'unterminated-quote',
  unterminatedRegex: 'unterminated-regex',
  unclosedGroup: 'unclosed-group',
  unclosedRange: 'unclosed-range',
  missingValue: 'missing-value',
  missingOperand: 'missing-operand',
});

/**
 * Every node carries a location. `recovered` appears only on nodes produced by
 * tolerant recovery, which is what lets a search-as-you-type UI grey out the
 * clause being typed and lets `compile()` prune or refuse a guess instead of
 * acting on it.
 */
export interface NodeBase {
  readonly location: SourceLocation;
  readonly recovered?: RecoveryInfo;
}

/* ------------------------------------------------------------------------- *
 * 2. Lexical primitives
 * ------------------------------------------------------------------------- */

/** The two quote characters the grammar accepts. */
export type QuoteChar = '"' | "'";

/**
 * Regex flags the parser accepts, validated at parse time. An order-preserving
 * array rather than a `string` (so `/x/QQ` is unconstructible) and rather than a
 * `Set` or a live `RegExp` (so `/x/gi` never prints back as `/x/ig`, and I2
 * holds).
 */
export type RegexFlag = 'd' | 'g' | 'i' | 'm' | 's' | 'u' | 'v' | 'y';

/** Words that can never be a bare term: they are grammar keywords. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'AND',
  'OR',
  'NOT',
  'TO',
]);

/**
 * Characters a bare term must escape with a backslash when serialized.
 *
 * `*` and `?` are here because unescaped they are wildcard metacharacters —
 * which is exactly why a wildcard pattern is its own node
 * ({@link WildcardExpression}) rather than a string plus an escape-index side
 * table. With wildcards segmented, canonical escaping is a total function and
 * the circularity ("escaping `*` would make wildcards unserializable")
 * disappears.
 */
export const RESERVED_CHARACTERS: ReadonlySet<string> = new Set([
  // Every character below is ASCII punctuation or whitespace, so there is no
  // grapheme cluster, surrogate pair or combining mark for the spread to split.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  ...' \t\n\r\f\v():"\'\\/[]{}<>=^~*?',
]);

/**
 * True when `value` can be written as a bare term with no escaping at all.
 *
 * False for the empty string, the reserved words, anything containing a reserved
 * character, and a LEADING `-`/`+` (negation, and the reserved v0.2 required
 * marker). Note only a *leading* `-` is structural, which is what lets bare
 * dates such as `2020-06-01` go unquoted.
 */
export const isSafeUnquotedExpression = (value: string): boolean => {
  if (value.length === 0) {
    return false;
  }

  if (RESERVED_WORDS.has(value)) {
    return false;
  }

  if (value.startsWith('-') || value.startsWith('+')) {
    return false;
  }

  for (const character of value) {
    if (RESERVED_CHARACTERS.has(character)) {
      return false;
    }
  }

  return true;
};

/* ------------------------------------------------------------------------- *
 * 3. Reserved v0.2 modifiers
 *
 * Declared now, never emitted by the v0.1 parser (which rejects the syntax with
 * `SiftQLSyntaxError { code: 'UNSUPPORTED_SYNTAX' }`), and printed by the v0.1
 * serializer so a hand-built forward-compatible query round-trips.
 *
 * ATTACHMENT IS STRUCTURAL, not conventional:
 *   boost / required — every node that can stand as a CLAUSE
 *   fuzzy           — bare terms only (`foo~2`)
 *   proximity       — quoted phrases only (`"a b"~5`)
 * So `member:true~5`, `height:[1 TO 2]~2` and a bare term with slop are
 * unrepresentable rather than merely unproduced.
 *
 * Factors are LEXICAL strings for the same reason numbers are (see §4): `^2.0`
 * must not print back as `^2`.
 * ------------------------------------------------------------------------- */

export interface BoostModifier extends NodeBase {
  readonly type: 'BoostModifier';
  /** Lexical factor: `'2'`, `'2.0'`, `'0.5'`. */
  readonly factor: string;
}

export interface FuzzyModifier extends NodeBase {
  readonly type: 'FuzzyModifier';
  /** Lexical edit distance, or `null` for a bare `~`. */
  readonly distance: string | null;
}

export interface ProximityModifier extends NodeBase {
  readonly type: 'ProximityModifier';
  /** Lexical slop: `'5'` in `"a b"~5`. */
  readonly slop: string;
}

/**
 * `+term`. Carries no value field, because there is exactly one thing it can
 * mean.
 *
 * Prohibition is deliberately NOT modelled here: `-term` and `NOT term` are, and
 * will remain, {@link UnaryOperator}. Publishing a `'must_not'` value that no
 * version can emit would guarantee a future silent AST-shape change — the kind
 * that breaks consumers at runtime with no compile error. One mechanism per
 * concept.
 */
export interface RequiredModifier extends NodeBase {
  readonly type: 'RequiredModifier';
}

export interface Boostable {
  readonly boost?: BoostModifier;
}

export interface Requirable {
  readonly required?: RequiredModifier;
}

export interface Fuzzable {
  readonly fuzzy?: FuzzyModifier;
}

export interface Proximate {
  readonly proximity?: ProximityModifier;
}

/**
 * Mixed into every node that can stand as a clause. A modifier binds to the
 * smallest enclosing clause: in `name:foo^2` the clause is the Tag, in a bare
 * `foo^2` the clause is the literal itself.
 */
export interface ClauseModifiers extends Boostable, Requirable {}

/* ------------------------------------------------------------------------- *
 * 4. Literals
 *
 * DELIBERATE ABSENCE: there is no NumberLiteral and no DateLiteral. `height:100`
 * and `date:2020-06-01` both produce a BareTextLiteral whose `value` is the
 * source text; numeric and temporal meaning is assigned by the value-type
 * registry at compile time, never by the parser. Three reasons, in order:
 *
 *  1. Fidelity. `value: number` destroys `1.50`, `1e3`, `007`, `+5` and `.5`,
 *     silently truncates past 2^53, and admits `Infinity`/`NaN`, which
 *     `JSON.stringify` turns into `null` (violating I2).
 *  2. No hardcoding. A parser that decides `1.2.3` is not a number has already
 *     special-cased type detection, and a consumer's `semver` type could never
 *     claim it afterwards.
 *  3. One source of truth. There is no second, parsed representation that can
 *     drift from the first.
 *
 * `true` / `false` / `null` DO get node identity, because they are grammar
 * KEYWORDS rather than values a type competes for: bare `true` is the boolean,
 * quoted `"true"` is the four-character string. That is what lets the boolean
 * and null value types claim by token kind alone and never swallow `"true"`.
 * ------------------------------------------------------------------------- */

export interface LiteralExpressionBase extends NodeBase, ClauseModifiers {
  readonly type: 'LiteralExpression';
}

/**
 * A bare term: `foo`, `100`, `2020-06-01`, `2020-06-01T12:00:00Z`. Matched
 * case-INsensitively. `value` is decoded — escapes resolved — so the source
 * `foo\*bar` yields `foo*bar` here and re-serializes with the backslash back.
 */
export interface BareTextLiteral extends LiteralExpressionBase, Fuzzable {
  readonly literal: 'text';
  readonly quoted: false;
  readonly quote: null;
  readonly value: string;
}

/** A quoted term: `'foo'`, `"2020-06-01 12:00:00"`. Matched case-SENSITIVELY. */
export interface QuotedTextLiteral extends LiteralExpressionBase, Proximate {
  readonly literal: 'text';
  readonly quoted: true;
  readonly quote: QuoteChar;
  readonly value: string;
}

/**
 * `quoted` and `quote` are paired by construction, and `quoted` is the single
 * fact deciding case sensitivity and wildcard eligibility.
 */
export type TextLiteral = BareTextLiteral | QuotedTextLiteral;

/** Bare `true` / `false`. Never produced for a quoted term. */
export interface BooleanLiteral extends LiteralExpressionBase {
  readonly literal: 'boolean';
  readonly quoted: false;
  readonly quote: null;
  readonly value: boolean;
}

/** Bare `null`. Never produced for a quoted term. */
export interface NullLiteral extends LiteralExpressionBase {
  readonly literal: 'null';
  readonly quoted: false;
  readonly quote: null;
  readonly value: null;
}

/**
 * Two-level discrimination: `type` for visitors that dispatch on node class,
 * `literal` to narrow to the payload.
 */
export type LiteralExpression = TextLiteral | BooleanLiteral | NullLiteral;

/* ------------------------------------------------------------------------- *
 * 5. Wildcards — pre-segmented, escapes already resolved
 *
 * `foo*bar?` is not a string with magic characters; it is a list of segments.
 * This removes the entire class of "consumer re-implements the tokenizer's
 * escape rules" bugs (a SQL backend must know which `*` was literal before it
 * emits `%`), makes "a boolean literal containing a wildcard" unrepresentable,
 * and dissolves the index-array alternative whose sortedness and in-range
 * invariants no type could enforce.
 *
 * QUOTING AND WILDCARDS ARE INDEPENDENT AXES. Quoting decides CASE; wildcards
 * decide SCOPE. Both compose, which is what makes the whole grid reachable from
 * two rules:
 *
 *              case-insensitive     case-sensitive
 *   exactly    status:active        status:'active'
 *   contains   status:*active*      status:'*active*'
 *   starts     status:active*       status:'active*'
 *   ends       status:*active       status:'*active'
 *
 * So a quoted pattern containing an unescaped `*` or `?` is a
 * QuotedWildcardExpression, NOT an ordinary literal — otherwise the entire
 * case-sensitive column would be unreachable. A literal asterisk is `\*` in
 * either form. (Classic Lucene reserves quotes for phrases and forbids
 * wildcards inside them; phrase/proximity is v0.2, so the slot is free.)
 * ------------------------------------------------------------------------- */

export interface WildcardLiteralSegment extends NodeBase {
  readonly type: 'WildcardLiteral';
  /** Decoded. The source `\*` produces `value: '*'` here. */
  readonly value: string;
}

/** `*` — zero or more characters. */
export interface WildcardAnySegment extends NodeBase {
  readonly type: 'WildcardAny';
}

/** `?` — exactly one character. */
export interface WildcardSingleSegment extends NodeBase {
  readonly type: 'WildcardSingle';
}

export type WildcardSegment =
  WildcardLiteralSegment | WildcardAnySegment | WildcardSingleSegment;

/**
 * Contains at least one `WildcardAny`/`WildcardSingle`; a pattern with none is a
 * {@link BareTextLiteral} instead. Adjacent literal segments are always merged,
 * so a given pattern has exactly one representation.
 */
export interface WildcardExpressionBase extends NodeBase, ClauseModifiers {
  readonly type: 'WildcardExpression';
  readonly pattern: NonEmptyArray<WildcardSegment>;
}

/** `foo*bar` — matched case-INsensitively, mirroring {@link BareTextLiteral}. */
export interface BareWildcardExpression extends WildcardExpressionBase {
  readonly quoted: false;
  readonly quote: null;
}

/**
 * `'foo*bar'` — matched case-SENSITIVELY, mirroring {@link QuotedTextLiteral}.
 * This is what makes `status:'*active*'` a case-sensitive containment search.
 */
export interface QuotedWildcardExpression extends WildcardExpressionBase {
  readonly quoted: true;
  readonly quote: QuoteChar;
}

/**
 * `quoted` is the single fact deciding case sensitivity, and it means the same
 * thing here as on {@link TextLiteral} — one rule, both node kinds.
 */
export type WildcardExpression =
  BareWildcardExpression | QuotedWildcardExpression;

/* ------------------------------------------------------------------------- *
 * 6. Regex
 * ------------------------------------------------------------------------- */

export interface RegexExpression extends NodeBase, ClauseModifiers {
  readonly type: 'RegexExpression';
  /**
   * Pattern between the slashes, EXACTLY as written — `\/` stays escaped and
   * nothing is normalised, because `new RegExp(p).source` is lossy.
   */
  readonly pattern: string;
  /** Order-preserving; the parser rejects duplicates and unknown flags. */
  readonly flags: readonly RegexFlag[];
}

/* ------------------------------------------------------------------------- *
 * 7. Ranges
 *
 * THE UNBOUNDED DECISION (`[* TO 200]`):
 *
 *   `value: TextLiteral | null` — REJECTED. `null` is a first-class value in
 *      this grammar; `height:[null TO 200]` is a real, different query.
 *   `Infinity` / `-Infinity` — REJECTED. Not JSON-safe (I2), collides with a
 *      legitimate numeric bound, and meaningless for temporal, semver or string
 *      ranges — it assumes exactly what a type registry exists to stop assuming.
 *   omit the property — REJECTED. Erases the `*` token's location, which
 *      highlight() and error carets need, and fights exactOptionalPropertyTypes.
 *
 *   CHOSEN: a `bounded: false` variant with its own location covering the `*`
 *   and NO `inclusive` property at all. `.value` is unreachable without
 *   narrowing, the `*` stays addressable, `[* TO *]` falls out for free, and the
 *   meaningless bit is not merely undocumented but unrepresentable. The
 *   consequence is that `{* TO 200]` and `[* TO 200]` are deep-equal, so
 *   serialize() normalises the open bracket — a normalisation of a bit that
 *   provably carries no meaning, which is why I4 still holds.
 *
 * Inclusivity lives PER BOUNDARY, so `[100 TO 200}` is the ordinary case rather
 * than a special one, and maps 1:1 onto SQL `>=`/`>`, Mongo `$gte`/`$gt` and ES
 * `gte`/`gt`.
 * ------------------------------------------------------------------------- */

export type RangeSide = 'lower' | 'upper';
export type RangeBracket = '[' | ']' | '{' | '}';

export interface BoundedRangeBoundary extends NodeBase {
  readonly type: 'RangeBoundary';
  readonly bounded: true;
  /** `[`/`]` → true, `{`/`}` → false. Independent per side. */
  readonly inclusive: boolean;
  /**
   * Always a TextLiteral. Booleans, nulls, regexes, wildcards and nested ranges
   * are unordered or non-scalar and have no meaning as an endpoint, so they have
   * no representation here. `location` covers the value token, not the bracket.
   */
  readonly value: TextLiteral;
}

/** `location` covers exactly the `*` token. */
export interface UnboundedRangeBoundary extends NodeBase {
  readonly type: 'RangeBoundary';
  readonly bounded: false;
}

export type RangeBoundary = BoundedRangeBoundary | UnboundedRangeBoundary;

/** `location` spans the opening bracket through the closing bracket. */
export interface RangeExpression extends NodeBase, ClauseModifiers {
  readonly type: 'RangeExpression';
  readonly lower: RangeBoundary;
  readonly upper: RangeBoundary;
}

/** Total function: the bracket a boundary must print as. */
export const rangeBracket = (
  side: RangeSide,
  boundary: RangeBoundary,
): RangeBracket => {
  if (!boundary.bounded || boundary.inclusive) {
    return side === 'lower' ? '[' : ']';
  }

  return side === 'lower' ? '{' : '}';
};

/* ------------------------------------------------------------------------- *
 * 8. Fields
 *
 * ONE encoding of the path, not three. A `name` string alongside a `path` array
 * alongside a `segments` array is three mutually unconstrained representations
 * of one fact (nothing forces their lengths to agree), and `name` is genuinely
 * ambiguous the moment a segment contains a literal dot (`'a.b':x` versus
 * `a.b:x`). `segments` is authoritative; everything else is a total function of
 * it.
 * ------------------------------------------------------------------------- */

export interface FieldSegment extends NodeBase {
  readonly type: 'FieldSegment';
  /** Decoded: quotes stripped, escapes resolved. */
  readonly name: string;
  /** Quoting is per segment: `'full name'.first` and `name.'first name'`. */
  readonly quote: QuoteChar | null;
}

export interface Field extends NodeBase {
  readonly type: 'Field';
  readonly segments: NonEmptyArray<FieldSegment>;
}

/** Traversal path. `name.first` → `['name','first']`; `'a.b'` → `['a.b']`. */
export const fieldPath = (field: Field): NonEmptyArray<string> => {
  const [first, ...rest] = field.segments;

  return [first.name, ...rest.map((segment) => segment.name)];
};

/**
 * Display form. LOSSY by nature — `'a.b':x` and `a\.b:x` both render `a.b` — so
 * it is for messages and highlight paths, never for lookups. Use
 * {@link fieldPath} for anything load-bearing.
 */
export const fieldName = (field: Field): string => fieldPath(field).join('.');

/* ------------------------------------------------------------------------- *
 * 9. Operators
 * ------------------------------------------------------------------------- */

export type MatchOperatorSymbol = ':';
export type RelationalOperatorSymbol = ':=' | ':>' | ':>=' | ':<' | ':<=';
export type ComparisonOperatorSymbol =
  MatchOperatorSymbol | RelationalOperatorSymbol;

/** The four that require an ordered value type. */
export type OrderingOperatorSymbol = ':>' | ':>=' | ':<' | ':<=';

export interface MatchOperator extends NodeBase {
  readonly type: 'ComparisonOperator';
  readonly operator: MatchOperatorSymbol;
}

export interface RelationalOperator extends NodeBase {
  readonly type: 'ComparisonOperator';
  readonly operator: RelationalOperatorSymbol;
}

export type ComparisonOperator = MatchOperator | RelationalOperator;

/**
 * `notation` is a first-class discriminant rather than a third `operator` value
 * `'IMPLICIT_AND'`, because notation and operator are independent facts, and
 * conflating them makes every evaluator test for a value that behaves
 * identically to another value. The split has a hard payoff: implicit OR is
 * uninhabited — juxtaposition can only ever mean AND, and the type says so.
 *
 * Keywords are UPPERCASE-ONLY (`AND`, `OR`, `NOT`, `TO`); lowercase `and` is a
 * bare search term. That rule is what lets these nodes carry no lexical payload,
 * so there is no `raw` spelling field that could contradict `operator`.
 */
export interface ExplicitBooleanOperator extends NodeBase {
  readonly type: 'BooleanOperator';
  readonly notation: 'explicit';
  readonly operator: 'AND' | 'OR';
}

/** `location` is zero-width, at the start of the right operand. */
export interface ImplicitBooleanOperator extends NodeBase {
  readonly type: 'BooleanOperator';
  readonly notation: 'implicit';
  readonly operator: 'AND';
}

export type BooleanOperator = ExplicitBooleanOperator | ImplicitBooleanOperator;

/**
 * FROZEN UNION (I3). `NOT x` and `-x` are one operation in two spellings; `+`
 * never lands here, it is {@link RequiredModifier}.
 */
export type UnaryOperatorSymbol = 'NOT' | '-';

/* ------------------------------------------------------------------------- *
 * 10. Tags
 *
 * A BARE TERM IS NOT A TAG. `foo` is a naked LiteralExpression in the tree: no
 * synthetic field, no synthetic operator, so `Tag.field` and `Tag.operator` are
 * never nullable and never fabricated. The identical leaf node serves as a bare
 * term and as a member of a field group, which is what makes field grouping a
 * two-line evaluation rule instead of a special case.
 *
 * THE DISCRIMINANT IS TOP-LEVEL (`kind`). TypeScript does not narrow a parent
 * union through a nested property, so a union discriminated at
 * `tag.operator.operator` would make the central node of the AST unnarrowable
 * and force every consumer — and the evaluator, serializer and highlighter
 * inside the package — to hand-write an unchecked type predicate. `kind` costs
 * one field and narrows for free.
 *
 * The split makes malformed comparisons UNCONSTRUCTIBLE: `height:>[1 TO 2]`,
 * `name:>=/re/`, `x:<(a OR b)` and `height:>true` have no representation at all.
 * ------------------------------------------------------------------------- */

export interface TagBase extends NodeBase, ClauseModifiers {
  readonly type: 'Tag';
  readonly field: Field;
}

/**
 * Anything that may follow a plain `:`.
 *
 * A `ParenthesizedExpression<FieldGroupBody>` here is a FIELD GROUP, and it is
 * NOT desugared into `(name:a OR name:b)`. Desugaring is lossy, fabricates
 * locations so highlight() and error carets point at text the user never wrote,
 * duplicates the field node N times with overlapping source ranges, and
 * multiplies subtrees on nesting. Evaluation instead pushes the field onto a
 * default-field stack, exactly as the grammar reads.
 */
export type MatchTagExpression =
  | LiteralExpression
  | WildcardExpression
  | RegexExpression
  | RangeExpression
  | ParenthesizedExpression<FieldGroupBody>
  | MissingExpression;

export interface MatchTag extends TagBase {
  readonly kind: 'match';
  readonly operator: MatchOperator;
  readonly expression: MatchTagExpression;
}

export interface RelationalTag extends TagBase {
  readonly kind: 'relational';
  readonly operator: RelationalOperator;
  /**
   * Ordering and equality compare against ONE scalar point. Never a range,
   * regex, wildcard, group, boolean or null. `MissingExpression` is admitted
   * only so tolerant mode can represent the `height:>=` a user is mid-keystroke
   * on.
   */
  readonly expression: TextLiteral | MissingExpression;
}

export type Tag = MatchTag | RelationalTag;

/* ------------------------------------------------------------------------- *
 * 11. Structure
 * ------------------------------------------------------------------------- */

/**
 * The `TOperand` parameter exists solely so a field group can be typed as a tree
 * that provably contains no nested Tag. It defaults to `Expression`, so
 * consumers who never mention it narrow exactly as they would without it, and
 * `LogicalExpression<FieldGroupBody>` stays assignable to
 * `LogicalExpression<Expression>` because every member is `readonly`.
 */
export interface LogicalExpression<
  TOperand extends NodeBase = Expression,
> extends NodeBase {
  readonly type: 'LogicalExpression';
  readonly operator: BooleanOperator;
  readonly left: TOperand;
  readonly right: TOperand;
}

export interface UnaryOperator<
  TOperand extends NodeBase = Expression,
> extends NodeBase {
  readonly type: 'UnaryOperator';
  readonly operator: UnaryOperatorSymbol;
  readonly operand: TOperand;
}

/**
 * Retained even when redundant: `(foo)` and `((foo))` keep their nodes, because
 * dropping them breaks I4 on the first nested query.
 */
export interface ParenthesizedExpression<TBody extends NodeBase = Expression>
  extends NodeBase, ClauseModifiers {
  readonly type: 'ParenthesizedExpression';
  readonly expression: TBody;
}

/**
 * The empty query, and only the empty query. EmptyExpression is EXCLUDED from
 * `Expression`, so `foo AND <empty>` — a node meaning "matches everything"
 * sitting under an AND or a NOT — is unrepresentable. That is a class of "did
 * you handle the empty side?" bug that cannot occur.
 */
export interface EmptyExpression extends NodeBase {
  readonly type: 'EmptyExpression';
}

/**
 * A hole. Produced ONLY by `parse(q, { tolerant: true })`, and always carrying
 * `recovered`.
 *
 * It is published in v0.1 rather than added in v0.2 because adding it later
 * would grow three unions consumers already switch over (I3). Its semantics are
 * defined by ELIMINATION, not by a truth value: `compile()` prunes it before
 * evaluation (a Tag whose expression is missing is dropped; a logical node with
 * a missing operand collapses to the other operand; a root that prunes to
 * nothing becomes an EmptyExpression), or refuses the query under
 * `onRecovered: 'throw'`. No evaluator, serializer or future backend ever has to
 * invent a meaning for it.
 */
export interface MissingExpression extends NodeBase {
  readonly type: 'MissingExpression';
}

/** Everything that can stand in an operand position. */
export type Expression =
  | LogicalExpression
  | ParenthesizedExpression
  | UnaryOperator
  | Tag
  | LiteralExpression
  | WildcardExpression
  | RegexExpression
  | RangeExpression
  | MissingExpression;

/**
 * The body of a field group: a boolean tree of UNFIELDED terms. `Tag` is absent,
 * so `name:(a OR b:c)` is not merely rejected at runtime — it cannot be
 * constructed, and the field-shadowing question never needs an answer.
 */
export type FieldGroupBody =
  | LogicalExpression<FieldGroupBody>
  | UnaryOperator<FieldGroupBody>
  | ParenthesizedExpression<FieldGroupBody>
  | LiteralExpression
  | WildcardExpression
  | RegexExpression
  | RangeExpression
  | MissingExpression;

/** What `parse()` returns. */
export type SiftQLAst = Expression | EmptyExpression;

/* ------------------------------------------------------------------------- *
 * 12. Reflection
 * ------------------------------------------------------------------------- */

export type AstNode =
  | SiftQLAst
  | Field
  | FieldSegment
  | ComparisonOperator
  | BooleanOperator
  | RangeBoundary
  | WildcardSegment
  | BoostModifier
  | FuzzyModifier
  | ProximityModifier
  | RequiredModifier;

export type AstNodeType = AstNode['type'];

/** `NodeByType['Tag']` → `MatchTag | RelationalTag`, narrowable by `kind`. */
export type NodeByType = {
  readonly [K in AstNodeType]: Extract<AstNode, { readonly type: K }>;
};

export type AstVisitor<R = void> = {
  readonly [K in AstNodeType]?: (node: NodeByType[K]) => R;
};

/**
 * Binding power used by the serializer to insert the minimum parentheses that
 * preserve tree shape (in addition to every explicit ParenthesizedExpression
 * node). Implicit AND binds exactly as tightly as explicit AND; all binary
 * operators are left-associative.
 *
 * Values are typed `number`, not literals, and spaced by ten. Exporting
 * `{ NOT: 3 }` would freeze the numeric lattice into the contract, so inserting
 * a level later would break every consumer that assigned or compared the literal
 * type.
 */
export const OPERATOR_PRECEDENCE: Readonly<Record<string, number>> =
  Object.freeze({
    NOT: 30,
    '-': 30,
    AND: 20,
    OR: 10,
  });

/* ------------------------------------------------------------------------- *
 * 13. Builders
 *
 * The answer to "how do I author a node without a `raw` slice?", and a stability
 * lever: if a future version must add a required field to a node, the builders
 * absorb it and only direct-object-literal authors break. Implemented in
 * `src/builders.ts`; the type lives here because it is part of the contract.
 * ------------------------------------------------------------------------- */

export interface AstBuilders {
  /** Bare term. Reserved characters are escaped on serialize, never reinterpreted. */
  readonly term: (value: string) => BareTextLiteral;
  readonly quoted: (value: string, quote?: QuoteChar) => QuotedTextLiteral;
  readonly boolean: (value: boolean) => BooleanLiteral;
  readonly null: () => NullLiteral;
  /**
   * Wildcard pattern. Here `*` and `?` ARE metacharacters; to match them
   * literally use {@link AstBuilders.term}, which escapes everything. Returns a
   * plain term when the pattern turns out to contain no metacharacter.
   */
  readonly wildcard: (pattern: string) => WildcardExpression | BareTextLiteral;
  readonly regex: (
    pattern: string,
    flags?: readonly RegexFlag[],
  ) => RegexExpression;
  readonly field: (...path: NonEmptyArray<string>) => Field;
  readonly tag: (field: Field, expression: MatchTagExpression) => MatchTag;
  readonly compare: (
    field: Field,
    operator: RelationalOperatorSymbol,
    expression: TextLiteral,
  ) => RelationalTag;
  readonly range: (
    lower: TextLiteral | null,
    lowerInclusive: boolean,
    upper: TextLiteral | null,
    upperInclusive: boolean,
  ) => RangeExpression;
  readonly and: (
    left: Expression,
    right: Expression,
    implicit?: boolean,
  ) => LogicalExpression;
  readonly or: (left: Expression, right: Expression) => LogicalExpression;
  readonly not: (
    operand: Expression,
    operator?: UnaryOperatorSymbol,
  ) => UnaryOperator;
  readonly group: (expression: Expression) => ParenthesizedExpression;
  readonly fieldGroup: (
    body: FieldGroupBody,
  ) => ParenthesizedExpression<FieldGroupBody>;
  readonly empty: () => EmptyExpression;
}
