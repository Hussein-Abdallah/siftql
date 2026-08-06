/**
 * siftql — a complete, extensible Lucene-like query language.
 *
 * Public entry point. Every AST type exported here is a documented public
 * contract: changing an exported node shape is a breaking change.
 */

/** Package version, kept in sync with package.json at release time. */
export const VERSION = '0.1.0';

export { parse, type ParseOptions } from './parser/parser.js';
export {
  MAX_AST_DEPTH,
  MAX_AST_NODES,
  MAX_CLAUSES,
  MAX_DEPTH,
  MAX_FIELD_SEGMENTS,
  MAX_WILDCARD_SEGMENTS,
} from './limits.js';
export { serialize } from './serialize.js';
export { builders } from './builders.js';
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
  SiftQLArgumentError,
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
  SiftQLDateFormatError,
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
