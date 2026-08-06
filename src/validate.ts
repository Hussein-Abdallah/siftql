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
import type {
  EngineOptions,
  OnRecovered,
  OnValueError,
  TypeStrategy,
} from './registry.js';
import { safeIsArray } from './internal.js';
import { MAX_AST_DEPTH, MAX_AST_NODES } from './limits.js';
import { assertValidFormat } from './temporal/format.js';
import { type SiftQLAst, isSiftQLNode } from './types.js';

/**
 * How a value reads in an error message.
 *
 * `typeof` alone is too coarse to act on — being told "expected a string, got
 * object" does not distinguish `null` from an array from a Date. Long values are
 * clipped: an error message quoting a 40 KB document is not a diagnostic.
 */
/**
 * Read one property for reporting purposes, or give up.
 *
 * The failure path must not be able to fail. `describeArgument` runs only when an
 * argument is ALREADY known to be wrong, and it reached for `constructor.name`
 * and `length` unguarded — so a Proxy whose `get` trap throws made the function
 * whose entire job is to turn bad arguments into `SiftQLArgumentError` throw the
 * raw error instead, at the one moment it was supposed to help.
 */
const peek = (holder: object, key: PropertyKey): unknown => {
  try {
    return (holder as Record<PropertyKey, unknown>)[key];
  } catch {
    return undefined;
  }
};

