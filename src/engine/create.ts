import { parse, type ParseOptions } from '../parser/parser.js';
import type {
  EngineOptions,
  EvaluateOptions,
  ResolvedEngineOptions,
  ValueTypeRegistry,
} from '../registry.js';
import type { SiftQLAst } from '../types.js';
import { compileExpression, type EvaluationContext } from './evaluate.js';
import { createRegistry } from './registry.js';

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

const resolveOptions = (options: EngineOptions): ResolvedEngineOptions => ({
  id: options.id ?? 'default',
  matchKeys: options.matchKeys ?? false,
  onRecovered: options.onRecovered ?? 'prune',
  // Default 'skip': one dirty row must not be able to destroy an entire
  // result set. A bad QUERY still always throws; that is not configurable.
  onValueError: options.onValueError ?? 'skip',
  temporal: {
    dateFormat: options.dateFormat,
    parseDate: options.parseDate,
  },
  tolerant: options.tolerant ?? false,
});

export interface Engine {
  readonly options: ResolvedEngineOptions;
  readonly types: ValueTypeRegistry;
  parse(query: string, options?: ParseOptions): SiftQLAst;
  test(
    query: SiftQLAst | string,
    item: unknown,
    options?: EvaluateOptions,
  ): boolean;
  filter<T>(
    query: SiftQLAst | string,
    items: readonly T[],
    options?: EvaluateOptions,
  ): T[];
  /** A new engine with additional options merged over this one's. */
  extend(options: EngineOptions): Engine;
}

export const createEngine = (options: EngineOptions = {}): Engine => {
  const resolved = resolveOptions(options);
  const registry = createRegistry(
    resolved,
    options.types ?? [],
    options.typeStrategy ?? 'prepend',
  );

  const contextFor = (overrides: EvaluateOptions = {}): EvaluationContext => ({
    options: {
      ...resolved,
      matchKeys: overrides.matchKeys ?? resolved.matchKeys,
      onRecovered: overrides.onRecovered ?? resolved.onRecovered,
      onValueError: overrides.onValueError ?? resolved.onValueError,
    },
    registry,
  });

  const toAst = (query: SiftQLAst | string): SiftQLAst =>
    typeof query === 'string'
      ? parse(query, { tolerant: resolved.tolerant })
      : query;

  return {
    extend: (extra) => createEngine({ ...options, ...extra }),

    filter: <T>(
      query: SiftQLAst | string,
      items: readonly T[],
      overrides: EvaluateOptions = {},
    ): T[] => {
      // Compiled ONCE, not per item: a filter over 10,000 rows resolves the
      // operand a single time, and a bad query throws immediately rather than
      // on whichever row first reaches it.
      const predicate = compileExpression(toAst(query), contextFor(overrides));

      return items.filter((item) => predicate(item));
    },

    options: resolved,

    parse: (query, parseOptions) =>
      parse(query, { tolerant: resolved.tolerant, ...parseOptions }),

    test: (query, item, overrides = {}) =>
      compileExpression(toAst(query), contextFor(overrides))(item),

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
