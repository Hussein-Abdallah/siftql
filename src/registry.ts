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
  QuoteChar,
  RangeSide,
  RegexExpression,
  RegexFlag,
  SiftQLAst,
  SourceLocation,
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
      /** `null` ⇒ bare ⇒ case-insensitive. Load-bearing: `"true"` is a string. */
      readonly quote: QuoteChar | null;
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
): OperandInvalid => ({ ok: false, kind: 'invalid', reason, hint });

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

export const dispositionFor = (
  site: EvaluationSite,
  kind: ValueFailureKind,
): FailureDisposition => VALUE_FAILURE_POLICY[site][kind];

/* ========================================================================= *
 * 4. CONTEXTS
 * ========================================================================= */

export interface OperandContext {
  readonly site: OperandSite;
  readonly options: ResolvedEngineOptions;
  /** Delegate to a peer type by name, e.g. `currency` reusing `number`. */
  readonly lookup: (typeName: string) => AnyValueType | undefined;
}

export interface ValueContext {
  readonly site: OperandSite;
  readonly options: ResolvedEngineOptions;
  /** Where this value lives in the record: `['name','first']`, `['tags',3]`. */
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
 *                     expressed once: `number` omits `matches` so `height:100`
 *                     and `height:=100` agree, `string` implements it so
 *                     `name:foo` and `name:=foo` differ.
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
  readonly options: ResolvedEngineOptions;
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
    /** Appears in error messages and in {@link TypeEnvironment}. */
    readonly id?: string | undefined;
  };

export interface ResolvedEngineOptions {
  readonly id: string;
  readonly tolerant: boolean;
  readonly matchKeys: boolean;
  readonly onValueError: OnValueError;
  readonly onRecovered: OnRecovered;
  readonly temporal: TemporalOptions;
}

/* ========================================================================= *
 * 10. ENGINE
 * ========================================================================= */

export interface Diagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly location: SourceLocation;
}

export interface ParseResult {
  readonly ast: SiftQLAst;
  readonly source: string;
  /** Non-empty only under `tolerant: true`. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface Highlight {
  /** Dotted path for display: `name.first`, `tags.3`. Lossy if a key has a dot. */
  readonly path: string;
  /** Unambiguous form of `path`; prefer it for programmatic lookup. */
  readonly segments: readonly (string | number)[];
  /** Absent when the whole value matched (ranges, comparisons, booleans). */
  readonly query?: RegExp;
}

/**
 * A query with every operand already resolved against THIS engine's registry.
 * This is where type threading stops being cosmetic:
 *
 *  - `compile()` walks the AST once, calls `parseOperand` for each operand in
 *    registry order, and stores the winning type with its parsed representation;
 *  - every `SiftQLOperandError` therefore surfaces ONCE, before a single record
 *    is inspected — not on row 4,317;
 *  - `filter()` over 100k items runs `parseOperand` exactly as many times as
 *    there are operands.
 *
 * The bound representation is deliberately NOT published: a second exported IR
 * would double the semver-protected surface, and every backend switching on it
 * would have to be kept in step with the evaluator by hand.
 */
export interface CompiledQuery {
  readonly ast: SiftQLAst;
  readonly engine: Engine;
  /** Value type names this query resolved to, in AST order. Introspectable. */
  readonly usedTypes: readonly string[];
  test(item: unknown): boolean;
  filter<T>(items: readonly T[]): T[];
  highlight(item: unknown): readonly Highlight[];
}

/**
 * Non-throwing `compile()`.
 *
 * Operand failures ALWAYS throw from `compile()`; that policy is not negotiable
 * and not configurable. But a search box that compiles on every keystroke must
 * survive intermediate states such as `date:>=2020-0`, so the capture lives in a
 * sibling entry point rather than in a flag that would water the policy down.
 */
export type CompileResult =
  | { readonly ok: true; readonly query: CompiledQuery }
  | { readonly ok: false; readonly error: Error };

/** Anything accepted where a query is expected; a CompiledQuery skips re-binding. */
export type Queryable = string | SiftQLAst | CompiledQuery;

export interface Engine {
  readonly id: string;
  readonly registry: ValueTypeRegistry;
  readonly options: ResolvedEngineOptions;

  /**
   * Registry-INDEPENDENT, on purpose. Tokenisation is fixed by the grammar and
   * by the tokenizer's default/value/range modes, so the same string parses to
   * the same tree in every engine and an AST is portable across engines,
   * serializers and editors.
   *
   * This is why {@link ValueType} has no lexical hook. The one place a value
   * type might seem to need one — the colons inside `2020-06-01T00:00:00Z` — is
   * already solved by mode switching: after a comparison operator the tokenizer
   * is in value mode, where a colon is an ordinary character. Letting a
   * registered type arbitrate token boundaries would make "what does this string
   * parse to" a function of configuration rather than a versioned statement, and
   * would leave a spec-level grammar guarantee living inside a removable type.
   */
  parse(query: string, options?: ParseOptions): SiftQLAst;
  parseWithDiagnostics(query: string, options?: ParseOptions): ParseResult;
  serialize(ast: SiftQLAst): string;

  compile(query: string | SiftQLAst, options?: EvaluateOptions): CompiledQuery;
  tryCompile(
    query: string | SiftQLAst,
    options?: EvaluateOptions,
  ): CompileResult;

  test(query: Queryable, item: unknown, options?: EvaluateOptions): boolean;
  filter<T>(
    query: Queryable,
    items: readonly T[],
    options?: EvaluateOptions,
  ): T[];
  /**
   * Highlights are collected only from branches that actually satisfied the
   * query: the evaluator returns `{ matched, highlights }` pairs and DISCARDS
   * the highlight set of any branch whose result was not used — the non-taken
   * side of an OR, and everything under a satisfied NOT.
   */
  highlight(
    query: Queryable,
    item: unknown,
    options?: EvaluateOptions,
  ): readonly Highlight[];

  /** Derive a new engine. Never mutates the receiver. */
  extend(options: EngineOptions): Engine;
}

/** THE PRIMARY API: per-instance registry, no global state. */
export type CreateEngine = (options?: EngineOptions) => Engine;
