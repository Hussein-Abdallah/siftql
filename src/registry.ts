/**
 * siftql — PUBLIC EXTENSIBILITY CONTRACT (v0.1.0).
 *
 * Value types, the per-engine registry, the split fail-loud policy, and the
 * engine/option surface.
 *
 * DESIGN THESIS: the engine contains no per-type logic. Recognising a token,
 * coercing a field value, matching, ordering, highlighting and (in v0.2)
 * lowering to SQL/Mongo/ES all live behind {@link ValueType}. The seven
 * built-ins are ordinary registrations with no privileges, which is what makes a
 * consumer's `semver` or `ip` type a first-class citizen rather than a
 * second-class bolt-on.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *  - A SECOND PUBLISHED IR. There is no `QueryPlan` node family. `compile()`
 *    returns an opaque {@link CompiledQuery}, so the semver-protected surface is
 *    one tree (the AST) plus one interface (ValueType). The v0.2 compilers reach
 *    what they need through {@link ValueType.portable} and
 *    {@link ValueType.compile}, both optional properties — additive by
 *    construction, and neither one duplicates the AST.
 *
 *  - A LEXICAL HOOK. Token boundaries are fixed by the grammar and the
 *    tokenizer's value/range modes, never by the registry. See {@link Engine}.
 *
 *  - AN AUGMENTABLE OPTIONS INTERFACE. `dateFormat` and `parseDate` are concrete
 *    members of {@link EngineOptions}. Routing type-specific options through a
 *    `declare module` interface would let any transitive dependency change the
 *    type of a public options object — including making a property required, so
 *    that every existing `filter(ast, items)` call site stops compiling after a
 *    dependency bump the consumer did not initiate. Types that need
 *    configuration take it in their factory instead.
 *
 *  - `registerType()`. Not exported, not internal, does not exist. A
 *    process-global mutable registry leaks one consumer's `currency` type into
 *    an unrelated library's engine in the same bundle and makes resolution order
 *    depend on module import order.
 */

import type {
  BooleanLiteral,
  Field,
  NonEmptyArray,
  NullLiteral,
  OrderingOperatorSymbol,
  RangeSide,
  RegexExpression,
  RegexFlag,
  TextLiteral,
  WildcardExpression,
  WildcardSegment,
} from './types.js';
import type { ResolvedTemporal, TemporalOptions } from './temporal/index.js';

/* ========================================================================= *
 * 1. OPERAND TOKENS — what a value type sees from the query side
 *
 * A normalised VIEW of an AST leaf, not the leaf itself. Custom types therefore
 * never destructure AST internals, so the reserved v0.2 modifiers can land on
 * AST nodes without touching a single registered type, and the simplest custom
 * type opens with a one-line `if (operand.kind !== 'text') return DECLINED;`.
 * ========================================================================= */

export type OperandToken =
  | {
      readonly kind: 'text';
      readonly text: string;
      /**
       * Whether the term was written inside quotes. Load-bearing, but NOT for
       * case — case comes from the clause, see {@link OperandContext}. What this
       * decides is keyword-versus-string: bare `true` is the boolean literal,
       * quoted `"true"` is a four-character string, so a type that claims by
       * token kind never swallows the quoted form.
       */
      readonly quoted: boolean;
      readonly node: TextLiteral;
    }
  | {
      readonly kind: 'boolean';
      readonly value: boolean;
      readonly node: BooleanLiteral;
    }
  | { readonly kind: 'null'; readonly node: NullLiteral }
  | {
      readonly kind: 'wildcard';
      readonly pattern: NonEmptyArray<WildcardSegment>;
      readonly node: WildcardExpression;
    }
  | {
      readonly kind: 'regex';
      readonly source: string;
      readonly flags: readonly RegexFlag[];
      readonly node: RegexExpression;
    };

/**
 * Where the operand sits.
 *
 * ONE discriminated union rather than three independent fields (`operator` +
 * `kind` + `role`) that could contradict each other, and `field` is present
 * exactly on the fielded sites — so "a scan carrying a field" and "a range
 * without one" are both unrepresentable.
 */
