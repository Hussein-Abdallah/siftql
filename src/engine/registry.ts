import { withoutFailurePolicy } from '../registry.js';
import { nameOf, readOrdering, rememberName, resolveTypeInput } from './consumer.js';
import { SiftQLConfigError } from '../errors.js';
import type {
  AnyValueType,
  ResolvedEngineOptions,
  TypeDescriptor,
  TypeEnvironment,
  TypeStrategy,
  ValueTypeInput,
  ValueTypeRegistry,
} from '../registry.js';
import { builtinValueTypes } from '../values/index.js';

/**
 * A per-engine, immutable, ordered registry.
 *
 * RESOLUTION ORDER IS ARRAY ORDER and the first type that does not decline wins.
 * There are no priority numbers to tie or to fight over across packages: a
 * consumer states precedence by writing the list.
 *
 * The registry is PER ENGINE rather than global. A module-level `registerType()`
 * would let one library's custom type silently change how an unrelated library
 * in the same process reads a query — and it could not express `datetime`, which
 * has to close over this engine's `dateFormat` and `parseDate`.
 *
 * There is no mutation API at any level. `with()` returns a new registry.
 */

/**
 * A factory that throws, or returns something that is not a value type, is a
 * CONFIG failure — see `./consumer.ts` for why each callback is routed the way
 * it is.
 */
const resolveInput = resolveTypeInput;

const assertUniqueNames = (types: readonly AnyValueType[]): void => {
  const seen = new Set<string>();

  for (const type of types) {
    // Read ONCE, inside a guard, and remembered — every later read of this
    // type's name anywhere in the package is then a WeakMap hit that cannot run
    // consumer code. Reading it raw here would defeat the point.
    let name: unknown;

    try {
      name = type.name;
    } catch (error) {
      throw new SiftQLConfigError(
        'Reading a value type\'s name threw. A name must be a plain string.',
        { cause: error },
      );
    }

    if (typeof name !== 'string' || name.length === 0) {
      throw new SiftQLConfigError('Every value type must have a name');
    }

    if (seen.has(name)) {
      throw new SiftQLConfigError(
        `Duplicate value type name "${name}". Names must be unique within an engine; use \`typeStrategy: 'replace'\` to substitute a built-in.`,
      );
    }

    seen.add(name);
    rememberName(type, name);
  }
};

class Registry implements ValueTypeRegistry {
  public readonly types: readonly AnyValueType[];

  private readonly byName: ReadonlyMap<string, AnyValueType>;

  private readonly options: ResolvedEngineOptions;

  /**
   * The built-in type OBJECTS, not their names. A user type registered with
   * `typeStrategy: 'replace'` may legitimately be called `number`, and matching
   * on the name would then label it a built-in when no built-in is present.
   */
  private readonly builtins: ReadonlySet<AnyValueType>;

  public constructor(
    types: readonly AnyValueType[],
    options: ResolvedEngineOptions,
    builtins: ReadonlySet<AnyValueType>,
  ) {
    assertUniqueNames(types);

    this.types = Object.freeze([...types]);
    this.byName = new Map(types.map((type) => [nameOf(type), type]));
    this.options = options;
    this.builtins = builtins;
  }

  public get(name: string): AnyValueType | undefined {
    return this.byName.get(name);
  }

  public describe(): readonly TypeDescriptor[] {
    return this.types.map((type) => ({
      builtin: this.builtins.has(type),
      name: nameOf(type),
      // A type is ordered if and only if it has a WELL-FORMED `ordering` — an
      // object carrying a callable `compare`. One without is a broken type and
      // `readOrdering` refuses it rather than reporting either answer. That
      // absence is the single fact behind `name:>="m"` throwing.
      ordered: readOrdering(type) !== undefined,
    }));
  }

  public with(
    inputs: readonly ValueTypeInput[],
    strategy: TypeStrategy = 'prepend',
  ): ValueTypeRegistry {
    // A box rather than a closure over `const next`: factories run BEFORE the
    // new registry exists, and one calling env.lookup() eagerly would escape a
    // raw TDZ ReferenceError out of a documented public method. The contract
    // says lookup may return undefined; it must not explode.
    const box: { registry?: ValueTypeRegistry } = {};
    const environment = makeEnvironment(this.options, () => box.registry);
    const added = inputs.map((input) => resolveInput(input, environment));

    const combined =
      strategy === 'replace'
        ? added
        : strategy === 'append'
          ? [...this.types, ...added]
          : // Prepend by default, so a consumer's `semver` claims `1.2.3`
            // before `number` ever sees it.
            [...added, ...this.types];

    box.registry = new Registry(combined, this.options, this.builtins);

    return box.registry;
  }
}

/**
 * Build the environment handed to type factories.
 *
 * `lookup` is lazy so a factory may reference a peer declared after it — the
 * registry it will belong to does not exist yet at the moment the factory runs.
 */
const makeEnvironment = (
  options: ResolvedEngineOptions,
  registry: () => ValueTypeRegistry | undefined,
): TypeEnvironment => ({
  lookup: (name) => registry()?.get(name),
  // Narrowed for the same reason the per-value contexts are: a FACTORY runs
  // consumer code too, and could otherwise close over the failure policy and
  // branch on it for the engine's whole lifetime.
  options: withoutFailurePolicy(options),
  temporal: options.temporal,
});

/**
 * Create a registry: the built-ins, plus any consumer types placed according to
 * `strategy`.
 */
export const createRegistry = (
  options: ResolvedEngineOptions,
  inputs: readonly ValueTypeInput[] = [],
  strategy: TypeStrategy = 'prepend',
): ValueTypeRegistry => {
  // Assigned after the built-ins resolve, so factories get a lazy lookup into
  // the registry they are about to belong to.
  const box: { registry?: ValueTypeRegistry } = {};
  const environment = makeEnvironment(options, () => box.registry);
  const builtins = builtinValueTypes().map((input) =>
    resolveInput(input, environment),
  );
  const builtinSet = new Set(builtins);

  const added = inputs.map((input) => resolveInput(input, environment));

  const combined =
    strategy === 'replace'
      ? added
      : strategy === 'append'
        ? [...builtins, ...added]
        : [...added, ...builtins];

  box.registry = new Registry(combined, options, builtinSet);

  return box.registry;
};
