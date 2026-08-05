/**
 * siftql — ERROR CONTRACT (v0.1.0).  [src/errors.ts]
 *
 * Note that the syntax error class is deliberately *not* called `SyntaxError`.
 * Exporting that name shadows the global inside consumer modules, so a caller
 * writing `catch (e) { if (e instanceof SyntaxError) ... }` silently stops
 * catching genuine JS syntax errors. Every siftql error name is prefixed.
 *
 * THE SPLIT FAIL-LOUD POLICY, and where each half lives:
 *
 *  A QUERY OPERAND that no active type can resolve — `date:>=notadate`,
 *  `name:>="m"`, `[1 TO 2020-01-01]` — ALWAYS THROWS. The query itself is wrong,
 *  and it is wrong before any data exists. Raised by `compile()`, so it surfaces
 *  once, ahead of row one, never on row 4,317.
 *
 *  A FIELD VALUE that cannot be resolved — one `createdAt: 'n/a'` out of 10,000
 *  — is dispositioned by `VALUE_FAILURE_POLICY` and then gated on
 *  `options.onValueError`, DEFAULT `'skip'`, meaning that record simply does not
 *  match. Throwing here would let one dirty row destroy an entire `filter()`
 *  result set and blow up a UI.
 *
 * The second half is implemented exactly once, by `signalValueFailure` at the
 * bottom of this file. A `ValueType` never sees `onValueError` and never throws.
 *
 * `SourceLocation` is defined in `./types.ts` (every AST node carries one) and
 * re-exported here so existing importers such as `src/parser/tokens.ts` keep
 * working unchanged.
 */

import { dispositionFor } from './registry.js';
import type {
  EvaluationSite,
  FailureDisposition,
  OnValueError,
  OperandSite,
  ValueFailureKind,
} from './registry.js';
import type { SourceLocation } from './types.js';

export type { SourceLocation };

export type SiftQLErrorCode =
  /** Malformed query text. */
  | 'SYNTAX'
  /** Valid LQL, reserved for v0.2: `^boost`, `~fuzzy`, `+required`. */
  | 'UNSUPPORTED_SYNTAX'
  /** No type claimed the operand, or a type claimed it and rejected it. */
  | 'OPERAND'
  /** `:>` / `:<` / a range against a type with no `ordering`. */
  | 'UNORDERED_TYPE'
  /** `[1 TO 2020-01-01]` — the two boundaries resolved to different types. */
  | 'MIXED_RANGE_TYPES'
  /** A field value failed, policy said error, and `onValueError` is `'throw'`. */
  | 'VALUE'
  /** `compile()` met a tolerant-recovery node under `onRecovered: 'throw'`. */
  | 'RECOVERED'
  /** Duplicate type name, unknown built-in, malformed `dateFormat`. */
  | 'CONFIG'
  /** A user-supplied regex was refused by the backtracking screen. */
  | 'UNSAFE_PATTERN'
  /** A public function was called with an argument of the wrong shape. */
  | 'ARGUMENT';

/**
 * Base class for every error siftql throws. Catch this to catch them all.
 *
 * `code` is the load-bearing discriminant rather than `instanceof`, because a
 * bundle containing two copies of the package breaks `instanceof` while leaving
 * `code` correct — which is why {@link isSiftQLError} checks structurally.
 */
/**
 * Brand identifying an error as siftql's.
 *
 * `Symbol.for` is registry-global, so two copies of the package in one bundle
 * produce the SAME symbol and the check still works — which is the property
 * `instanceof` loses. A structural `typeof err.code === 'string'` check has the
 * opposite problem: every Node system error carries a `code`, so `ENOENT` and
 * `ECONNREFUSED` were being reported as siftql errors and a caller's catch
 * block misclassified genuine infrastructure failures.
 */
const SIFTQL_ERROR = Symbol.for('siftql.error');

export class SiftQLError extends Error {
  public readonly code: SiftQLErrorCode;

  /** @internal */
  public readonly [SIFTQL_ERROR] = true;

