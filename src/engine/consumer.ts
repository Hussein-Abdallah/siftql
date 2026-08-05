/**
 * The consumer-callback boundary.
 *
 * A value type is arbitrary code that siftql calls, per operand and per value.
 * It can throw, and it can return something outside its declared return type —
 * TypeScript is not present at runtime, and a type may be authored in JavaScript
 * or by a code generator. Before this module existed, a custom type that threw
 * from `coerceValue` sent a raw exception out of `filter()`, which meant a bug in
 * ONE consumer type destroyed the whole result set and was reported as a siftql
 * crash.
 *
 * The rule is the split policy that already governs everything else — WHERE the
 * failure happened decides what it means:
 *
 * | Callback              | Throwing means            | Disposition           |
 * |-----------------------|---------------------------|-----------------------|
 * | factory               | broken CONFIG             | SiftQLConfigError     |
 * | `parseOperand`        | broken QUERY handling     | SiftQLOperandError    |
 * | `coerceValue`         | this DATUM is unusable    | follows onValueError  |
 * | `equals` / `matches`  | this DATUM is unusable    | follows onValueError  |
 * | `ordering.compare`    | this DATUM is unusable    | follows onValueError  |
 * | `highlight`           | cosmetic                  | no pattern            |
 *
 * `parseOperand` is a query-side failure and therefore unconditional: the operand
 * comes from the query, is resolved ONCE per query rather than per record, and a
 * type that cannot handle it will fail for every record. Treating that as dirty
 * data would return "no matches" for a query that is actually broken — the exact
 * silent-wrongness the split policy exists to prevent.
 *
 * WRONG RETURN VALUES are a different category from throwing, and are always a
 * `SiftQLConfigError`. `matches` returning the string `'yes'` is not dirty data;
 * it is a defect in the type, it will happen for every value, and truthiness
 * coercion would silently paper over it. `'no'` is truthy too, so a type
 * returning strings would match everything — including the records it meant to
 * reject. That is worth stopping loudly.
 *
 * The original exception is always preserved as `cause`, so "every error siftql
 * throws is a SiftQLError" costs no debuggability.
 */

import {
  SiftQLConfigError,
  SiftQLOperandError,
  signalValueFailure,
  type ValueFailure,
} from '../errors.js';
import type {
  AnyValueType,
  OperandContext,
  OperandResult,
  OperandToken,
  TypeEnvironment,
  ValueContext,
  ValueResult,
  ValueTypeInput,
} from '../registry.js';

/** What a failing callback is called in a message: `number.coerceValue()`. */
const describe = (type: AnyValueType, method: string): string =>
  `${typeof type.name === 'string' ? type.name : '<unnamed>'}.${method}()`;

const brokenType = (
  type: AnyValueType,
  method: string,
  problem: string,
  cause?: unknown,
): never => {
  throw new SiftQLConfigError(
    `Value type ${describe(type, method)} ${problem}`,
    ...(cause === undefined ? [] : [{ cause }]),
  );
};

/* ------------------------------------------------------------------------- *
 * Shape checks for what a callback hands back.
 * ------------------------------------------------------------------------- */

const isResult = (value: unknown): value is { readonly ok: boolean } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { ok?: unknown }).ok === 'boolean';

/* ------------------------------------------------------------------------- *
 * Config-time: resolving a type input.
 * ------------------------------------------------------------------------- */

/**
 * Run a type factory, or pass a plain type through.
 *
 * A factory throwing is a configuration failure: it happens once, at
 * `createEngine()`, and the engine cannot be built without it.
 */
export const resolveTypeInput = (
  input: ValueTypeInput,
  environment: TypeEnvironment,
): AnyValueType => {
  if (typeof input !== 'function') {
    return input;
  }

  let produced: unknown;

  try {
    produced = input(environment);
  } catch (error) {
    throw new SiftQLConfigError(
      `A value type factory threw while the engine was being created: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (
    typeof produced !== 'object' ||
    produced === null ||
    typeof (produced as { name?: unknown }).name !== 'string' ||
    (produced as { name: string }).name.length === 0
  ) {
    throw new SiftQLConfigError(
      'A value type factory must return a value type with a non-empty string name.',
    );
  }

  return produced as AnyValueType;
};

/* ------------------------------------------------------------------------- *
 * Query-time: the operand.
 * ------------------------------------------------------------------------- */

export const callParseOperand = (
  type: AnyValueType,
  token: OperandToken,
  ctx: OperandContext,
  location: { readonly start: number; readonly end: number },
  raw: string,
): OperandResult<unknown> => {
  let result: unknown;

  try {
    result = type.parseOperand(token, ctx);
  } catch (error) {
    throw new SiftQLOperandError(
      `Value type ${describe(type, 'parseOperand')} threw while reading the operand: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        candidates: [type.name],
        cause: error,
        code: 'OPERAND',
        hint: 'This is a defect in that value type, not in the query.',
        location,
        raw,
        site: ctx.site,
      },
    );
  }

  if (!isResult(result)) {
    brokenType(
      type,
      'parseOperand',
      'must return DECLINED, malformedOperand(...), or { ok: true, value }.',
    );
  }

  return result as OperandResult<unknown>;
};

