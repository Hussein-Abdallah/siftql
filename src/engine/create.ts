import { isSiftQLError, SiftQLArgumentError } from '../errors.js';
import { parse, type ParseOptions } from '../parser/parser.js';
import type {
  EngineOptions,
  EvaluateOptions,
  Highlight,
  ResolvedEngineOptions,
  ValueTypeRegistry,
} from '../registry.js';
import type { SiftQLAst } from '../types.js';
import { compileExpression, type EvaluationContext } from './evaluate.js';
import { applyRecoveryPolicy } from './prune.js';
import { HighlightSink } from './highlight.js';
import { createRegistry } from './registry.js';
import {
  assertItems,
  assertOptions,
  assertQuery,
  assertNode,
} from '../validate.js';

/**
 * Engines.
 *
 * `createEngine` is the primary API and the top-level `filter`/`test` are a
 * convenience over a default engine. That is not cosmetic: an engine owns its
 * own type registry, so a library using siftql internally and an application
 * using it in the same process cannot see each other's custom types — and
 * `datetime` can close over this engine's `dateFormat`/`parseDate`, which a
 * global registry could never express.
 */

/**
 * FROZEN, and deeply.
 *
 * This object is handed to every value type on every candidate, through
 * `ValueContext.options`. `readonly` in the type does not survive to runtime, so
 * without this a custom type could set `ctx.options.onValueError = 'skip'` on the
 * first record and silently relax the failure policy for the rest of the filter —
 * an engine-wide setting rewritten from inside a per-value callback.
 */
const resolveOptions = (options: EngineOptions): ResolvedEngineOptions =>
  Object.freeze({
    id: options.id ?? 'default',
    matchKeys: options.matchKeys ?? false,
    maxPatternLength: options.maxPatternLength ?? 1000,
    onRecovered: options.onRecovered ?? 'prune',
    // Default 'skip': one dirty row must not be able to destroy an entire
    // result set. A bad QUERY still always throws; that is not configurable.
    onValueError: options.onValueError ?? 'skip',
    // On by default: a search box is usually fed by whoever is looking at it.
    regexGuard: options.regexGuard ?? true,
    temporal: Object.freeze({
      dateFormat:
        typeof options.dateFormat === 'object'
          ? Object.freeze([...options.dateFormat])
          : options.dateFormat,
      parseDate: options.parseDate,
    }),
    tolerant: options.tolerant ?? false,
  });

/**
 * Run the predicate over the corpus, converting a hostile array-like into a
 * named error.
 *
 * `Array.isArray` accepts a Proxy wrapping an array, and iterating one runs the
 * caller's traps — so `items.filter(...)` could throw a raw error even after the
 * argument had been validated. Nothing is copied: guarding the ITERATION rather
 * than snapshotting the data keeps `filter` allocation-free for the ordinary
 * case, which is every case that is not deliberately adversarial.
 */
