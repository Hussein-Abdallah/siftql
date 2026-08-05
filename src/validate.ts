/**
 * The argument boundary.
 *
 * Every public function validates what it was handed before touching it. This
 * exists because the alternative is not "no check" — it is a check written by
 * accident, at whatever depth the value first gets used, reported as whatever
 * built-in error that use happens to raise. `parse(null)` threw
 * `TypeError: Cannot read properties of null (reading 'length')` from inside the
 * tokenizer, and `filter('a', {…})` threw `TypeError: items.filter is not a
 * function`. Both are true statements about our internals and useless to the
 * caller, and neither answers `isSiftQLError()`, so a consumer's
 * `catch (e) { if (isSiftQLError(e)) showToUser(e) else report(e) }` filed them
 * as siftql crashes.
 *
 * TypeScript does not remove the need for this. `JSON.parse` returns `any`, a
 * REST payload is `unknown`, a JS consumer has no checker at all, and `as` is a
 * claim rather than a proof. The compiler is a design tool here, not a runtime
 * guarantee.
 *
 * WHAT IS NOT VALIDATED, deliberately: the CONTENT of `items`. `filter` accepts
 * `unknown[]` and any element may be anything, including hostile — that is the
 * whole point of `access.ts`. Only the argument's own SHAPE is checked.
 */

import { SiftQLArgumentError, SiftQLConfigError } from './errors.js';
import type { OnRecovered, OnValueError, TypeStrategy } from './registry.js';
import { MAX_AST_DEPTH } from './limits.js';
import { type SiftQLAst, isSiftQLNode } from './types.js';

/**
 * How a value reads in an error message.
 *
 * `typeof` alone is too coarse to act on — being told "expected a string, got
 * object" does not distinguish `null` from an array from a Date. Long values are
 * clipped: an error message quoting a 40 KB document is not a diagnostic.
 */
export const describeArgument = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (Array.isArray(value)) {
    return `an array (length ${String(value.length)})`;
  }

  if (typeof value === 'string') {
    const clipped = value.length > 32 ? `${value.slice(0, 32)}…` : value;

    return `the string ${JSON.stringify(clipped)}`;
  }

  if (typeof value === 'function') {
    return 'a function';
  }

  if (typeof value === 'object') {
    const name: unknown = (value as { constructor?: { name?: unknown } })
      .constructor?.name;

    return typeof name === 'string' && name !== 'Object'
      ? `a ${name} instance`
      : 'a plain object';
  }

  // A symbol: String() on one throws, and JSON.stringify returns undefined.
  if (typeof value === 'symbol') {
    return `a symbol (${value.toString()})`;
  }

  // Number, boolean and bigint are all that remain. Narrowed POSITIVELY rather
  // than by elimination: subtracting cases from `unknown` leaves `{}`, which the
  // compiler cannot prove is safe to stringify, and it would be right not to —
  // the eliminating version is only correct as long as the branches above stay
  // exhaustive, and nothing would catch it if they stopped.
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return `${typeof value} (${String(value)})`;
  }

  return typeof value;
};

/** The query text. Empty is legal — it parses to an empty AST. */
export const assertQuery = (value: unknown, fn: string): string => {
  if (typeof value !== 'string') {
    throw new SiftQLArgumentError(
      `${fn}() expects the query as a string, received ${describeArgument(value)}.`,
      { argument: 'query', received: value },
    );
  }

  return value;
};

/**
 * The corpus.
 *
 * Only arrays, not arbitrary iterables. Accepting an iterable would make
 * `filter` consume a generator, and a caller who then iterated it again would
 * silently get nothing — a surprise worse than a clear refusal. A Set or an
 * iterator is one `[...x]` away at the call site, where the caller can see the
 * cost.
 */