export type OperandSite =
  | { readonly kind: 'scan' }
  | { readonly kind: 'match'; readonly field: Field }
  | { readonly kind: 'equality'; readonly field: Field }
  | {
      readonly kind: 'ordered';
      readonly field: Field;
      readonly operator: OrderingOperatorSymbol;
    }
  | {
      readonly kind: 'range';
      readonly field: Field;
      readonly side: RangeSide;
      readonly inclusive: boolean;
    };

export type EvaluationSite = OperandSite['kind'];

/* ========================================================================= *
 * 2. RESULT UNIONS — where the split fail-loud policy physically lives
 *
 * The brief's sketch had `detect(token) -> boolean` AND `parse(raw) -> T | null`.
 * Collapsed to one method per side: two functions that must agree eventually
 * will not, and a `null` from parse already carries "not mine".
 *
 * But `null` alone is too coarse, because "not mine" and "mine but broken" must
 * behave OPPOSITELY. Hence three-armed unions — and deliberately NOT the same
 * union on both sides, because the third arms differ in kind:
 *
 *   operand side `declined` — type resolution is still in progress; try the
 *                             next type.
 *   value side   `miss`     — the type was ALREADY CHOSEN by the operand. A
 *                             field value never re-opens resolution; `miss`
 *                             means "outside my domain", full stop.
 *
 * One shared union would quietly imply a field value can decline its way to
 * another type, which is not what any implementation means.
 * ========================================================================= */

export interface OperandClaimed<T> {
  readonly ok: true;
  readonly operand: T;
}

export interface OperandDeclined {
  readonly ok: false;
  readonly kind: 'declined';
}

export interface OperandInvalid {
  readonly ok: false;
  readonly kind: 'invalid';
  readonly reason: string;
  readonly hint: string | null;
  /**
   * Error code to report, defaulting to `OPERAND`.
   *
   * Exists so the regex type can raise the `UNSAFE_PATTERN` code that
   * `errors.ts` documents. Without it that code was declared, described and
   * completely unreachable — both rejection paths reported `OPERAND`, so a
   * consumer branching on it to say "that pattern was refused as unsafe" could
   * never distinguish it from a malformed operand.
   */
  readonly code?: 'OPERAND' | 'UNSAFE_PATTERN';
}

/**
 * `invalid` STOPS resolution and throws `SiftQLOperandError`. That is what turns
 * `semver:>=1.2.3.4.5` into "not a valid semantic version" instead of the
 * useless generic "no ordered type claimed this operand" you get when the token
 * falls through to `string`.
 *
 * AUTHORING RULE: `invalid` is a CLAIM. A recognizer loose enough to claim
 * `1.2` would steal that token from `number` and turn `height:1.2` into a thrown
 * error in every engine where the type is registered.
 */
export type OperandResult<T> =
  OperandClaimed<T> | OperandDeclined | OperandInvalid;

export interface ValueResolved<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ValueMiss {
  readonly ok: false;
  readonly kind: 'miss';
}

export interface ValueInvalid {
  readonly ok: false;
  readonly kind: 'invalid';
  readonly reason: string;
}

export type ValueResult<T> = ValueResolved<T> | ValueMiss | ValueInvalid;

/** Frozen singleton: the hot path allocates nothing for the common outcome. */
export const DECLINED: OperandDeclined = Object.freeze({
  ok: false,
  kind: 'declined',
});

/** Frozen singleton. A bare-keyword sweep over a 40-key object hits this often. */
export const MISS: ValueMiss = Object.freeze({ ok: false, kind: 'miss' });

export const claimed = <T>(operand: T): OperandResult<T> => ({
  ok: true,
  operand,
});

export const malformedOperand = (
  reason: string,
  hint: string | null = null,
  code: 'OPERAND' | 'UNSAFE_PATTERN' = 'OPERAND',
): OperandInvalid => ({ code, ok: false, kind: 'invalid', reason, hint });

export const resolved = <T>(value: T): ValueResult<T> => ({ ok: true, value });

export const malformedValue = (reason: string): ValueInvalid => ({
  ok: false,
  kind: 'invalid',
  reason,
});

/* ========================================================================= *
 * 3. THE POLICY TABLE
 * ========================================================================= */

/** How a value-side failure is dispositioned. */
export type ValueFailureKind = 'miss' | 'invalid' | 'incomparable';