/* ------------------------------------------------------------------------- *
 * Value-time: everything called once per candidate.
 *
 * Each of these takes the failure descriptor it would need to report, so the
 * call sites keep reading as one expression and cannot forget to route a throw.
 * ------------------------------------------------------------------------- */

/** The failure descriptor minus the fields this module fills in. */
type FailureSite = Omit<ValueFailure, 'kind' | 'reason'>;

const threwReason = (method: string, error: unknown): string =>
  `${method}() threw: ${error instanceof Error ? error.message : String(error)}`;

export const callCoerceValue = (
  type: AnyValueType,
  value: unknown,
  ctx: ValueContext,
  site: FailureSite,
): ValueResult<unknown> => {
  let result: unknown;

  try {
    result = type.coerceValue(value, ctx);
  } catch (error) {
    // A datum this type cannot read. Route it, and report the non-match that
    // signalValueFailure guarantees when policy is 'skip'.
    signalValueFailure({
      ...site,
      cause: error,
      kind: 'invalid',
      reason: threwReason('coerceValue', error),
    });

    return { kind: 'miss', ok: false };
  }

  if (!isResult(result)) {
    brokenType(
      type,
      'coerceValue',
      'must return MISS, malformedValue(...), or { ok: true, value }.',
    );
  }

  return result as ValueResult<unknown>;
};

/**
 * `equals` or `matches`.
 *
 * Returns `false` for a datum the type could not judge, which is the same answer
 * every other value failure produces: a failure is never a match.
 */
export const callPredicate = (
  type: AnyValueType,
  method: 'equals' | 'matches',
  run: () => unknown,
  site: FailureSite,
): boolean => {
  let result: unknown;

  try {
    result = run();
  } catch (error) {
    return signalValueFailure({
      ...site,
      cause: error,
      kind: 'invalid',
      reason: threwReason(method, error),
    });
  }

  if (typeof result !== 'boolean') {
    brokenType(
      type,
      method,
      `must return a boolean; it returned ${
        result === null ? 'null' : typeof result
      }. A truthy non-boolean would silently match every record.`,
    );
  }

  return result as boolean;
};

/** `ordering.compare`. `null` means "these two are not comparable". */
export const callCompare = (
  type: AnyValueType,
  run: () => unknown,
  site: FailureSite,
): number | null => {
  let result: unknown;

  try {
    result = run();
  } catch (error) {
    signalValueFailure({
      ...site,
      cause: error,
      kind: 'incomparable',
      reason: threwReason('ordering.compare', error),
    });

    return null;
  }

  if (result === null || result === undefined) {
    return null;
  }

  if (typeof result !== 'number') {
    brokenType(
      type,
      'ordering.compare',
      `must return a number or null; it returned ${typeof result}.`,
    );
  }

  if (Number.isNaN(result)) {
    brokenType(
      type,
      'ordering.compare',
      'returned NaN. NaN compares false in every direction, so a range would silently exclude everything; return null for "not comparable".',
    );
  }

  return result as number;
};

/**
 * `highlight`.
 *
 * Never throws and never routes through the failure policy. The record has
 * ALREADY matched by the time this runs; the only question left is whether we
 * can point at the substring responsible. Losing that is cosmetic, and turning a
 * cosmetic failure into an exception — or into a non-match — would let a
 * decorative hook change the answer to the query.
 */
export const callHighlight = (
  type: AnyValueType,
  value: unknown,
  operand: unknown,
  ctx: ValueContext,
): RegExp | null => {
  if (type.highlight === undefined) {
    return null;
  }

  try {
    const pattern = type.highlight(value, operand, ctx);

    return pattern instanceof RegExp ? pattern : null;
  } catch {
    return null;
  }
};
