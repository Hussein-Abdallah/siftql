import { SiftQLOperandError, signalValueFailure } from '../errors.js';
import type {
  AnyValueType,
  OperandSite,
  OperandToken,
  ResolvedEngineOptions,
  ValueContext,
  ValueTypeRegistry,
} from '../registry.js';
import type {
  Expression,
  Field,
  RangeBoundary,
  SiftQLAst,
  TextLiteral,
} from '../types.js';
import { fieldPath } from '../types.js';
import {
  allLeafValues,
  formatPath,
  valuesAtPath,
  type Candidate,
} from './access.js';
import type { HighlightSink } from './highlight.js';

/**
 * Evaluation.
 *
 * The load-bearing property: there is NO per-type logic here. Matching,
 * ordering and range evaluation all go through the registry, so `datetime` is
 * reached by exactly the same code path as a consumer's `semver`. Grep this file
 * for "date" and you will find nothing.
 *
 * Range evaluation in particular is implemented ONCE, on top of `compare` plus
 * per-boundary inclusivity, so no value type ever writes range code.
 */

/**
 * A compiled clause.
 *
 * The sink is threaded through matching rather than bolted on as a second walk,
 * so `filter` and `highlight` can never disagree about what matched. When it is
 * `null` — the `filter`/`test` path — the branches short-circuit exactly as
 * before and the only cost is a null check.
 */
export type Predicate = (item: unknown, sink: HighlightSink | null) => boolean;

/** A query operand, resolved to the type that claimed it. */
interface BoundOperand {
  readonly type: AnyValueType;
  readonly operand: unknown;
}

export interface EvaluationContext {
  readonly options: ResolvedEngineOptions;
  readonly registry: ValueTypeRegistry;
}

/** Normalised view of an AST leaf, so a type never destructures AST internals. */
const toOperandToken = (node: Expression): OperandToken | null => {
  switch (node.type) {
    case 'LiteralExpression':
      switch (node.literal) {
        case 'boolean':
          return { kind: 'boolean', node, value: node.value };
        case 'null':
          return { kind: 'null', node };
        default:
          return {
            kind: 'text',
            node,
            quoted: node.quoted,
            text: node.value,
          };
      }
    case 'RegexExpression':
      return {
        flags: node.flags,
        kind: 'regex',
        node,
        source: node.pattern,
      };
    case 'WildcardExpression':
      return { kind: 'wildcard', node, pattern: node.pattern };
    default:
      return null;
  }
};

/**
 * Walk the registry in order; the first type that does not decline wins.
 *
 * An `invalid` result STOPS resolution rather than continuing, which is what
 * turns `date:>=2021-02-29` into "not a real date" instead of the useless
 * "nothing claimed this" you would get by letting it fall through to `string`.
 */
const resolveOperand = (
  token: OperandToken,
  site: OperandSite,
  caseSensitive: boolean,
  context: EvaluationContext,
  location: { readonly start: number; readonly end: number },
  raw: string,
): BoundOperand => {
  const candidates: string[] = [];

  for (const type of context.registry.types) {
    const result = type.parseOperand(token, {
      caseSensitive,
      lookup: (name) => context.registry.get(name),
      options: context.options,
      site,
    });

    candidates.push(type.name);

    if (result.ok) {
      // An ordered site needs an ordered type. `string` has no `ordering`, which
      // is exactly why `name:>="m"` throws instead of inventing an answer.
      if (
        (site.kind === 'ordered' || site.kind === 'range') &&
        type.ordering === undefined
      ) {
        throw new SiftQLOperandError(
          `Type "${type.name}" has no ordering, so it cannot be compared with ${
            site.kind === 'ordered' ? site.operator : 'a range'
          }`,
          {
            candidates,
            code: 'UNORDERED_TYPE',
            hint: 'Only ordered types (number, datetime, and custom types with an `ordering`) support > >= < <= and ranges',
            location,
            raw,
            site,
          },
        );
      }

      return { operand: result.operand, type };
    }

    if (result.kind === 'invalid') {
      throw new SiftQLOperandError(`${type.name}: ${result.reason}`, {
        candidates,
        hint: result.hint,
        location,
        raw,
        site,
      });
    }
  }

  throw new SiftQLOperandError('No value type claimed this operand', {
    candidates,
    location,
    raw,
    site,
  });
};

const valueContext = (
  site: OperandSite,
  caseSensitive: boolean,
  path: readonly (string | number)[],
  isKey: boolean,
  context: EvaluationContext,
): ValueContext => ({
  caseSensitive,
  isKey,
  lookup: (name) => context.registry.get(name),
  options: context.options,
  path,
  site,
});