export type FailureDisposition = 'no-match' | 'value-error';

/**
 * THE SPLIT FAIL-LOUD POLICY, AS DATA.
 *
 * A `ValueType` never sees `onValueError` and never throws. It returns `miss` /
 * `invalid`, or `null` from `compare`; the engine indexes this table with
 * (site, kind) and either drops the record silently or raises a
 * `SiftQLValueError` gated on `options.onValueError` (default `'skip'`).
 * Publishing the matrix as a frozen object the evaluator literally reads is what
 * keeps the documented policy and the behaviour from drifting.
 *
 * Two asymmetries worth reading twice:
 *
 *  - `scan` never errors, whatever happens. A bare keyword sweeps every leaf of
 *    every record, so most values legitimately belong to other types; under
 *    `scan` not even `onValueError: 'throw'` will throw. This is a total
 *    function of the site rather than a mutable "am I scanning?" context bit.
 *  - `ordered` / `range` treat even `miss` as a value error, because
 *    `createdAt:>=2020-01-01` is an assertion by the query author that the field
 *    is temporal. A value that is not is dirty data — exactly the case
 *    `onValueError` exists to govern.
 */
export const VALUE_FAILURE_POLICY = Object.freeze({
  scan: { miss: 'no-match', invalid: 'no-match', incomparable: 'no-match' },
  match: {
    miss: 'no-match',
    invalid: 'value-error',
    incomparable: 'no-match',
  },
  equality: {
    miss: 'no-match',
    invalid: 'value-error',
    incomparable: 'no-match',
  },
  ordered: {
    miss: 'value-error',
    invalid: 'value-error',
    incomparable: 'value-error',
  },
  range: {
    miss: 'value-error',
    invalid: 'value-error',
    incomparable: 'value-error',
  },
}) satisfies Readonly<
  Record<EvaluationSite, Readonly<Record<ValueFailureKind, FailureDisposition>>>
>;

/**
 * Look up a disposition, or `undefined` for a pair the table does not cover.
 *
 * `undefined` is in the return type deliberately. The lookup used to be
 * `VALUE_FAILURE_POLICY[site][kind]` typed as always returning a
 * `FailureDisposition`, which was a lie in exactly the case that mattered: a
 * custom type returning `{ ok: false, kind: 'bogus' }` produced `undefined`,
 * `undefined === 'value-error'` was false, and the failure was silently
 * dispositioned as `'no-match'`. That turned an unknown failure kind into a
 * quiet non-match — and, for an `ordered` or `range` site, quietly downgraded
 * the strictest row in the table to the most lenient behaviour it has.
 *
 * Typing the absence forces `signalValueFailure` to decide what an unknown pair
 * means, which it does by refusing it.
 */
export const dispositionFor = (
  site: EvaluationSite,
  kind: ValueFailureKind,
): FailureDisposition | undefined =>
  // Indexed through a widened view: the declared parameter types say the lookup
  // always succeeds, and the whole point here is that at runtime it may not.
  (
    VALUE_FAILURE_POLICY as Readonly<
      Record<string, Readonly<Record<string, FailureDisposition>>>
    >
  )[site]?.[kind];

/* ========================================================================= *
 * 4. CONTEXTS
 * ========================================================================= */

/**
 * The engine settings a value type can SEE.
 *
 * `onValueError` and `onRecovered` are withheld, and that withholding is the
 * design rather than tidiness. `errors.ts` and this file both state that "a
 * ValueType never sees `onValueError` and never throws" — the split-policy
 * design rests on it, because a type that branched on the policy would make
 * matching depend on a setting core cannot reason about, and would decide for
 * itself whether a dirty value is fatal. That was simply untrue: `options` was
 * the whole `ResolvedEngineOptions`, so any type could read both and act on
 * them.
 *
 * A type still gets everything it legitimately needs — `matchKeys`,
 * `regexGuard`, `maxPatternLength`, `id`, and the temporal options it must
 * close over.
 */
export type TypeVisibleOptions = Omit<
  ResolvedEngineOptions,
  'onRecovered' | 'onValueError'
>;

/**
 * Drop the failure policy, producing the object a value type is given.
 *
 * Written out key by key rather than as a rest-destructure, so that adding a
 * setting later is a compile error here — the safe default for a NEW option is
 * to be visible, and the unsafe one is to leak a policy knob by forgetting this
 * function exists.
 */