export const describeArgument = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (safeIsArray(value)) {
    const length = peek(value, 'length');

    return typeof length === 'number'
      ? `an array (length ${String(length)})`
      : 'an array';
  }

  if (typeof value === 'string') {
    const clipped = value.length > 32 ? `${value.slice(0, 32)}…` : value;

    return `the string ${JSON.stringify(clipped)}`;
  }

  if (typeof value === 'function') {
    return 'a function';
  }

  if (typeof value === 'object') {
    const constructor = peek(value, 'constructor');
    const named =
      constructor !== null &&
      (typeof constructor === 'object' || typeof constructor === 'function');
    const name = named ? peek(constructor, 'name') : undefined;

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
  if (!safeIsArray(value)) {
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
 * unrecognised `type` is refused rather than ignored, because `serialize` would
 * `''` for `{ type: 'bogus' }`, which is indistinguishable from a legitimately
 * empty query and turned a typo into a query that matched everything.
 */

/* ------------------------------------------------------------------------- *
 * Node shape.
 *
 * Checking `type` alone was not enough, and the gap was wider than it looked:
 * `serialize({ type: 'bogus' })` was caught, but `serialize({ type: 'Tag' })`
 * threw `TypeError: Cannot read properties of undefined (reading 'operator')`
 * from inside the serializer — as did five of the ten root types, across all four
 * entry points. That is the exact case the contract invites, since the AST is
 * advertised as plain JSON that survives `structuredClone`, a `postMessage` and a
 * database round trip; a truncated or hand-built node is the normal way to get
 * one wrong.
 *
 * A TABLE rather than ten predicates, because the walk already visits every node
 * and the question at each is the same: which properties must be present, and of
 * what kind. Interior node types are included — `Field`, `RangeBoundary`,
 * `ComparisonOperator` — since a walk reaches them too and they are exactly the
 * ones a truncated tree tends to be missing.
 * ------------------------------------------------------------------------- */

type Check = (value: unknown) => boolean;

const isObject: Check = (value) =>
  typeof value === 'object' && value !== null && !safeIsArray(value);

const isString: Check = (value) => typeof value === 'string';
const isBool: Check = (value) => typeof value === 'boolean';
const isArray: Check = (value) => safeIsArray(value);
const isNonEmptyArray: Check = (value) =>
  safeIsArray(value) && value.length > 0;

const oneOf =
  (...allowed: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && allowed.includes(value);

/**
 * A wildcard pattern must be in the ONE representation the contract promises.
 *
 * `types.ts` says runs of `*` are collapsed and adjacent literals merged, "so a
 * given pattern has exactly one representation". `scanPattern` upholds that, so
 * no parsed tree can violate it — but a hand-built or deserialized one can, and
 * such a tree does not round-trip: `[Any, Any, Literal('b')]` serializes to
 * `**b`, which parses back to two segments, not three.
 *
 * Refused rather than quietly collapsed on output, because the tree is the thing
 * that is wrong; printing it as though it were valid would hide a caller's bug
 * and leave `serialize` disagreeing with the AST it was handed.
 */
const isCanonicalPattern: Check = (value) => {
  if (!safeIsArray(value) || value.length === 0) {
    return false;
  }

  let previous: string | null = null;

  for (const segment of value) {
    const type = peek(segment as object, 'type');

    if (typeof type !== 'string') {
      return false;
    }

    if (
      (type === 'WildcardAny' && previous === 'WildcardAny') ||
      (type === 'WildcardLiteral' && previous === 'WildcardLiteral')
    ) {
      return false;
    }

    previous = type;
  }

  return true;
};

const NODE_SHAPES: Readonly<Record<string, Readonly<Record<string, Check>>>> =
  Object.freeze({
    BooleanOperator: {
      notation: oneOf('explicit', 'implicit'),
      operator: oneOf('AND', 'OR'),
    },
    ComparisonOperator: {
      operator: oneOf(':', ':=', ':>', ':>=', ':<', ':<='),
    },
    EmptyExpression: {},
    Field: { segments: isNonEmptyArray },
    FieldSegment: { name: isString, quoted: isBool },
    LiteralExpression: {
      literal: oneOf('text', 'boolean', 'null'),
      quoted: isBool,
    },
    LogicalExpression: {
      left: isObject,
      operator: isObject,
      right: isObject,
    },
    MissingExpression: {},
    ParenthesizedExpression: { expression: isObject },
    RangeBoundary: { bounded: isBool },
    RangeExpression: { lower: isObject, upper: isObject },
    RegexExpression: { flags: isArray, pattern: isString },
    Tag: {
      caseSensitive: isBool,
      expression: isObject,
      field: isObject,
      kind: oneOf('match', 'relational'),
      operator: isObject,
    },
    UnaryOperator: { operand: isObject, operator: oneOf('NOT', '-') },
    WildcardAny: {},
    WildcardExpression: { pattern: isCanonicalPattern, quoted: isBool },
    WildcardLiteral: { value: isString },
    WildcardSingle: {},
  });

/** What a `bounded: true` boundary needs on top of the base shape. */
const BOUNDED_BOUNDARY: Readonly<Record<string, Check>> = Object.freeze({
  inclusive: isBool,
  value: isObject,
});

/**
 * What a literal's `value` must be, given its `literal` kind.
 *
 * Checking `literal` and `quoted` alone was not enough: a text literal with no
 * `value` reached `serialize` and threw a raw `TypeError` reading `.length`,
 * and the boolean and null variants serialized to the term `undefined` — which
 * is a valid query meaning something else entirely, so the round-trip law broke
 * silently. A truncated node is precisely the case this table exists for.
 */
const LITERAL_VALUE: Readonly<Record<string, Check>> = Object.freeze({
  boolean: isBool,
  null: (value: unknown) => value === null,
  text: isString,
});

/**
 * Check one node's own shape. Returns the offending property, or `null`.
 *
 * A node whose `type` this does not recognise passes: interior shapes we have no
 * table entry for are the business of whoever reads them, and refusing an
 * unknown `type` here would make adding a node type a breaking change for
 * anything already holding a tree.
 */
const shapeProblem = (node: object, type: string): string | null => {
  const required = NODE_SHAPES[type];

  if (required === undefined) {
    return null;
  }

  let checks: Readonly<Record<string, Check>> = required;

  if (type === 'RangeBoundary' && peek(node, 'bounded') === true) {
    checks = { ...required, ...BOUNDED_BOUNDARY };
  } else if (type === 'LiteralExpression') {
    const kind = peek(node, 'literal');
    const accepts = typeof kind === 'string' ? LITERAL_VALUE[kind] : undefined;

    if (accepts) {
      checks = { ...required, value: accepts };
    }
  }

  for (const [property, accepts] of Object.entries(checks)) {
    if (!accepts(peek(node, property))) {
      return property;
    }
  }

  // Every node carries a location; error rendering and highlight offsets read it.
  const location = peek(node, 'location');

  if (
    !isObject(location) ||
    typeof peek(location as object, 'start') !== 'number' ||
    typeof peek(location as object, 'end') !== 'number'
  ) {
    return 'location';
  }

  return null;
};

/**
 * Refuse a tree too deep, or too large when expanded, to walk.
 *
 * ITERATIVE, because a recursive depth check would overflow on exactly the input
 * it exists to refuse.
 *
 * Two budgets, because they catch different things and neither implies the other:
 *
 *  - DEPTH bounds a long chain, which is what exhausts the call stack in the
 *    recursive walks downstream (`prune`, `findRecovered`, `serializeNode`,
 *    `compileExpression`).
 *  - VISITS bounds the work. A shared subtree makes the number of PATHS
 *    exponential in the number of nodes, and every downstream walk is
 *    path-shaped: 49 nodes at depth 24 serialized to a 100 MB string, and 29
 *    nodes took this check itself 32 seconds. Depth saw nothing wrong with
 *    either, because nothing was.
 *
 * Together they also subsume the cycle check. A node that points back at an
 * ancestor produces unbounded paths, so it exhausts the visit budget and is
 * refused — no ancestor set required, and none of the risk that comes with
 * refusing a repeated object, which throws away
 * legitimate finite paths.
 *
 * Generic over properties rather than switching on `node.type`, because the point
 * is to protect walks that have not been written yet as much as the four that
 * exist. Property reads are GUARDED: `Object.values` invokes getters, so an AST
 * node backed by an accessor — a class instance, a reactive proxy — threw a raw
 * error out of `serialize()` for a tree shallow enough to print.
 *
 * One pass per QUERY, not per item: `filter` over 10,000 records validates once
 * and then compiles once.
 */
/**
 * The object-valued properties of a node, wherever they live.
 *
 * `Object.values` was the obvious choice and the wrong one: it sees only OWN
 * ENUMERABLE properties, so a node whose children are prototype accessors — a
 * class instance with private fields, which is exactly the "rehydrated AST"
 * this file's header names — walked as a single node with `visits === 1` and
 * `depth === 1`. Both budgets were bypassed, and a 60,000-deep tree of those
 * still threw a raw `RangeError` out of `prune`.
 *
 * So the prototype chain is walked too, and non-enumerable own properties are
 * included. Every read goes through `peek`, because on such a node reading a
 * property IS running consumer code.
 *
 * Stops at `Object.prototype`, so an ordinary parsed tree costs one
 * `getOwnPropertyNames` call per node and nothing more.
 */
const childrenOf = (node: object): object[] => {
  const names = new Set<string>();

  try {
    for (
      let current: object | null = node;
      current !== null && current !== Object.prototype;
      current = Object.getPrototypeOf(current) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(current)) {
        names.add(name);
      }
    }
  } catch {
    // A hostile getPrototypeOf or ownKeys trap. Whatever we already collected
    // is still worth checking; what we cannot see, we cannot walk.
  }

  const children: object[] = [];

  for (const name of names) {
    const child = peek(node, name);

    if (typeof child === 'object' && child !== null) {
      children.push(child);
    }
  }

  return children;
};

/**
 * Count a tree's expansion the way {@link assertWalkable} does, without throwing.
 *
 * Exported so `parse()` can refuse a query whose tree its own consumers would
 * reject. Nothing capped field-path or wildcard segment counts, so a 990 kB
 * query parsed happily and was then refused by serialize/filter/test/highlight
 * with an error whose text blames the caller for a tree `parse()` built.
 */
export const expansionOf = (root: SiftQLAst, budget: number): number => {
  const stack: object[] = [root];
  let visits = 0;

  while (stack.length > 0) {
    const node = stack.pop();

    if (node === undefined) {
      continue;
    }

    visits += 1;

    if (visits > budget) {
      return visits;
    }

    for (const child of childrenOf(node)) {
      stack.push(child);
    }
  }

  return visits;
};

const assertWalkable = (root: SiftQLAst, fn: string): void => {
  const stack: { readonly node: object; readonly depth: number }[] = [
    { depth: 0, node: root },
  ];

  let visits = 0;

  const refuse = (problem: string): never => {
    throw new SiftQLArgumentError(
      `${fn}() received an AST that is ${problem}. If you built this tree yourself or deserialized it, check for a node that points back at one of its own ancestors, or a subtree reachable by very many paths; if it came from parse(), the query exceeded what the parser is supposed to accept and this is a defect in siftql.`,
      { argument: 'node', received: root.type },
    );
  };

  while (stack.length > 0) {
    const frame = stack.pop();

    if (!frame) {
      break;
    }

    visits += 1;

    if (visits > MAX_AST_NODES) {
      refuse(`larger than ${String(MAX_AST_NODES)} nodes when expanded`);
    }

    if (frame.depth > MAX_AST_DEPTH) {
      refuse(`nested more than ${String(MAX_AST_DEPTH)} levels deep`);
    }

    const type = peek(frame.node, 'type');

    if (typeof type === 'string') {
      const problem = shapeProblem(frame.node, type);

      if (problem !== null) {
        throw new SiftQLArgumentError(
          `${fn}() received a malformed ${type} node: its "${problem}" property is missing or of the wrong kind. If this tree was deserialized, it may have been truncated; builders from siftql's \`builders\` export always produce complete nodes.`,
          { argument: 'node', received: type },
        );
      }
    }

    for (const child of childrenOf(frame.node)) {
      stack.push({ depth: frame.depth + 1, node: child });
    }
  }
};

export const assertNode = (value: unknown, fn: string): SiftQLAst => {
  if (!isSiftQLNode(value)) {
    const named =
      typeof value === 'object' && value !== null
        ? peek(value, 'type')
        : undefined;

    const hint =
      typeof named === 'string'
        ? ` "${named}" is not a known node type.`
        : ' Pass the result of parse().';

    throw new SiftQLArgumentError(
      `${fn}() expects a siftql AST node, received ${describeArgument(value)}.${hint}`,
      { argument: 'node', received: value },
    );
  }

  assertWalkable(value, fn);

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

/**
 * Every option the engine understands.
 *
 * Named once, so the snapshot below and the checks above cannot drift apart —
 * an option added to one and forgotten in the other is how a value reaches the
 * engine unvalidated.
 */
const KNOWN_OPTIONS = [
  'dateFormat',
  'id',
  'matchKeys',
  'maxPatternLength',
  'onRecovered',
  'onValueError',
  'parseDate',
  'regexGuard',
  'tolerant',
  'types',
  'typeStrategy',
] as const;

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

/**
 * A layout must be a non-empty string that actually compiles.
 *
 * Shape alone was not enough: `dateFormat: 'QQQQ'` and `dateFormat: []` both
 * built an engine and then either failed on whichever record first held a date,
 * or silently did nothing at all. A layout is a programming decision made once,
 * so it is checked once, here.
 */
const checkDateFormat = (value: unknown): void => {
  if (value === undefined) {
    return;
  }

  const formats = typeof value === 'string' ? [value] : value;

  if (!safeIsArray(formats)) {
    badOption('dateFormat', 'a format string or an array of them', value);

    return;
  }

  if (formats.length === 0) {
    badOption(
      'dateFormat',
      'at least one format string (an empty array declares nothing and silently has no effect)',
      value,
    );
  }

  for (const format of formats) {
    if (typeof format !== 'string' || format.length === 0) {
      badOption(
        'dateFormat',
        'a format string or an array of them (no empty strings)',
        format,
      );
    }

    // Throws SiftQLDateFormatError, itself a SiftQLConfigError, naming the
    // offending layout and why it could not be read.
    assertValidFormat(format as string);
  }
};

const checkTypes = (value: unknown): void => {
  if (value === undefined) {
    return;
  }

  if (!safeIsArray(value)) {
    const hint =
      typeof value === 'object' && value !== null
        ? ' It is an array, not a name-keyed object: types: [myType].'
        : '';

    throw new SiftQLConfigError(
      `options.types must be an array of value types or factories, received ${describeArgument(value)}.${hint}`,
    );
  }

  for (const [index, input] of value.entries()) {
    if (typeof input === 'function') {
      // A factory. It runs during createRegistry, where a throw is wrapped.
      continue;
    }

    const name =
      typeof input === 'object' && input !== null
        ? peek(input, 'name')
        : undefined;

    if (typeof name !== 'string' || name.length === 0) {
      throw new SiftQLConfigError(
        `options.types[${String(index)}] must be a value type with a non-empty string name, or a factory returning one; received ${describeArgument(input)}.`,
      );
    }

    // `matches` and `ordering` are optional; `equals` is not — `:` falls back
    // to it, so a type without it cannot answer the most common operator.
    for (const method of ['parseOperand', 'coerceValue', 'equals'] as const) {
      if (typeof peek(input as object, method) !== 'function') {
        throw new SiftQLConfigError(
          `options.types[${String(index)}] ("${name}") is missing ${method}(). A value type needs parseOperand, coerceValue and equals.`,
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
export const assertOptions = (value: unknown, fn: string): EngineOptions => {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== 'object' || value === null || safeIsArray(value)) {
    throw new SiftQLArgumentError(
      `${fn}() expects an options object, received ${describeArgument(value)}.`,
      { argument: 'options', received: value },
    );
  }

  /*
   * An option may be an accessor, and a throwing one must produce a CONFIG
   * ERROR — not escape raw, and not silently vanish.
   *
   * Swallowing the throw and returning `undefined` would let the default win,
   * so an engine built from a lazily-computed or proxy-backed config object
   * silently gets default policy — including `onValueError`. A silent default
   * for the FAILURE policy is the quiet wrongness this validator exists to
   * prevent.
   */
  const read = (key: string): unknown => {
    try {
      return (value as Record<string, unknown>)[key];
    } catch (error) {
      throw new SiftQLConfigError(
        `${fn}() could not read the "${key}" option: reading it threw. An option must be a plain value, not an accessor that fails.`,
        { cause: error },
      );
    }
  };

  /**
   * Copy an array-valued option, once, behind the same guard as `read`.
   *
   * `dateFormat` and `types` are the two options the checks below ITERATE, and
   * iterating the caller's array reaches element accessors that `read` never
   * saw: an array whose index getter throws escaped as a raw `Error`, and one
   * whose index getter answered twice was validated on the first answer and
   * kept on the second, so a layout `assertValidFormat` would have refused
   * reached the engine and failed on the first record holding a date.
   *
   * The elements themselves are still the caller's objects. A value type is an
   * object of methods that only `createRegistry` can meaningfully copy, so this
   * guarantees the ARRAY is stable, not that every type in it is.
   */
  const copyArray = (key: string, raw: unknown): unknown => {
    if (!safeIsArray(raw)) {
      return raw;
    }

    try {
      return Object.freeze([...raw]);
    } catch (error) {
      throw new SiftQLConfigError(
        `${fn}() could not read the "${key}" option: reading it threw. An option must be a plain value, not an accessor that fails.`,
        { cause: error },
      );
    }
  };

  /*
   * ONE read per option, before any of it is inspected.
   *
   * Reading twice — once to validate, once to build the snapshot — gave an
   * accessor two chances to answer and checked only the first, so a getter
   * returning `'throw'` then `'garbage'` put `'garbage'` in the engine. Every
   * check below and the snapshot both work from this map.
   *
   * The read is UNCONDITIONAL. Gating it on a presence test meant an options
   * object whose `in` failed or lied never reached `read`'s guard at all, and
   * an unreadable config silently became an all-defaults engine — including a
   * silent `onValueError`, which is the exact quiet wrongness this validator
   * exists to prevent.
   *
   * An `undefined` value is then OMITTED, so `{ tolerant: undefined }` and an
   * omitted `tolerant` mean the same thing: leave it alone. `engine.extend()`
   * merges `{ ...parent, ...child }`, so keeping the key would let the ordinary
   * act of spreading a partial config blank an option the caller never
   * mentioned — dropping `onValueError: 'throw'` to `'skip'`, or losing the
   * parent's custom value types.
   */
  const values = new Map<string, unknown>();

  for (const key of KNOWN_OPTIONS) {
    const supplied = copyArray(key, read(key));

    if (supplied !== undefined) {
      values.set(key, supplied);
    }
  }

  const once = (key: string): unknown => values.get(key);

  checkBoolean('tolerant', once('tolerant'));
  checkBoolean('matchKeys', once('matchKeys'));
  checkBoolean('regexGuard', once('regexGuard'));
  checkEnum('onValueError', once('onValueError'), ON_VALUE_ERROR);
  checkEnum('onRecovered', once('onRecovered'), ON_RECOVERED);
  checkEnum('typeStrategy', once('typeStrategy'), TYPE_STRATEGY);
  checkDateFormat(once('dateFormat'));

  const id = once('id');

  if (id !== undefined && typeof id !== 'string') {
    badOption('id', 'a string', id);
  }

  const parseDate = once('parseDate');

  if (parseDate !== undefined && typeof parseDate !== 'function') {
    badOption('parseDate', 'a function', parseDate);
  }

  const length = once('maxPatternLength');

  if (
    length !== undefined &&
    (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1)
  ) {
    badOption('maxPatternLength', 'a positive integer', length);
  }

  checkTypes(once('types'));

  /*
   * A SNAPSHOT, not the caller's object.
   *
   * Validating in place and then handing the original back was not enough:
   * `parse` went on to read `options.tolerant`, and `contextFor` to read
   * `options.matchKeys`, so an option implemented as a throwing accessor passed
   * validation and then escaped raw from the code that used it. The values come
   * from the single read pass above, not from the caller's object — after this
   * the engine is reading plain data and cannot be surprised.
   *
   * ABSENT KEYS ARE OMITTED, not copied as `undefined`, and that distinction is
   * load-bearing. Including them made the snapshot a complete object, so
   * `engine.extend()` — which merges `{ ...parent, ...child }` — overwrote every
   * option the caller had not restated with `undefined`. An extended engine
   * would silently lose `matchKeys`, drop `onValueError: 'throw'` to `'skip'`, and
   * dropped its custom value types, against a documented contract that says
   * "merged over this one's". Nothing in 690 tests noticed.
   *
   * Unknown keys are dropped rather than copied. They were already documented as
   * accepted-and-ignored, and carrying an arbitrary accessor forward would
   * reintroduce exactly the hazard this closes.
   */
  const snapshot: EngineOptions = {};

  for (const [key, value_] of values) {
    // Index through a widened view: the keys are known, the values are not
    // yet narrowed, and every one has been checked above.
    (snapshot as Record<string, unknown>)[key] = value_;
  }

  return snapshot;
};