/** Read one candidate through the bound type, applying the failure policy. */
const readValue = (
  bound: BoundOperand,
  candidate: Candidate,
  site: OperandSite,
  caseSensitive: boolean,
  isKey: boolean,
  location: { readonly start: number; readonly end: number },
  context: EvaluationContext,
): { ok: true; value: unknown } | { ok: false } => {
  const [path, raw] = candidate;
  const result = bound.type.coerceValue(
    raw,
    valueContext(site, caseSensitive, path, isKey, context),
  );

  if (result.ok) {
    return { ok: true, value: result.value };
  }

  const survived = signalValueFailure({
    kind: result.kind,
    location,
    onValueError: context.options.onValueError,
    path,
    reason: result.kind === 'invalid' ? result.reason : null,
    site: site.kind,
    typeName: bound.type.name,
    value: raw,
  });

  // signalValueFailure returns false or throws; it never returns true.
  return { ok: survived };
};

const matchOne = (
  bound: BoundOperand,
  value: unknown,
  site: OperandSite,
  caseSensitive: boolean,
  path: readonly (string | number)[],
  isKey: boolean,
  context: EvaluationContext,
): boolean => {
  // `matches` is `:`; when a type omits it, `:` and `:=` agree. That single
  // choice is the whole match-versus-equality semantics, expressed once.
  // Called as a method so a type may legitimately use `this`.
  return bound.type.matches === undefined
    ? bound.type.equals(value, bound.operand)
    : bound.type.matches(
        value,
        bound.operand,
        valueContext(site, caseSensitive, path, isKey, context),
      );
};

const compareOne = (bound: BoundOperand, value: unknown): number | null =>
  bound.type.ordering?.compare(value, bound.operand) ?? null;

/** Range evaluation, written once for every type that has an ordering. */
const withinBoundary = (
  bound: BoundOperand | null,
  boundary: RangeBoundary,
  value: unknown,
  side: 'lower' | 'upper',
): boolean | null => {
  if (!boundary.bounded || bound === null) {
    // Unbounded: nothing to fail against.
    return true;
  }

  const ordering = compareOne(bound, value);

  if (ordering === null) {
    return null;
  }

  const satisfied =
    side === 'lower'
      ? boundary.inclusive
        ? ordering >= 0
        : ordering > 0
      : boundary.inclusive
        ? ordering <= 0
        : ordering < 0;

  return satisfied;
};

const literalOf = (boundary: RangeBoundary): TextLiteral | null =>
  boundary.bounded ? boundary.value : null;

/**
 * Compile an AST into a predicate.
 *
 * Operands are resolved ONCE here, not per record, so a filter over 10,000 rows
 * parses `2020-06-01` a single time. It also means a bad query throws
 * immediately rather than on the first row that happens to reach it.
 */
export const compileExpression = (
  node: SiftQLAst,
  context: EvaluationContext,
  defaultField: Field | null = null,
): Predicate => {
  switch (node.type) {
    case 'EmptyExpression':
      // The empty query matches everything.
      return () => true;

    case 'LogicalExpression': {
      const left = compileExpression(node.left, context, defaultField);
      const right = compileExpression(node.right, context, defaultField);

      if (node.operator.operator === 'AND') {
        return (item, sink) => {
          const checkpoint = sink?.mark() ?? 0;

          // A failed conjunction contributed nothing, so neither side's
          // highlights survive.
          if (!left(item, sink) || !right(item, sink)) {
            sink?.rollback(checkpoint);

            return false;
          }

          return true;
        };
      }

      return (item, sink) => {
        // Without a sink, short-circuit as usual.
        if (sink === null) {
          return left(item, null) || right(item, null);
        }

        // With one, evaluate BOTH sides and keep only the branches that
        // matched: this is the fix for highlights leaking out of the losing
        // half of an OR.
        const beforeLeft = sink.mark();
        const leftMatched = left(item, sink);

        if (!leftMatched) {
          sink.rollback(beforeLeft);
        }

        const beforeRight = sink.mark();
        const rightMatched = right(item, sink);

        if (!rightMatched) {
          sink.rollback(beforeRight);
        }

        return leftMatched || rightMatched;
      };
    }

    case 'MissingExpression':
      // Pruned before evaluation; a hole that survives matches nothing.
      return () => false;

    case 'ParenthesizedExpression':
      return compileExpression(node.expression, context, defaultField);

    case 'UnaryOperator': {
      const operand = compileExpression(node.operand, context, defaultField);

      return (item, sink) => {
        const checkpoint = sink?.mark() ?? 0;
        const matched = operand(item, sink);

        // ALWAYS roll back. If the negation succeeded then the operand did not
        // match, so whatever it lit up is precisely the wrong answer; and if it
        // failed, the clause contributed nothing either way.
        sink?.rollback(checkpoint);

        return !matched;
      };
    }

    case 'Tag': {
      // A field group re-enters with the field pushed as the default, exactly
      // as the grammar reads -- no desugaring, no duplicated subtrees.
      if (
        node.kind === 'match' &&
        node.expression.type === 'ParenthesizedExpression'
      ) {
        return compileExpression(
          node.expression.expression,
          context,
          node.field,
        );
      }

      return compileClause(node, context, node.field);
    }

    default:
      return compileClause(node, context, defaultField);
  }
};