const sift = (
  items: readonly unknown[],
  predicate: (item: unknown, sink: null) => boolean,
): unknown[] => {
  try {
    return items.filter((item) => predicate(item, null));
  } catch (error) {
    // A SiftQLError from the predicate is the engine reporting a real failure and
    // must pass through untouched; anything else came from reading the array.
    if (isSiftQLError(error)) {
      throw error;
    }

    throw new SiftQLArgumentError(
      `Reading the items array threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { argument: 'items', received: items },
    );
  }
};

export interface Engine {
  readonly options: ResolvedEngineOptions;
  readonly types: ValueTypeRegistry;
  parse(query: string, options?: ParseOptions): SiftQLAst;
  test(
    query: SiftQLAst | string,
    item: unknown,
    options?: EvaluateOptions,
  ): boolean;
  /**
   * Which fields made `item` match, and what to light up inside each.
   *
   * Returns an empty array when the item does not match at all. Highlights from
   * the losing branch of an OR, and from everything under a satisfied NOT, are
   * discarded -- a highlight survives only if the clause that produced it is
   * part of the reason the record matched.
   */
  highlight(
    query: SiftQLAst | string,
    item: unknown,
    options?: EvaluateOptions,
  ): Highlight[];
  filter<T>(
    query: SiftQLAst | string,
    items: readonly T[],
    options?: EvaluateOptions,
  ): T[];
  /** A new engine with additional options merged over this one's. */
  extend(options: EngineOptions): Engine;
}

export const createEngine = (options: EngineOptions = {}): Engine => {
  // Eagerly, before anything closes over it: a malformed `dateFormat` must be a
  // createEngine() failure, not a surprise on whichever record first holds a
  // date.
  assertOptions(options, 'createEngine');

  const resolved = resolveOptions(options);
  const registry = createRegistry(
    resolved,
    options.types ?? [],
    options.typeStrategy ?? 'prepend',
  );

  const contextFor = (overrides: EvaluateOptions): EvaluationContext => ({
    // Frozen for the same reason `resolved` is: per-call overrides produce a new
    // options object, and it reaches value types just as the engine's own does.
    options: Object.freeze({
      ...resolved,
      matchKeys: overrides.matchKeys ?? resolved.matchKeys,
      maxPatternLength: overrides.maxPatternLength ?? resolved.maxPatternLength,
      onRecovered: overrides.onRecovered ?? resolved.onRecovered,
      onValueError: overrides.onValueError ?? resolved.onValueError,
      regexGuard: overrides.regexGuard ?? resolved.regexGuard,
    }),
    registry,
  });

  /**
   * Parse if needed, then apply the recovery policy. Tolerant-mode holes are
   * pruned (or the query refused) BEFORE compilation, so the evaluator never
   * has to invent a meaning for a clause the user is still typing.
   */
  const toAst = (
    query: SiftQLAst | string,
    fn: string,
    overrides: EvaluateOptions,
  ): SiftQLAst =>
    applyRecoveryPolicy(
      // Checked whether it was PARSED or handed to us. The parser's own caps are
      // supposed to make a parsed tree shallow enough to walk, and a bug that
      // lets one slip past them must not surface as a raw RangeError from
      // whichever helper was on the stack — `applyRecoveryPolicy` recurses
      // before the evaluator's own counter ever runs, so checking only the
      // hand-built path left that gap open.
      assertNode(
        typeof query === 'string'
          ? parse(query, { tolerant: resolved.tolerant })
          : query,
        fn,
      ),
      overrides.onRecovered ?? resolved.onRecovered,
    );

  return {
    extend: (extra) =>
      createEngine({ ...options, ...assertOptions(extra, 'engine.extend') }),

    filter: <T>(
      query: SiftQLAst | string,
      items: readonly T[],
      overrides: EvaluateOptions = {},
    ): T[] => {
      // Compiled ONCE, not per item: a filter over 10,000 rows resolves the
      // operand a single time, and a bad query throws immediately rather than
      // on whichever row first reaches it.
      const checked = assertOptions(overrides, 'filter');
      const predicate = compileExpression(
        toAst(query, 'filter', checked),
        contextFor(checked),
      );

      return sift(assertItems(items, 'filter'), predicate) as T[];
    },

    highlight: (query, item, overrides = {}) => {
      const sink = new HighlightSink();
      // `overrides` must reach toAst, not just contextFor: toAst is where the
      // recovery policy is applied, so omitting it made highlight() ignore a
      // per-call onRecovered that filter() and test() both honoured.
      const checked = assertOptions(overrides, 'highlight');
      const matched = compileExpression(
        toAst(query, 'highlight', checked),
        contextFor(checked),
      )(item, sink);

      return matched ? sink.drain() : [];
    },

    options: resolved,

    parse: (query, parseOptions) => {
      const checked = assertOptions(parseOptions, 'engine.parse');

      return parse(assertQuery(query, 'engine.parse'), {
        tolerant: checked.tolerant ?? resolved.tolerant,
      });
    },

    test: (query, item, overrides = {}) => {
      const checked = assertOptions(overrides, 'test');

      return compileExpression(
        toAst(query, 'test', checked),
        contextFor(checked),
      )(item, null);
    },

    types: registry,
  };
};

/** Lazily created so importing siftql costs nothing until a query is run. */
let defaultEngine: Engine | undefined;

const engine = (): Engine => (defaultEngine ??= createEngine());

/** Does `item` satisfy the query? */
export const test = (
  query: SiftQLAst | string,
  item: unknown,
  options?: EvaluateOptions,
): boolean => engine().test(query, item, options);

/** Every item satisfying the query, in input order. */
export const filter = <T>(
  query: SiftQLAst | string,
  items: readonly T[],
  options?: EvaluateOptions,
): T[] => engine().filter(query, items, options);

/** Which fields made `item` match, and what to light up inside each. */
export const highlight = (
  query: SiftQLAst | string,
  item: unknown,
  options?: EvaluateOptions,
): Highlight[] => engine().highlight(query, item, options);