export const withoutFailurePolicy = (
  options: ResolvedEngineOptions,
): TypeVisibleOptions =>
  Object.freeze({
    id: options.id,
    matchKeys: options.matchKeys,
    maxPatternLength: options.maxPatternLength,
    regexGuard: options.regexGuard,
    temporal: options.temporal,
    tolerant: options.tolerant,
  });

export interface OperandContext {
  readonly site: OperandSite;
  readonly options: TypeVisibleOptions;
  /**
   * Whether the enclosing clause was written with a doubled colon. Supplied
   * HERE, at operand-parse time, so a type can fold its operand once and keep
   * the hot path allocation-free — which is why `equals` takes no context.
   * Always false at a `scan` site: an unfielded term has no operator to double.
   */
  readonly caseSensitive: boolean;
  /** Delegate to a peer type by name, e.g. `currency` reusing `number`. */
  readonly lookup: (typeName: string) => AnyValueType | undefined;
}

export interface ValueContext {
  readonly site: OperandSite;
  /** See {@link TypeVisibleOptions}: the failure policy is deliberately absent. */
  readonly options: TypeVisibleOptions;
  /** The enclosing clause's collation; see {@link OperandContext.caseSensitive}. */
  readonly caseSensitive: boolean;
  /**
   * Where this value lives in the record: `['name','first']`, `['tags',3]`.
   * Array indices are numbers, not strings, and the array is frozen.
   *
   * A LAZY accessor on the prototype, because materialising it for every
   * candidate made a deep record quadratic to search. `ctx.path`, destructuring
   * and `JSON.stringify(ctx)` all behave normally; `{...ctx}` and
   * `Object.keys(ctx)` do NOT include it, since it is not an own property.
   */
  readonly path: readonly (string | number)[];
  /** True when the candidate is an object KEY rather than a value (`matchKeys`). */
  readonly isKey: boolean;
  readonly lookup: (typeName: string) => AnyValueType | undefined;
}

/* ========================================================================= *
 * 5. ValueType
 *
 * Critique of the brief's sketch, and what changed:
 *
 *  detect + parse   → ONE `parseOperand`. Two methods that can disagree is an
 *                     inconsistent state by construction.
 *  parse(raw)       → `parseOperand(OperandToken, ctx)`. A raw string cannot
 *                     express quoting, and quoting decides case sensitivity and
 *                     keyword-versus-string (`"true"`). A bare string would make
 *                     `foo` and `"foo"` indistinguishable to every type.
 *  one parse, both  → SPLIT into `parseOperand` and `coerceValue`. Not one
 *  sides              function with a widened parameter: the domains diverge in
 *                     BOTH directions. `datetime` accepts an epoch number and a
 *                     `Date` as a VALUE but must refuse a bare number as an
 *                     OPERAND (else `height:>1000` silently becomes a date
 *                     comparison); `semver` accepts a `{major,minor,patch}`
 *                     object that no query string can express. Their failure
 *                     modes are opposite too (throw versus skip). A mode flag
 *                     would just be two functions in a trench coat.
 *  TWO type params  → `TOperand` and `TValue`, defaulting to the coinciding
 *                     case. One parameter cannot type `wildcard` or `regex`,
 *                     whose operand is a compiled matcher and whose values are
 *                     strings — two of the seven built-ins.
 *  equals + compare → `equals` KEPT and required (it is `:=`); `matches` made
 *                     optional and defaulting to it (it is `:`). That single
 *                     distinction is the whole `:` versus `:=` semantics,
 *                     expressed once. `number` omits `matches`, so `height:100`
 *                     and `height:=100` agree. `string` implements it — but only
 *                     to widen an UNFIELDED term to a containment scan, so
 *                     `name:foo` and `name:=foo` also agree, and it is a bare
 *                     `foo` that differs. An earlier version of this comment
 *                     claimed the fielded forms differ; they do not, and the
 *                     grammar has no unfielded relational operator to compare
 *                     them with.
 *  compare always   → moved into an OPTIONAL `ordering` sub-object. Its ABSENCE
 *  present            is the sole fact that a type is unordered, which makes
 *                     `name:>="m"` throw structurally: quoted free text resolves
 *                     to `string`, `string` has no `ordering`, done. A
 *                     sub-object rather than an `ordered: boolean` (which can
 *                     desync with the method), rather than an `operators` list
 *                     (which can desync the same way), and rather than an
 *                     `Ordered | Unordered` union of the interface itself (which
 *                     a third capability tier in v0.3 would have to widen —
 *                     breaking every custom type's declaration).
 *  matchKeyword     → DELETED. An unfielded term is defined as applying the same
 *                     `matches` to every leaf; `matchKeys` is an engine concern.
 *  (missing)        → `highlight` and `portable` ADDED. Only the type knows how
 *                     to build a RegExp for its own operand, or how to describe
 *                     itself to a backend that has never heard of it.
 *
 * ARGUMENT ORDER IS ALWAYS `(value, operand)` across `equals`, `matches`,
 * `compare` and `highlight` — "is the FIELD VALUE ≥ the QUERY OPERAND?".
 * Inverted comparison arguments are the classic silent range bug and no type
 * system catches them, so the convention is stated once and held everywhere.
 * ========================================================================= */