  public constructor(
    message: string,
    code: SiftQLErrorCode = 'CONFIG',
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    // NOT `new.target.name`: a minifier renames the class, so a production
    // bundle reported `err.name === 'x'`. Each subclass sets its own literal.
    this.name = 'SiftQLError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Survives duplicate copies of the package in a bundle; rejects foreign errors. */
export const isSiftQLError = (value: unknown): value is SiftQLError =>
  value instanceof Error &&
  (value as { readonly [SIFTQL_ERROR]?: unknown })[SIFTQL_ERROR] === true;

/**
 * Render a one-line excerpt with a caret under the offending span, e.g.
 *
 * ```
 * name:foo AND (bio:bar
 *              ^
 * ```
 */
const renderExcerpt = (source: string, location: SourceLocation): string => {
  // Collapse newlines so the caret column stays aligned with what we print.
  const flattened = source.replace(/[\n\r]/gu, ' ');
  const width = Math.max(1, location.end - location.start);

  return `\n${flattened}\n${' '.repeat(location.start)}${'^'.repeat(width)}`;
};

export interface SyntaxErrorDetails {
  /** `'UNSUPPORTED_SYNTAX'` for valid LQL that v0.1 does not implement. */
  readonly code?: 'SYNTAX' | 'UNSUPPORTED_SYNTAX' | undefined;
  /** Human-readable descriptions of what the parser would have accepted. */
  readonly expected?: readonly string[] | undefined;
}

/**
 * Raised when a query cannot be parsed. The positional signature is preserved
 * from the shipped tokenizer; `details` is additive.
 */
export class SiftQLSyntaxError extends SiftQLError {
  /** Where in the query the problem is. */
  public readonly location: SourceLocation;

  /** The query that failed to parse, so a caller can render its own caret. */
  public readonly source: string;

  public readonly expected: readonly string[];

  public constructor(
    message: string,
    location: SourceLocation,
    source: string,
    details: SyntaxErrorDetails = {},
  ) {
    super(
      `${message} (at ${String(location.start)})${renderExcerpt(source, location)}`,
      details.code ?? 'SYNTAX',
    );
    this.name = 'SiftQLSyntaxError';
    this.location = location;
    this.source = source;
    this.expected = details.expected ?? [];
  }
}

export interface OperandErrorDetails {
  readonly code?:
    'OPERAND' | 'UNORDERED_TYPE' | 'MIXED_RANGE_TYPES' | undefined;
  readonly location: SourceLocation;
  /** Where the operand sat, and against which field. */
  readonly site: OperandSite;
  /** The operand as written. */
  readonly raw: string;
  /** Type names consulted, in resolution order. */
  readonly candidates?: readonly string[] | undefined;
  /** Set when a type claimed the operand and reported it malformed. */
  readonly reason?: string | null | undefined;
  readonly hint?: string | null | undefined;
  /** Original exception, when a value type threw rather than returning a result. */
  readonly cause?: unknown;
}

/**
 * QUERY-SIDE FAILURE. Always thrown, never suppressed, never configurable.
 * Raised by `compile()`, before a single record is touched.
 */
export class SiftQLOperandError extends SiftQLError {
  public readonly location: SourceLocation;

  public readonly site: OperandSite;

  public readonly raw: string;

  public readonly candidates: readonly string[];

  public readonly reason: string | null;

  public readonly hint: string | null;

  public constructor(message: string, details: OperandErrorDetails) {
    super(
      message,
      details.code ?? 'OPERAND',
      'cause' in details ? { cause: details.cause } : {},
    );
    this.name = 'SiftQLOperandError';
    this.location = details.location;
    this.site = details.site;
    this.raw = details.raw;
    this.candidates = details.candidates ?? [];
    this.reason = details.reason ?? null;
    this.hint = details.hint ?? null;
  }
}

export interface ValueErrorDetails {
  readonly typeName: string;
  /** Path of the offending value inside the record: `['user','createdAt']`. */
  readonly path: readonly (string | number)[];
  readonly value: unknown;
  readonly kind: ValueFailureKind;
  readonly reason?: string | null | undefined;
  /** Location of the QUERY clause that forced the coercion. */
  readonly location: SourceLocation;
  /**
   * The original exception, when this failure came from consumer code throwing
   * — a getter on the record, a Proxy trap, a custom `coerceValue`. Preserved so
   * "every error siftql throws is a SiftQLError" costs no diagnostic detail: the
   * stack that actually failed is still one `.cause` away.
   */
  readonly cause?: unknown;
}

/**
 * DATA-SIDE FAILURE. Thrown only when policy says `value-error` AND
 * `onValueError === 'throw'`. `location` points at the query clause, not at the
 * row — a caret into a data row would be meaningless.
 */
export class SiftQLValueError extends SiftQLError {
  public readonly typeName: string;

  public readonly path: readonly (string | number)[];

  public readonly value: unknown;

  public readonly kind: ValueFailureKind;

  public readonly reason: string | null;

  public readonly location: SourceLocation;

  public constructor(message: string, details: ValueErrorDetails) {
    super(message, 'VALUE', 'cause' in details ? { cause: details.cause } : {});
    this.name = 'SiftQLValueError';
    this.typeName = details.typeName;
    this.path = details.path;
    this.value = details.value;
    this.kind = details.kind;
    this.reason = details.reason ?? null;
    this.location = details.location;
  }
}

/** `compile()` met a tolerant-recovery node under `onRecovered: 'throw'`. */
export class SiftQLRecoveredQueryError extends SiftQLError {
  public readonly location: SourceLocation;

  public readonly reason: string;

  public constructor(
    message: string,
    details: { readonly location: SourceLocation; readonly reason: string },
  ) {
    super(message, 'RECOVERED');
    this.name = 'SiftQLRecoveredQueryError';
    this.location = details.location;
    this.reason = details.reason;
  }
}

/**
 * A public function was called with an argument of the wrong SHAPE — `parse(null)`,
 * `filter(query, notAnArray)`, `serialize({ type: 'bogus' })`.
 *
 * Distinct from {@link SiftQLConfigError}, which is a wrong OPTION, and from
 * {@link SiftQLSyntaxError}, which is a wrong QUERY. All three are caller
 * mistakes, but they are found at different boundaries and fixed in different
 * places, so collapsing them would lose the one piece of information the caller
 * needs: whether to look at the call site, the engine setup, or the query text.
 */
export class SiftQLArgumentError extends SiftQLError {
  /** Parameter name as it appears in the signature: `'query'`, `'items'`. */
  public readonly argument: string;

  /** The offending value, so a caller can log what actually arrived. */
  public readonly received: unknown;

  public constructor(
    message: string,
    details: { readonly argument: string; readonly received: unknown },
  ) {
    super(message, 'ARGUMENT');
    this.name = 'SiftQLArgumentError';
    this.argument = details.argument;
    this.received = details.received;
  }
}

/** Bad engine configuration: duplicate type name, malformed `dateFormat`. */
export class SiftQLConfigError extends SiftQLError {
  public constructor(
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, 'CONFIG', options);
    this.name = 'SiftQLConfigError';
  }
}

/* ------------------------------------------------------------------------- *
 * Value-failure signalling — the ONE place skip-vs-throw is decided.
 * ------------------------------------------------------------------------- */

export interface ValueFailure {
  readonly kind: ValueFailureKind;
  readonly site: EvaluationSite;
  readonly typeName: string;
  readonly path: readonly (string | number)[];
  readonly value: unknown;
  readonly reason: string | null;
  readonly location: SourceLocation;
  readonly onValueError: OnValueError;
  /** Original exception, when consumer code threw rather than returning a signal. */
  readonly cause?: unknown;
}

const describeValueFailure = (failure: ValueFailure): string => {
  const where =
    failure.path.length === 0 ? 'the value' : failure.path.join('.');
  const why =
    failure.reason ??
    (failure.kind === 'incomparable'
      ? 'it has no defined ordering against the query operand'
      : 'it is outside the domain of that type');

  return `Value type "${failure.typeName}" could not use ${where}: ${why}`;
};

/**
 * Returns `false` — "this record does not match" — or throws
 * {@link SiftQLValueError}. It never returns `true`, because a failure is never
 * a match, so the call site reads `return signalValueFailure(...)` and cannot
 * forget to handle the outcome.
 */
export const signalValueFailure = (failure: ValueFailure): false => {
  const disposition: FailureDisposition | undefined = dispositionFor(
    failure.site,
    failure.kind,
  );

  if (disposition === undefined) {
    // An unknown site or kind. The only way to reach this from outside is a
    // value type returning a failure kind that is not one of the three, and
    // treating it as "no match" would silently apply the most lenient row in the
    // table to a failure nobody has classified.
    throw new SiftQLConfigError(
      `No failure policy for site "${failure.site}" with kind "${failure.kind}". A value type must fail with MISS, malformedValue(...), or an 'incomparable' result.`,
    );
  }

  if (disposition === 'value-error' && failure.onValueError === 'throw') {
    throw new SiftQLValueError(describeValueFailure(failure), {
      kind: failure.kind,
      location: failure.location,
      path: failure.path,
      reason: failure.reason,
      typeName: failure.typeName,
      value: failure.value,
      ...('cause' in failure ? { cause: failure.cause } : {}),
    });
  }

  return false;
};
