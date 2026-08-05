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
  type ResolvedTemporal,
  type TemporalDomain,
  type TemporalKind,
  type TemporalOptions,
} from './temporal/index.js';

/**
 * The whole registry surface. A consumer writing a custom value type has to be
 * able to name the types their own signature mentions -- OperandContext,
 * ResolvedEngineOptions, ValueResult and the rest -- so these are exported
 * wholesale rather than hand-picked, which is how several of them came to be
 * unreachable in the first place.
 */
export * from './registry.js';

export * from './types.js';