export const assertItems = (value: unknown, fn: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    const hint =
      typeof value === 'object' && value !== null && Symbol.iterator in value
        ? ' Iterables are not accepted; spread it first: [...value].'
        : '';

    throw new SiftQLArgumentError(
      `${fn}() expects an array of items, received ${describeArgument(value)}.${hint}`,
      { argument: 'items', received: value },
    );
  }

  return value;
};

/**
 * An AST node, checked structurally rather than by `instanceof`.
 *
 * The AST is plain JSON by design — it survives `structuredClone`, a
 * `postMessage`, a database round trip — so there is no class to test. An
 * unrecognised `type` is refused rather than ignored: `serialize` used to return
 * `''` for `{ type: 'bogus' }`, which is indistinguishable from a legitimately
 * empty query and turned a typo into a query that matched everything.
 */
/**
 * Refuse a tree too deep to walk, and a tree that is not a tree at all.
 *
 * ITERATIVE, and therefore also the cycle check: a hand-built AST whose child
 * points back at an ancestor is not detectable by shape, but any walk of it
 * exceeds the depth limit, so bounding depth bounds both hazards with one pass.
 * A recursive depth check would itself overflow on the input it exists to
 * refuse.
 *
 * Generic over properties rather than switching on `node.type`, because the
 * point is to protect walks that have not been written yet as much as the four
 * that exist — `prune`, `findRecovered`, `compileExpression` and `serializeNode`
 * all recurse, and each one added to core is another place to forget.
 *
 * One O(n) pass per QUERY, not per item: `filter` over 10,000 records validates
 * once and then compiles once.
 */
const assertDepth = (root: SiftQLAst, fn: string): void => {
  const stack: { readonly node: object; readonly depth: number }[] = [
    { depth: 0, node: root },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();

    if (!frame) {
      break;
    }

    if (frame.depth > MAX_AST_DEPTH) {
      throw new SiftQLArgumentError(
        `${fn}() received an AST nested more than ${String(
          MAX_AST_DEPTH,
        )} levels deep. That is deeper than parse() can produce, so it was built by hand or arrived as JSON — check for a node that points back at one of its own ancestors.`,
        { argument: 'node', received: root.type },
      );
    }

    for (const child of Object.values(frame.node)) {
      if (typeof child === 'object' && child !== null) {
        stack.push({ depth: frame.depth + 1, node: child as object });
      }
    }
  }
};

export const assertNode = (value: unknown, fn: string): SiftQLAst => {
  if (!isSiftQLNode(value)) {
    const hint =
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { type?: unknown }).type === 'string'
        ? ` "${(value as { type: string }).type}" is not a known node type.`
        : ' Pass the result of parse().';

    throw new SiftQLArgumentError(
      `${fn}() expects a siftql AST node, received ${describeArgument(value)}.${hint}`,
      { argument: 'node', received: value },
    );
  }

  assertDepth(value, fn);

  return value;
};

/* ------------------------------------------------------------------------- *
 * Options.
 *
 * Config errors are SiftQLConfigError, not SiftQLArgumentError: a bad option is
 * a setup mistake with an existing category, and `code: 'CONFIG'` already means
 * exactly this. They are raised EAGERLY, at createEngine(), because the
 * alternative is discovering `dateFormat: 123` on the first record that happens
 * to hold a date — a failure whose timing depends on the data.
 * ------------------------------------------------------------------------- */

const ON_VALUE_ERROR: readonly OnValueError[] = ['skip', 'throw'];
const ON_RECOVERED: readonly OnRecovered[] = ['prune', 'throw'];
const TYPE_STRATEGY: readonly TypeStrategy[] = ['prepend', 'append', 'replace'];

const badOption = (name: string, expected: string, got: unknown): never => {
  throw new SiftQLConfigError(
    `options.${name} must be ${expected}, received ${describeArgument(got)}.`,
  );
};

const checkBoolean = (name: string, value: unknown): void => {
  if (value !== undefined && typeof value !== 'boolean') {
    badOption(name, 'a boolean', value);
  }
};

