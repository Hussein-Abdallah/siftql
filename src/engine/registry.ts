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

const resolveInput = (
  input: ValueTypeInput,
  environment: TypeEnvironment,
): AnyValueType => (typeof input === 'function' ? input(environment) : input);

const assertUniqueNames = (types: readonly AnyValueType[]): void => {
  const seen = new Set<string>();

  for (const type of types) {
    if (typeof type.name !== 'string' || type.name.length === 0) {
      throw new SiftQLConfigError('Every value type must have a name');
    }

    if (seen.has(type.name)) {
      throw new SiftQLConfigError(
        `Duplicate value type name "${type.name}". Names must be unique within an engine; use \`typeStrategy: 'replace'\` to substitute a built-in.`,
      );
    }

    seen.add(type.name);
  }
};

class Registry implements ValueTypeRegistry {
  public readonly types: readonly AnyValueType[];

  private readonly byName: ReadonlyMap<string, AnyValueType>;

  private readonly options: ResolvedEngineOptions;

  private readonly builtinNames: ReadonlySet<string>;

  public constructor(
    types: readonly AnyValueType[],
    options: ResolvedEngineOptions,
    builtinNames: ReadonlySet<string>,
  ) {
    assertUniqueNames(types);

    this.types = Object.freeze([...types]);
    this.byName = new Map(types.map((type) => [type.name, type]));
    this.options = options;
    this.builtinNames = builtinNames;
  }

  public get(name: string): AnyValueType | undefined {
    return this.byName.get(name);
  }

  public describe(): readonly TypeDescriptor[] {
    return this.types.map((type) => ({
      builtin: this.builtinNames.has(type.name),
      name: type.name,
      // A type is ordered if and only if it has an `ordering` object. That
      // absence is the single fact behind `name:>="m"` throwing.
      ordered: type.ordering !== undefined,
    }));
  }

  public with(
    inputs: readonly ValueTypeInput[],
    strategy: TypeStrategy = 'prepend',
  ): ValueTypeRegistry {
    const environment = makeEnvironment(this.options, () => next);
    const added = inputs.map((input) => resolveInput(input, environment));

    const combined =
      strategy === 'replace'
        ? added
        : strategy === 'append'
          ? [...this.types, ...added]
          : // Prepend by default, so a consumer's `semver` claims `1.2.3`
            // before `number` ever sees it.
            [...added, ...this.types];

    const next: ValueTypeRegistry = new Registry(
      combined,
      this.options,
      this.builtinNames,
    );

    return next;
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
  options,
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
  const builtinNames = new Set(builtins.map((type) => type.name));

  const added = inputs.map((input) => resolveInput(input, environment));

  const combined =
    strategy === 'replace'
      ? added
      : strategy === 'append'
        ? [...builtins, ...added]
        : [...added, ...builtins];

  box.registry = new Registry(combined, options, builtinNames);

  return box.registry;
};