/**
 * Test every candidate.
 *
 * Without a sink this stops at the first hit, exactly as `.some()` did. With
 * one it keeps going, because a UI wants every field that matched lit up, not
 * just the first.
 */
const anyCandidateMatches = (
  candidates: readonly Candidate[],
  sink: HighlightSink | null,
  hit: (candidate: Candidate) => boolean,
): boolean => {
  let matched = false;

  for (const candidate of candidates) {
    if (hit(candidate)) {
      matched = true;

      if (sink === null) {
        return true;
      }
    }
  }

  return matched;
};

/** Record a hit, asking the type what to light up inside the matched value. */
const emit = (
  sink: HighlightSink,
  bound: BoundOperand,
  value: unknown,
  candidate: Candidate,
  site: OperandSite,
  caseSensitive: boolean,
  context: EvaluationContext,
): void => {
  const [segments] = candidate;
  const query = bound.type.highlight?.(
    value,
    bound.operand,
    valueContext(site, caseSensitive, segments, false, context),
  );

  sink.add(
    query
      ? { path: formatPath(segments), query, segments }
      : // A range or a boolean has no textual footprint, so the whole value is
        // the match and there is no pattern to report.
        { path: formatPath(segments), segments },
  );
};

const compileClause = (
  node: Expression,
  context: EvaluationContext,
  field: Field | null,
): Predicate => {
  const path = field ? fieldPath(field) : null;

  const candidatesFor = (item: unknown): Candidate[] =>
    path === null
      ? allLeafValues(item, context.options.matchKeys)
      : valuesAtPath(item, path);

  // ---- Tag: a fielded clause ------------------------------------------------
  if (node.type === 'Tag') {
    const caseSensitive = node.caseSensitive;

    if (node.kind === 'relational') {
      if (node.expression.type === 'MissingExpression') {
        return () => false;
      }

      const isEquality = node.operator.operator === ':=';
      const site: OperandSite = isEquality
        ? { field: node.field, kind: 'equality' }
        : {
            field: node.field,
            kind: 'ordered',
            operator: node.operator.operator,
          };
      const token = toOperandToken(node.expression);

      if (token === null) {
        return () => false;
      }

      const bound = resolveOperand(
        token,
        site,
        caseSensitive,
        context,
        node.expression.location,
        node.expression.value,
      );
      const operator = node.operator.operator;

      return (item, sink) =>
        anyCandidateMatches(candidatesFor(item), sink, (candidate) => {
          const read = readValue(
            bound,
            candidate,
            site,
            caseSensitive,
            false,
            node.expression.location,
            context,
          );

          if (!read.ok) {
            return false;
          }

          const record = (matched: boolean): boolean => {
            if (matched && sink) {
              emit(
                sink,
                bound,
                read.value,
                candidate,
                site,
                caseSensitive,
                context,
              );
            }

            return matched;
          };

          if (isEquality) {
            return record(bound.type.equals(read.value, bound.operand));
          }

          const ordering = compareOne(bound, read.value);

          if (ordering === null) {
            return signalValueFailure({
              kind: 'incomparable',
              location: node.expression.location,
              onValueError: context.options.onValueError,
              path: candidate[0],
              reason: null,
              site: 'ordered',
              typeName: bound.type.name,
              value: candidate[1],
            });
          }

          switch (operator) {
            case ':>':
              return record(ordering > 0);
            case ':>=':
              return record(ordering >= 0);
            case ':<':
              return record(ordering < 0);
            default:
              return record(ordering <= 0);
          }
        });
    }

    // Match tag: a range, or a single operand.
    if (node.expression.type === 'RangeExpression') {
      return compileRange(node, context, candidatesFor);
    }

    const site: OperandSite = { field: node.field, kind: 'match' };
    const token = toOperandToken(node.expression);

    if (token === null) {
      return () => false;
    }

    const bound = resolveOperand(
      token,
      site,
      caseSensitive,
      context,
      node.expression.location,
      sourceOf(node.expression),
    );

    return (item, sink) =>
      anyCandidateMatches(candidatesFor(item), sink, (candidate) => {
        const read = readValue(
          bound,
          candidate,
          site,
          caseSensitive,
          false,
          node.expression.location,
          context,
        );

        const matched =
          read.ok &&
          matchOne(
            bound,
            read.value,
            site,
            caseSensitive,
            candidate[0],
            false,
            context,
          );

        if (matched && sink) {
          emit(
            sink,
            bound,
            read.value,
            candidate,
            site,
            caseSensitive,
            context,
          );
        }

        return matched;
      });
  }

  // ---- Unfielded term: sweep every leaf -------------------------------------
  const site: OperandSite = field ? { field, kind: 'match' } : { kind: 'scan' };
  const token = toOperandToken(node);

  if (token === null) {
    return () => false;
  }

  const bound = resolveOperand(
    token,
    site,
    false,
    context,
    node.location,
    sourceOf(node),
  );

  return (item, sink) =>
    anyCandidateMatches(candidatesFor(item), sink, (candidate) => {
      const read = readValue(
        bound,
        candidate,
        site,
        false,
        false,
        node.location,
        context,
      );

      const matched =
        read.ok &&
        matchOne(bound, read.value, site, false, candidate[0], false, context);

      if (matched && sink) {
        emit(sink, bound, read.value, candidate, site, false, context);
      }

      return matched;
    });
};