export interface ValueOrdering<TOperand, TValue> {
  /**
   * `< 0` when `value` sorts before `operand`, `0` when equal, `> 0` after — and
   * `null` when the two have NO DEFINED ORDERING AT ALL.
   *
   * `null` is not a convenience. A wall-clock `14:30` and a calendar
   * `2020-06-01` sit on different lines, and the only correct answers are
   * "incomparable" or an error, never a number — which is precisely why
   * `src/temporal/compare.ts` already returns `number | null`. The engine
   * dispositions `null` through {@link VALUE_FAILURE_POLICY} as `incomparable`,
   * so a mixed comparison is a located, policy-governed failure instead of a
   * confident wrong result. Types with a total order simply never return it.
   *
   * Range evaluation is implemented ONCE in core on top of this plus
   * per-boundary inclusivity, so no type ever writes range code:
   *   `[lo TO hi]` → compare(v, lo) >= 0 && compare(v, hi) <= 0
   *   `[lo TO hi}` → compare(v, lo) >= 0 && compare(v, hi) <  0
   *   `[*  TO hi]` → compare(v, hi) <= 0
   */
  compare(value: TValue, operand: TOperand): number | null;
}

export interface ValueType<TOperand = unknown, TValue = TOperand> {
  /** Unique within a registry; duplicates are a `SiftQLConfigError`. */
  readonly name: string;

  /** Query side. Return {@link DECLINED} to pass to the next type. */
  parseOperand(
    operand: OperandToken,
    ctx: OperandContext,
  ): OperandResult<TOperand>;

  /**
   * Data side: arbitrary runtime JS — string, number, boolean, null, `Date`, an
   * array element, a nested object leaf. Called once per candidate value, so
   * keep it allocation-light and return {@link MISS} for out-of-domain input.
   *
   * CONVENTION, obeyed by every built-in and documented for authors: MISS on the
   * wrong JS shape (a boolean reaching the datetime type), INVALID on the right
   * shape with wrong content (the string `'n/a'` reaching it). That convention is
   * what makes `createdAt:"n/a"` a policy decision rather than a silent
   * non-match.
   */
  coerceValue(value: unknown, ctx: ValueContext): ValueResult<TValue>;

  /** `:=` — strict equality. */
  equals(value: TValue, operand: TOperand): boolean;

  /** `:` — relaxed match. Falls back to {@link ValueType.equals} when absent. */
  matches?(value: TValue, operand: TOperand, ctx: ValueContext): boolean;

  /** Present ⇔ the type supports `:>` `:>=` `:<` `:<=` and range boundaries. */
  readonly ordering?: ValueOrdering<TOperand, TValue>;

  /**
   * The RegExp to light up inside a matched value, or `null` when the match has
   * no textual footprint (a range, a boolean). The type supplies the pattern; it
   * never decides whether the highlight survives — suppressing highlights from
   * the losing branch of an OR and from everything under a satisfied NOT is
   * core's job and is not delegable.
   */
  highlight?(
    value: TValue,
    operand: TOperand,
    ctx: ValueContext,
  ): RegExp | null;

