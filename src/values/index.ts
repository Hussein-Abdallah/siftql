import {
  BUILTIN_TYPE_ORDER,
  type ValueTypeInput,
  type BuiltinTypeName,
} from '../registry.js';
import { createDatetimeType } from './datetime.js';
import { regexType, wildcardType } from './patterns.js';
import { booleanType, nullType, numberType, stringType } from './scalars.js';

/**
 * The built-in types, in resolution order.
 *
 * The order is part of the documented contract, and every position is forced:
 *
 *   regex, null, boolean, wildcard  token-gated; they claim one AST node kind
 *                                   each and can never collide with anything.
 *   datetime                        before `number`, so `2020-06-01` is a date.
 *                                   It declines anything not SHAPED like a date,
 *                                   so `height:>1000` still reaches `number`.
 *   number                          before `string`, so `height:100` is numeric.
 *   string                          last, because it claims every text operand.
 *                                   Anything after it would be unreachable.
 */
/**
 * Freeze a value type, and the `ordering` object hanging off it.
 *
 * The stateless built-ins are module-level singletons, so every engine in the
 * process shares the same objects — and `ValueTypeRegistry.get` is public, and
 * `ctx.lookup` is the documented way for one type to delegate to another. That
 * made a one-line mutation global:
 *
 *     const a = createEngine(), b = createEngine();
 *     (a.types.get('number') as any).equals = () => true;
 *     b.test('age:999', { age: 1 });   // true
 *
 * `engine/registry.ts` promises the opposite in as many words — that a
 * module-level registration "would let one library's custom type silently change
 * how an unrelated library in the same process reads a query" — and freezing the
 * type ARRAY, which it already did, protects the order and not the types.
 *
 * Freezing rather than instantiating per engine: these types hold no state, so
 * copies would cost allocations to defend against a hazard that immutability
 * removes outright. `ordering` is frozen too, or `type.ordering.compare` stays
 * writable and nothing is gained.
 *
 * Only the BUILT-INS are frozen. A consumer's own type object is theirs, and
 * freezing it would be a side effect on their data — a type that lazily caches
 * on itself is unusual but legitimate.
 */
const sealType = <T extends object>(type: T): T => {
  const ordering = (type as { ordering?: object }).ordering;

  if (ordering) {
    Object.freeze(ordering);
  }

  return Object.freeze(type);
};

const BUILTINS: Readonly<Record<BuiltinTypeName, ValueTypeInput>> =
  Object.freeze({
    boolean: sealType(booleanType),
    // A FACTORY: it closes over this engine's dateFormat/parseDate, so its
    // product is per-engine already and is frozen as it is produced.
    datetime: (environment: Parameters<typeof createDatetimeType>[0]) =>
      sealType(createDatetimeType(environment)),
    null: sealType(nullType),
    number: sealType(numberType),
    regex: sealType(regexType),
    string: sealType(stringType),
    wildcard: sealType(wildcardType),
  });

/** The built-in types as registry inputs, in {@link BUILTIN_TYPE_ORDER}. */
export const builtinValueTypes = (): readonly ValueTypeInput[] =>
  BUILTIN_TYPE_ORDER.map((name) => BUILTINS[name]);

export { createDatetimeType } from './datetime.js';
export {
  compileWildcard,
  matchGlob,
  regexType,
  wildcardType,
  type CompiledPattern,
  type CompiledWildcard,
} from './patterns.js';
export {
  booleanType,
  nullType,
  numberType,
  stringType,
  type StringOperand,
} from './scalars.js';