const compileRange = (
  node: Extract<Expression, { type: 'Tag' }>,
  context: EvaluationContext,
  candidatesFor: (item: unknown) => Candidate[],
): Predicate => {
  if (node.expression.type !== 'RangeExpression') {
    return () => false;
  }

  const range = node.expression;
  const caseSensitive = node.caseSensitive;

  const bindBoundary = (
    boundary: RangeBoundary,
    side: 'lower' | 'upper',
  ): BoundOperand | null => {
    const literal = literalOf(boundary);

    if (literal === null) {
      return null;
    }

    const token = toOperandToken(literal);

    if (token === null) {
      return null;
    }

    return resolveOperand(
      token,
      {
        field: node.field,
        inclusive: boundary.bounded ? boundary.inclusive : true,
        kind: 'range',
        side,
      },
      caseSensitive,
      context,
      literal.location,
      literal.value,
    );
  };

  const lower = bindBoundary(range.lower, 'lower');
  const upper = bindBoundary(range.upper, 'upper');
  const reference = lower ?? upper;

  if (reference === null) {
    // [* TO *] -- every value its type can read is in range.
    return () => true;
  }

  if (lower && upper && lower.type.name !== upper.type.name) {
    throw new SiftQLOperandError(
      `Range boundaries resolved to different types: "${lower.type.name}" and "${upper.type.name}"`,
      {
        code: 'MIXED_RANGE_TYPES',
        location: range.location,
        raw: '',
        site: {
          field: node.field,
          inclusive: true,
          kind: 'range',
          side: 'upper',
        },
      },
    );
  }

  const site: OperandSite = {
    field: node.field,
    inclusive: true,
    kind: 'range',
    side: 'lower',
  };

  return (item, sink) =>
    anyCandidateMatches(candidatesFor(item), sink, (candidate) => {
      const read = readValue(
        reference,
        candidate,
        site,
        caseSensitive,
        false,
        range.location,
        context,
      );

      if (!read.ok) {
        return false;
      }

      const low = withinBoundary(lower, range.lower, read.value, 'lower');
      const high = withinBoundary(upper, range.upper, read.value, 'upper');

      if (low === null || high === null) {
        return signalValueFailure({
          kind: 'incomparable',
          location: range.location,
          onValueError: context.options.onValueError,
          path: candidate[0],
          reason: null,
          site: 'range',
          typeName: reference.type.name,
          value: candidate[1],
        });
      }

      const matched = low && high;

      if (matched && sink) {
        // A range has no textual footprint, so `emit` records the path with no
        // pattern -- the whole value is the match.
        emit(
          sink,
          reference,
          read.value,
          candidate,
          site,
          caseSensitive,
          context,
        );
      }

      return matched;
    });
};

const sourceOf = (node: Expression): string => {
  switch (node.type) {
    case 'LiteralExpression':
      return String(node.value);
    case 'RegexExpression':
      return `/${node.pattern}/`;
    case 'WildcardExpression':
      return node.pattern
        .map((segment) =>
          segment.type === 'WildcardAny'
            ? '*'
            : segment.type === 'WildcardSingle'
              ? '?'
              : segment.value,
        )
        .join('');
    default:
      return '';
  }
};