  /**
   * The spans to light up, when a RegExp would be unsafe to hand out.
   *
   * Preferred over {@link ValueType.highlight} when both are present. It exists
   * because a `RegExp` is not just data — the consumer RUNS it, on the
   * backtracking engine, in the `exec` loop this package's own docs tell them to
   * write. A pattern siftql matches in 3 ms via its automaton took a caller 8.8
   * seconds that way, so the safe thing to publish is where the matches ARE, not
   * a program for finding them again.
   */
  highlightSpans?(
    value: TValue,
    operand: TOperand,
    ctx: ValueContext,
  ): readonly HighlightSpan[] | null;

  /*
   * NOTE FOR v0.2: the SQL/Mongo/Elasticsearch lowering hooks (`portable`,
   * `compile`) are deliberately NOT published in v0.1. They were designed and
   * then cut, because declaration-only API is still API: every exported name
   * is something this package is obliged to support, and nothing here could
   * exercise them. Both are optional members on an interface, so re-adding
   * them in v0.2 is additive and breaks nothing.
   */
}

/**
 * Existential erasure for the heterogeneous registry. `any` is deliberate and
 * quarantined to this alias: the engine never inspects `TOperand`/`TValue`, it
 * only pairs an operand with the same type's own methods. `unknown` here would
 * push casts into every consumer's type definition instead of removing them.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnyValueType = ValueType<any, any>;

/** Identity function that preserves inference through an object literal. */
export const defineValueType = <TOperand, TValue = TOperand>(
  spec: ValueType<TOperand, TValue>,
): ValueType<TOperand, TValue> => spec;

/* ========================================================================= *
 * 7. REGISTRY — immutable, ordered, per-engine
 *
 * RESOLUTION ORDER IS ARRAY ORDER, first non-`declined` wins. No priority
 * numbers to tie or to fight over across packages: a consumer states precedence
 * by writing the list. Registered types are PREPENDED by default so a
 * consumer's `semver` claims `1.2.3` before `number` sees it.
 *
 * Built-in order — documented, tested, and part of the contract:
 *
 *   0. <user types>   prepend (default) | append | replace
 *   1. regex     claims `kind: 'regex'` only            — token-gated
 *   2. null      claims `kind: 'null'` only             — token-gated
 *   3. boolean   claims `kind: 'boolean'` only          — token-gated
 *   4. wildcard  claims `kind: 'wildcard'` only         — token-gated
 *   5. datetime  text passing strict `detectTemporalFormat`, QUOTED OR BARE.
 *                Quoting is a tokenizer convenience, not a semantic signal, so
 *                it must not change which type claims the token. Does NOT claim
 *                bare integers — `1591000000000` is a number — while epoch
 *                queries against `Date` fields still work, because it is the
 *                VALUE side that accepts epochs and `Date`s.
 *   6. number    unquoted numeric text
 *   7. string    TOTAL — claims every operand, and has no `ordering`
 *
 * Slots 1–4 cannot collide: the AST already separated those tokens, which is the
 * payoff for giving keywords, regexes and wildcards node identity. Slots 5–7
 * cannot collide either, since a strict date shape is not a number. The order is
 * published anyway so future types have a defined place to land.
 *
 * RANGES: the lower bound resolves first (or the upper, when the lower is `*`);
 * the winning type must also claim the other bound, else
 * `SiftQLOperandError { code: 'MIXED_RANGE_TYPES' }`, and it must have
 * `ordering`, else `{ code: 'UNORDERED_TYPE' }`.
 * ========================================================================= */

export type BuiltinTypeName =
  'regex' | 'null' | 'boolean' | 'wildcard' | 'datetime' | 'number' | 'string';

/** The built-in resolution order, exported so it can be reproduced exactly. */
export const BUILTIN_TYPE_ORDER: readonly BuiltinTypeName[] = Object.freeze([
  'regex',
  'null',
  'boolean',
  'wildcard',
  'datetime',
  'number',
  'string',
]);

export type TypeStrategy = 'prepend' | 'append' | 'replace';

