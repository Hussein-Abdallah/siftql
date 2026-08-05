/**
 * siftql — a complete, extensible Lucene-like query language.
 *
 * Public entry point. Every AST type exported here is a documented public
 * contract: changing an exported node shape is a breaking change.
 */

/** Package version, kept in sync with package.json at release time. */
export const VERSION = '0.1.0';

export { parse, type ParseOptions } from './parser/parser.js';
export { serialize } from './serialize.js';
export {
  createEngine,
  filter,
  highlight,
  test,
  type Engine,
} from './engine/create.js';
export { createRegistry } from './engine/registry.js';
export {
  builtinValueTypes,
  booleanType,
  createDatetimeType,
  nullType,
  numberType,
  regexType,
  stringType,
  wildcardType,
} from './values/index.js';

export {
  isSiftQLError,
  SiftQLConfigError,
  SiftQLError,
  SiftQLOperandError,
  SiftQLRecoveredQueryError,
  SiftQLSyntaxError,
  SiftQLValueError,
  type SiftQLErrorCode,
  type SourceLocation,
} from './errors.js';

export {
  detectTemporalFormat,
  resolveTemporal,
  type ParseDateHook,
  type TemporalOptions,
} from './temporal/index.js';

export {
  BUILTIN_TYPE_ORDER,
  claimed,
  DECLINED,
  defineValueType,
  malformedOperand,
  malformedValue,
  MISS,
  resolved,
  type AnyValueType,
  type EngineOptions,
  type EvaluateOptions,
  type Highlight,
  type OperandContext,
  type OperandToken,
  type ValueContext,
  type ValueType,
  type ValueTypeInput,
  type ValueTypeRegistry,
} from './registry.js';

export * from './types.js';
