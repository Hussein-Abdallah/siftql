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
  defineValueType,
  type ValueType,
} from './registry.js';

export * from './types.js';