/**
 * Types may be values OR factories, and the factory form is what makes
 * per-engine scoping real rather than cosmetic: `datetime` must close over THIS
 * engine's `dateFormat`/`parseDate`, so it cannot be a module-level singleton.
 * Two engines in one process can disagree about what `01-02-2020` means without
 * either knowing the other exists. Stateless types stay plain objects.
 */
export type ValueTypeFactory = (env: TypeEnvironment) => AnyValueType;

export type ValueTypeInput = AnyValueType | ValueTypeFactory;

export interface TypeEnvironment {
  /** See {@link TypeVisibleOptions}: the failure policy is deliberately absent. */
  readonly options: TypeVisibleOptions;
  /** Resolved `dateFormat`/`parseDate`, ready to hand to `resolveTemporal`. */
  readonly temporal: TemporalOptions;
  /** Lazy peer lookup, so a factory may reference types declared after it. */
  readonly lookup: (typeName: string) => AnyValueType | undefined;
}

export interface TypeDescriptor {
  readonly name: string;
  readonly ordered: boolean;
  readonly builtin: boolean;
}

export interface ValueTypeRegistry {
  /** Resolution order, front to back. Frozen. */
  readonly types: readonly AnyValueType[];
  get(name: string): AnyValueType | undefined;
  /** Machine-readable order; the documentation table is generated from it. */
  describe(): readonly TypeDescriptor[];
  /** Returns a NEW registry. There is no mutation API at any level. */
  with(
    types: readonly ValueTypeInput[],
    strategy?: TypeStrategy,
  ): ValueTypeRegistry;
}

/* ========================================================================= *
 * 8. TEMPORAL BINDING
 *
 * Types only. The implementation is `src/temporal/`, the single source of truth
 * consumed by BOTH range evaluation and comparison evaluation, and the
 * `datetime` value type is an ordinary registration over it with no privileged
 * hook and no branch anywhere in the evaluator.
 * ========================================================================= */

export type { ResolvedTemporal, TemporalOptions };

/** The operand and value representation used by the built-in `datetime` type. */
export type TemporalValueType = ValueType<ResolvedTemporal, ResolvedTemporal>;

/* ========================================================================= *
 * 9. OPTIONS
 * ========================================================================= */

export interface ParseOptions {
  /**
   * Best-effort AST for incomplete input (`foo:"bar`, `name:`, `a AND `) instead
   * of throwing — for search-as-you-type. Recovered nodes are FLAGGED through
   * `NodeBase.recovered`, never silently patched, and a half-typed clause
   * becomes a `MissingExpression` rather than being dropped, so the UI can still
   * see and complete the field the user is typing.
   */
  readonly tolerant?: boolean | undefined;
}

export type OnValueError = 'skip' | 'throw';

export type OnRecovered = 'prune' | 'throw';

export interface EvaluateOptions {
  /** Also test object KEYS, not only values. */
  readonly matchKeys?: boolean | undefined;
  /**
   * Refuse a regex the linear matcher cannot take, instead of running it on
   * JavaScript's backtracking engine. Default `true`.
   *
   * User patterns are matched by an automaton (`src/regex/linear.ts`), so
   * catastrophic backtracking is not possible for anything it accepts. Two
   * features it cannot express — backreferences and lookaround — are refused
   * under this setting, because neither can be matched in guaranteed linear
   * time by any engine.
   *
   * Set `false` to run those on `RegExp` instead. The risk is then yours: a
   * pattern like `(a+)+` from an untrusted author can block the process for
   * minutes, and nothing in JavaScript can interrupt it.
   */
  readonly regexGuard?: boolean | undefined;
  /** Longest accepted regex source. Default 1000. */
  readonly maxPatternLength?: number | undefined;
  /**
   * Governs value-side failures only, through {@link VALUE_FAILURE_POLICY}.
   * Default `'skip'`: the record does not match and evaluation continues. Query
   * operands ignore this entirely — a wrong query always throws.
   */
  readonly onValueError?: OnValueError | undefined;
  /**
   * What `compile()` does with a tolerant-mode AST. Default `'prune'`: recovered
   * holes are eliminated and the rest of the query evaluates, which is what a
   * live search box wants. `'throw'` is for anything that must not act on a
   * guess.
   */
  readonly onRecovered?: OnRecovered | undefined;
}