const checkEnum = (
  name: string,
  value: unknown,
  allowed: readonly string[],
): void => {
  if (value !== undefined && !allowed.includes(value as string)) {
    badOption(name, `one of ${allowed.map((a) => `'${a}'`).join(', ')}`, value);
  }
};

/** A single format string must be non-empty; `''` matches nothing, silently. */
const checkDateFormat = (value: unknown): void => {
  if (value === undefined) {
    return;
  }

  const formats = typeof value === 'string' ? [value] : value;

  if (!Array.isArray(formats)) {
    badOption('dateFormat', 'a format string or an array of them', value);

    return;
  }

  for (const format of formats) {
    if (typeof format !== 'string' || format.length === 0) {
      badOption(
        'dateFormat',
        'a format string or an array of them (no empty strings)',
        format,
      );
    }
  }
};

const checkTypes = (value: unknown): void => {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    const hint =
      typeof value === 'object' && value !== null
        ? ' It is an array, not a name-keyed object: types: [myType].'
        : '';

    throw new SiftQLConfigError(
      `options.types must be an array of value types or factories, received ${describeArgument(value)}.${hint}`,
    );
  }

  for (const [index, input] of (value as readonly unknown[]).entries()) {
    if (typeof input === 'function') {
      // A factory. It runs during createRegistry, where a throw is wrapped.
      continue;
    }

    if (
      typeof input !== 'object' ||
      input === null ||
      typeof (input as { name?: unknown }).name !== 'string' ||
      (input as { name: string }).name.length === 0
    ) {
      throw new SiftQLConfigError(
        `options.types[${String(index)}] must be a value type with a non-empty string name, or a factory returning one; received ${describeArgument(input)}.`,
      );
    }

    // `matches` and `ordering` are optional; `equals` is not — `:` falls back
    // to it, so a type without it cannot answer the most common operator.
    for (const method of ['parseOperand', 'coerceValue', 'equals'] as const) {
      if (typeof (input as Record<string, unknown>)[method] !== 'function') {
        throw new SiftQLConfigError(
          `options.types[${String(index)}] ("${(input as { name: string }).name}") is missing ${method}(). A value type needs parseOperand, coerceValue and equals.`,
        );
      }
    }
  }
};

/**
 * Validate engine options and return them unchanged.
 *
 * Unknown keys are ACCEPTED. Refusing them would break forward compatibility in
 * the ugliest way: a consumer who upgrades siftql, adopts a new option, then has
 * to downgrade for an unrelated reason would find their config throwing rather
 * than degrading. A typo'd option is a cost; a config that cannot survive a
 * version skew is worse.
 */
export const assertOptions = (value: unknown, fn: string): void => {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SiftQLArgumentError(
      `${fn}() expects an options object, received ${describeArgument(value)}.`,
      { argument: 'options', received: value },
    );
  }

  const options = value as Record<string, unknown>;

  checkBoolean('tolerant', options.tolerant);
  checkBoolean('matchKeys', options.matchKeys);
  checkBoolean('regexGuard', options.regexGuard);
  checkEnum('onValueError', options.onValueError, ON_VALUE_ERROR);
  checkEnum('onRecovered', options.onRecovered, ON_RECOVERED);
  checkEnum('typeStrategy', options.typeStrategy, TYPE_STRATEGY);
  checkDateFormat(options.dateFormat);

  if (options.id !== undefined && typeof options.id !== 'string') {
    badOption('id', 'a string', options.id);
  }

  if (
    options.parseDate !== undefined &&
    typeof options.parseDate !== 'function'
  ) {
    badOption('parseDate', 'a function', options.parseDate);
  }

  if (options.maxPatternLength !== undefined) {
    const length = options.maxPatternLength;

    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 1
    ) {
      badOption('maxPatternLength', 'a positive integer', length);
    }
  }

  checkTypes(options.types);
};
