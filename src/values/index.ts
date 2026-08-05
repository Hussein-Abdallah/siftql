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
const BUILTINS: Readonly<Record<BuiltinTypeName, ValueTypeInput>> =
  Object.freeze({
    boolean: booleanType,
    datetime: createDatetimeType,
    null: nullType,
    number: numberType,
    regex: regexType,
    string: stringType,
    wildcard: wildcardType,
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