export type EngineOptions = ParseOptions &
  EvaluateOptions &
  TemporalOptions & {
    readonly types?: readonly ValueTypeInput[] | undefined;
    /** Default `'prepend'`: user types outrank built-ins. */
    readonly typeStrategy?: TypeStrategy | undefined;
    /**
     * Names this engine in {@link TypeEnvironment}, so a custom type can tell
     * which engine it is running inside.
     *
     * NOT currently included in any error message, despite an earlier version of
     * this comment saying so.
     */
    readonly id?: string | undefined;
  };

export interface ResolvedEngineOptions {
  readonly id: string;
  readonly tolerant: boolean;
  readonly matchKeys: boolean;
  readonly regexGuard: boolean;
  readonly maxPatternLength: number;
  readonly onValueError: OnValueError;
  readonly onRecovered: OnRecovered;
  readonly temporal: TemporalOptions;
}

/* ========================================================================= *
 * 10. ENGINE
 *
 * The Engine interface lives in `./engine/create.ts`, next to its
 * implementation, and `Highlight` above is the one engine-facing type the
 * registry needs.
 *
 * NOTE FOR v0.2: this section previously declared `CompiledQuery`,
 * `CompileResult`, `Queryable`, `ParseResult`, `Diagnostic`, `CreateEngine`
 * and a second `Engine` describing `compile()`, `tryCompile()` and
 * `parseWithDiagnostics()`. All were designed and then cut for the same reason
 * as the backend-lowering hooks: declaration-only API is still API, every
 * exported name is something this package is then obliged to support, and
 * nothing in v0.1 could exercise any of it. Adding them later is additive.
 * ========================================================================= */

/** A half-open range inside a matched value. */
export interface HighlightSpan {
  readonly start: number;
  readonly end: number;
}

/** One field that made a record match, and what to light up inside it. */
export interface Highlight {
  /**
   * Exactly where the matches are, when the type could compute them.
   *
   * PREFER THIS OVER `query`. It is data rather than a program: nothing the
   * consumer runs, so nothing that can backtrack. It is also the only form that
   * can state what the built-in types actually match — matching folds case with
   * `toLowerCase`, and a `RegExp` applied by a caller folds under rules that
   * disagree in both directions, so `/s/iu` marks `ſ` where siftql does not
   * match, and dropping the `u` to fix that makes `/k/i` refuse the Kelvin
   * sign where siftql matches it.
   *
   * Every built-in reports spans. `query` remains for custom types.
   *
   * Absent when the whole value is the match and there is no substring to point
   * at — a range, a comparison, a boolean — and when case folding CHANGES THE
   * LENGTH of the value (`'İ'.toLowerCase()` is two code points), because then
   * no offset into the original value is meaningful.
   */
  readonly ranges?: readonly HighlightSpan[];
  /** Dotted path for display: `name.first`, `tags.3`. Lossy if a key has a dot. */
  readonly path: string;
  /**
   * Unambiguous form of `path`; prefer it for programmatic lookup.
   *
   * May address a key the item does NOT have, in one case: when the absence is
   * itself the match. `membership:null` matches `{ name: 'bob' }` — a missing
   * key reads as null — and reports `['membership']`, which resolves to
   * `undefined`. The clause did match, and naming it is the useful answer; there
   * is simply nothing there to underline. Treat a lookup that yields `undefined`
   * as "matched by absence", not as a malformed highlight.
   */
  readonly segments: readonly (string | number)[];
  /**
   * Where inside the value to underline. Absent when the whole value is the
   * match and there is no substring to point at — a range, a comparison, a
   * boolean.
   *
   * CARRIES THE `g` FLAG, and is therefore STATEFUL: `.test()` and `.exec()`
   * advance `lastIndex`, so calling either twice on the same instance gives
   * different answers. That is deliberate — the common consumers
   * (`String.prototype.matchAll`, and highlighter components that loop on
   * `while (match = regex.exec(text))`) REQUIRE a global regex, and a
   * non-global one makes that loop spin forever.
   *
   * Each Highlight gets its OWN instance, so iterating the returned array is
   * safe. If you keep one and reuse it, reset `lastIndex` between calls or
   * clone it: `new RegExp(query.source, query.flags)`.
   */
  readonly query?: RegExp;
}
