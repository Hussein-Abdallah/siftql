import {
  SiftQLArgumentError,
  SiftQLOperandError,
  signalValueFailure,
} from '../errors.js';
import { MAX_AST_DEPTH } from '../limits.js';
import {
  callCompare,
  callCoerceValue,
  callHighlight,
  callHighlightSpans,
  callParseOperand,
  callPredicate,
  nameOf,
  readOrdering,
} from './consumer.js';
import type {
  AnyValueType,
  EvaluationSite,
  OnValueError,
  OperandSite,
  OperandToken,
  ResolvedEngineOptions,
  TypeVisibleOptions,
  ValueContext,
  ValueFailureKind,
  ValueTypeRegistry,
} from '../registry.js';
import type { ValueFailure } from '../errors.js';
import type {
  Expression,
  Field,
  RangeBoundary,
  SiftQLAst,
  SourceLocation,
  TextLiteral,
} from '../types.js';
import { fieldPath } from '../types.js';
import {
  allLeafValues,
  formatPath,
  pathOf,
  valuesAtPath,
  type Candidate,
  type PathRef,
} from './access.js';
import type { HighlightSink } from './highlight.js';

/**
 * Evaluation.
 *
 * The load-bearing property: there is NO per-type logic here. Matching,
 * ordering and range evaluation all go through the registry, so `datetime` is
 * reached by exactly the same code path as a consumer's `semver`. There is no
 * branch anywhere below on which type a value belongs to.
 *
 * (This used to say "grep this file for date and you will find nothing", which
 * returns 76 hits — the claim is true of the LOGIC and false as an instruction,
 * and an instruction is what a reader will actually follow.)
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
  /**
   * The same settings with the failure policy removed, built ONCE per call and
   * shared by every context handed to a value type.
   *
   * A separate object rather than a cast, because the claim is about runtime: a
   * type authored in JavaScript has no types to stop it reading
   * `ctx.options.onValueError`, and only actually withholding the key does.
   * Built once because `valueContext` runs per candidate — narrowing there would
   * allocate an object per value.
   */
  readonly typeOptions: TypeVisibleOptions;
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
    const result = callParseOperand(
      type,
      token,
      // Frozen for the same reason as ValueContext: a type must not be able to
      // rewrite engine policy from inside a callback siftql invoked.
      Object.freeze({
        caseSensitive,
        lookup: (name: string) => context.registry.get(name),
        options: context.typeOptions,
        site,
      }),
      location,
      raw,
    );

    candidates.push(nameOf(type));

    if (result.ok) {
      // An ordered site needs an ordered type. `string` has no `ordering`, which
      // is exactly why `name:>="m"` throws instead of inventing an answer.
      if (
        (site.kind === 'ordered' || site.kind === 'range') &&
        readOrdering(type) === undefined
      ) {
        throw new SiftQLOperandError(
          `Type "${nameOf(type)}" has no ordering, so it cannot be compared with ${
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
      throw new SiftQLOperandError(`${nameOf(type)}: ${result.reason}`, {
        candidates,
        code: result.code ?? 'OPERAND',
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

/**
 * The context handed to a value type, FROZEN.
 *
 * `readonly` is a compile-time claim and nothing more: a type authored in
 * JavaScript, or one that casts, can assign to `ctx.options` or
 * `ctx.options.onValueError` and change how siftql treats every LATER record in
 * the same filter — a per-record callback quietly rewriting engine-wide policy.
 * Freezing makes the declared immutability real.
 *
 * Shallow is not enough: `options` and `options.temporal` are the parts worth
 * tampering with, so both are frozen at engine construction (see
 * `resolveOptions`), and `path` is frozen here because it is built per call.
 */
class LazyValueContext implements ValueContext {
  public readonly options: TypeVisibleOptions;

  public readonly lookup: (typeName: string) => AnyValueType | undefined;

  readonly #ref: PathRef;

  #materialised: readonly (string | number)[] | null = null;

  public constructor(
    public readonly site: OperandSite,
    public readonly caseSensitive: boolean,
    ref: PathRef,
    public readonly isKey: boolean,
    context: EvaluationContext,
  ) {
    this.#ref = ref;
    this.options = context.typeOptions;
    // An own property, not a prototype method: a type is free to destructure
    // `const { lookup } = ctx`, and an unbound method would lose its receiver.
    this.lookup = (name) => context.registry.get(name);
  }

  /**
   * Built LAZILY, and memoised once built.
   *
   * A context is constructed once per CANDIDATE, so copying the path eagerly was
   * half of the quadratic walk: a chain-shaped record paid O(depth) for every
   * leaf whether or not the type ever looked at it, and most types never do.
   */
  public get path(): readonly (string | number)[] {
    this.#materialised ??= Object.freeze([...pathOf(this.#ref)]);

    return this.#materialised;
  }

  /**
   * `path` lives on the PROTOTYPE, so `{...ctx}` and `JSON.stringify(ctx)` do
   * not carry it. Reading `ctx.path` and destructuring both work as before;
   * this puts it back for the debugging case.
   */
  public toJSON(): Record<string, unknown> {
    return {
      caseSensitive: this.caseSensitive,
      isKey: this.isKey,
      options: this.options,
      path: this.path,
      site: this.site,
    };
  }
}

/**
 * The context handed to a value type, FROZEN.
 *
 * A CLASS rather than an object literal, because the accessor then lives on the
 * prototype instead of being installed per instance. An own accessor is roughly
 * 20-50x the allocation cost of a plain property (it was measured at 185x by a
 * microbenchmark that turned out to be measuring the benchmark) and is created
 * once per candidate,
 * which made an ordinary `filter()` over 20,000 rows 2.4x slower than before the
 * path went lazy — paying for deep records with everybody else's common case.
 * On the prototype it is both lazy and cheaper than the eager version it replaced.
 */
const valueContext = (
  site: OperandSite,
  caseSensitive: boolean,
  path: PathRef,
  isKey: boolean,
  context: EvaluationContext,
): ValueContext =>
  Object.freeze(
    new LazyValueContext(site, caseSensitive, path, isKey, context),
  );

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
  const [pathRef, raw, candidateIsKey = false] = candidate;
  const failure = failureSite(bound, site, pathRef, location, raw, context);

  // Reading the value itself threw — a getter or a Proxy trap. That is dirty
  // DATA, so it follows onValueError exactly like an unreadable value, instead
  // of escaping raw and destroying the whole result set.
  if (candidate.length > 3) {
    return {
      ok: signalValueFailure(
        failure.with({
          cause: candidate[3],
          kind: 'invalid',
          reason: 'reading this value threw',
          value: undefined,
        }),
      ),
    };
  }

  const result = callCoerceValue(
    bound.type,
    raw,
    valueContext(
      site,
      caseSensitive,
      pathRef,
      isKey || candidateIsKey,
      context,
    ),
    failure,
  );

  if (result.ok) {
    return { ok: true, value: result.value };
  }

  /*
   * `.with` rather than a fresh literal with `path: pathOf(pathRef)`.
   *
   * This is the common path, not an edge case: for an unfielded term
   * `stringType.coerceValue` returns MISS for every number, boolean, null and
   * Date leaf, and each one came through here and built a full path array that
   * the `scan` policy then never read. That alone kept the walk quadratic —
   * a 3.4 MB comment thread took 31 seconds.
   */
  const survived = signalValueFailure(
    failure.with({
      kind: result.kind,
      reason: result.kind === 'invalid' ? result.reason : null,
    }),
  );

  // signalValueFailure returns false or throws; it never returns true.
  return { ok: survived };
};

/**
 * The descriptor a value-side failure needs.
 *
 * Every callback that touches a datum can fail, and each one has to be able to
 * say WHICH value at WHICH path failed WHICH clause. Building that in one place
 * keeps the call sites honest — an omitted `path` here becomes an error message
 * that cannot be acted on.
 *
 * `path` is a PROTOTYPE accessor, for two separate reasons. It is lazy, because
 * this is assembled once per candidate before anyone knows whether the value
 * will fail, and `signalValueFailure` reads the path only on the branch that
 * throws — under the default `skip` policy it is never read at all. Building it
 * eagerly kept the unfielded walk quadratic for every record whose leaves are
 * not strings, which is most records: `stringType.coerceValue` misses on every
 * number, boolean, null and Date, and each miss came through here. And it is on
 * the prototype rather than the instance because an own accessor costs far more
 * to install than a plain property, once per candidate, for everyone.
 *
 * Since a prototype accessor is not an own property, `{...site}` would silently
 * drop it — hence {@link LazyFailure.with} rather than a spread at the call sites.
 */
class LazyFailure implements ValueFailure {
  public readonly cause?: unknown;

  readonly #ref: PathRef;

  #materialised: readonly (string | number)[] | null = null;

  public constructor(
    public readonly site: EvaluationSite,
    public readonly typeName: string,
    public readonly location: SourceLocation,
    public readonly onValueError: OnValueError,
    public readonly value: unknown,
    ref: PathRef,
    public readonly kind: ValueFailureKind = 'miss',
    public readonly reason: string | null = null,
    cause?: unknown,
  ) {
    this.#ref = ref;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }

  public get path(): readonly (string | number)[] {
    this.#materialised ??= pathOf(this.#ref);

    return this.#materialised;
  }

  /** The same failure, classified — sharing the trail, so still lazy. */
  public with(extra: {
    readonly kind: ValueFailureKind;
    readonly reason: string | null;
    readonly cause?: unknown;
    readonly value?: unknown;
  }): LazyFailure {
    return new LazyFailure(
      this.site,
      this.typeName,
      this.location,
      this.onValueError,
      'value' in extra ? extra.value : this.value,
      this.#ref,
      extra.kind,
      extra.reason,
      extra.cause,
    );
  }
}

const failureSite = (
  bound: BoundOperand,
  site: OperandSite,
  path: PathRef,
  location: { readonly start: number; readonly end: number },
  value: unknown,
  context: EvaluationContext,
): LazyFailure =>
  new LazyFailure(
    site.kind,
    nameOf(bound.type),
    location,
    context.options.onValueError,
    value,
    path,
  );

const matchOne = (
  bound: BoundOperand,
  value: unknown,
  site: OperandSite,
  caseSensitive: boolean,
  path: PathRef,
  isKey: boolean,
  location: { readonly start: number; readonly end: number },
  context: EvaluationContext,
): boolean => {
  // `matches` is `:`; when a type omits it, `:` and `:=` agree. That single
  // choice is the whole match-versus-equality semantics, expressed once.
  // Called as a method so a type may legitimately use `this`.
  const { type } = bound;
  const failure = failureSite(bound, site, path, location, value, context);

  // Reading `type.matches` is itself a property access on consumer code, so it
  // goes through the guard rather than being tested first and called after.
  let hasMatches: boolean;

  try {
    hasMatches = type.matches !== undefined;
  } catch {
    return signalValueFailure(
      failure.with({ kind: 'invalid', reason: 'reading matches threw' }),
    );
  }

  return !hasMatches
    ? callPredicate(
        type,
        'equals',
        () => type.equals(value, bound.operand),
        failure,
      )
    : callPredicate(
        type,
        'matches',
        () =>
          type.matches?.(
            value,
            bound.operand,
            valueContext(site, caseSensitive, path, isKey, context),
          ),
        failure,
      );
};

const compareOne = (
  bound: BoundOperand,
  value: unknown,
  site: OperandSite,
  path: PathRef,
  location: { readonly start: number; readonly end: number },
  context: EvaluationContext,
): number | null => {
  /*
   * Through the guard, not destructured. `readOrdering` runs once at BIND time,
   * so an accessor that survives its first read and throws on a later one
   * escaped raw from here — which is the per-record path. `type.matches` a few
   * lines up is guarded for exactly this reason.
   */
  const ordering = readOrdering(bound.type);

  if (ordering === undefined) {
    return null;
  }

  return callCompare(
    bound.type,
    () => ordering.compare(value, bound.operand),
    failureSite(bound, site, path, location, value, context),
  );
};

/**
 * Compare the two BOUNDARIES of a range against each other.
 *
 * Separate from {@link compareOne} because the failure means something different:
 * nothing from the record is involved, so a throw here is a query-side defect in
 * the value type and is raised unconditionally.
 */
const compareOperands = (
  lower: BoundOperand,
  upper: BoundOperand,
  location: { readonly start: number; readonly end: number },
  field: Field,
): number | null => {
  try {
    return (
      readOrdering(lower.type)?.compare(upper.operand, lower.operand) ?? null
    );
  } catch (error) {
    throw new SiftQLOperandError(
      `Value type ${nameOf(lower.type)}.ordering.compare() threw while checking the range boundaries against each other: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        cause: error,
        code: 'MIXED_RANGE_TYPES',
        hint: 'This is a defect in that value type, not in the query.',
        location,
        raw: '',
        site: { field, inclusive: true, kind: 'range', side: 'upper' },
      },
    );
  }
};

/** Range evaluation, written once for every type that has an ordering. */
const withinBoundary = (
  bound: BoundOperand | null,
  boundary: RangeBoundary,
  value: unknown,
  side: 'lower' | 'upper',
  site: OperandSite,
  path: PathRef,
  location: { readonly start: number; readonly end: number },
  context: EvaluationContext,
): boolean | null => {
  if (!boundary.bounded || bound === null) {
    // Unbounded: nothing to fail against.
    return true;
  }

  const ordering = compareOne(bound, value, site, path, location, context);

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
 * Turn half-typed clauses that cannot be compiled into holes, so `prune` can
 * remove them.
 *
 * Tolerant mode promises that a query being typed does not blow up, and `prune`
 * delivered that only for `MissingExpression`. A range carries its invention on
 * itself or its boundaries and fell straight through to the evaluator, where the
 * INVENTED bound then failed to resolve: the tolerant tokenizer reads a
 * half-typed `TO` as a literal upper bound, so `n:[1 T` became `n:[1 TO T]` and
 * threw UNORDERED_TYPE. Typing `d:[2020-01-01 TO 2020-12-31]` one character at a
 * time threw on 15 of its 28 prefixes — before any record was read, so no data
 * could avoid it. `parse()` never threw, which is exactly why the property
 * asserting tolerance at `parse()` stayed green.
 *
 * The test is UNRESOLVABLE, not "recovered", and that is deliberately wider
 * than the defect that prompted it. Being recovered is neither necessary nor
 * sufficient:
 *
 *   - not sufficient — `d:[2020-01-01 TO 2020-12-31`, missing only its `]`, is
 *     recovered and resolves fine. Dropping it would throw away a working live
 *     filter at the last keystroke before the user finishes.
 *   - not necessary — `d:>=2020-` carries no recovery at all. It is a perfectly
 *     well-formed clause comparing against the string "2020-", which has no
 *     ordering, so it threw from the middle of an ordinary date being typed.
 *
 * So the rule tolerant mode actually needs is the simpler one: A TOLERANT QUERY
 * NEVER THROWS FOR BEING INCOMPLETE OR MALFORMED. What cannot be used is
 * dropped, and a clause that constrains nothing constrains nothing. Structural
 * limits still throw — they guard resources, not syntax. Strict mode is unchanged — there, an operand that
 * cannot resolve is still a hard error, because a caller who did not ask for
 * leniency should hear about a broken query rather than silently get more rows
 * than they asked for.
 *
 * This is the same lesson `findRecoveredBoundary` learned for the `throw`
 * policy, which failed OPEN on boundaries for the same reason: the walk stopped
 * at the node instead of reaching the invention.
 */
export const repairUnresolvableHoles = (
  ast: SiftQLAst,
  context: EvaluationContext,
): SiftQLAst => {
  try {
    /*
     * The whole tree first, so a query that compiles — which is nearly all of
     * them, including most half-typed ones — costs one extra compile and no
     * walk at all. Only a tree that genuinely fails is taken apart clause by
     * clause below.
     */
    compileExpression(ast, context);

    return ast;
  } catch (error) {
    if (!(error instanceof SiftQLOperandError)) {
      throw error;
    }
  }

  const repair = (node: Expression, depth: number): Expression => {
    if (depth > MAX_AST_DEPTH) {
      return node;
    }

    switch (node.type) {
      case 'LogicalExpression': {
        const left = repair(node.left, depth + 1);
        const right = repair(node.right, depth + 1);

        return left === node.left && right === node.right
          ? node
          : { ...node, left, right };
      }

      case 'ParenthesizedExpression': {
        const inner = repair(node.expression, depth + 1);

        return inner === node.expression
          ? node
          : { ...node, expression: inner };
      }

      case 'UnaryOperator': {
        const operand = repair(node.operand, depth + 1);

        return operand === node.operand ? node : { ...node, operand };
      }

      case 'Tag': {
        /*
         * A FIELD GROUP IS A TREE, and trial-compiling the Tag whole made one
         * unresolvable term delete every sibling with it: `d:(2020-06-01 OR
         * 2021-02-29)` pruned to nothing and matched EVERY row, including rows
         * with no `d` key — while the flat `d:2020-06-01 OR d:2021-02-29`
         * correctly kept the good half. That is a permissive leak, not just a
         * blank list.
         *
         * `prune` learned this same lesson on its own walk and says so at
         * length; this walk was written without it. Only a match tag can hold a
         * group — a relational one compares against a single scalar.
         */
        if (
          node.kind === 'match' &&
          node.expression.type === 'ParenthesizedExpression'
        ) {
          const group = node.expression;
          const body = repair(group.expression, depth + 1);

          if (body !== group.expression) {
            return {
              ...node,
              expression: {
                ...group,
                expression: body as typeof group.expression,
              },
            };
          }
        }

        return repairLeaf(node);
      }

      default:
        return repairLeaf(node);
    }
  };

  const repairLeaf = (node: Expression): Expression => {
    try {
      // Compilation is pure — it resolves operands and touches no record — so
      // running it early to ask "would this work?" is safe.
      compileExpression(node, context);

      return node;
    } catch (error) {
      if (error instanceof SiftQLOperandError) {
        return { location: node.location, type: 'MissingExpression' };
      }

      throw error;
    }
  };

  // An empty root has nothing to repair and is not an `Expression`.
  return ast.type === 'EmptyExpression' ? ast : repair(ast, 0);
};

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
  /**
   * The enclosing clause's collation. A field group is ONE clause, so
   * `name::(Ada)` must apply `::` to every term inside it exactly as
   * `name::Ada` does -- the flag has to travel with the pushed field or it is
   * silently discarded at the group boundary.
   */
  defaultCaseSensitive = false,
  /**
   * Frames spent so far. Bounded by MAX_AST_DEPTH, which is exactly what
   * `parse()` can emit — so this can only fire for a hand-built or deserialized
   * tree, and it fires as a named error rather than a raw `RangeError` from
   * whichever helper happened to be on the stack when it ran out.
   */
  depth = 0,
): Predicate => {
  if (depth > MAX_AST_DEPTH) {
    throw new SiftQLArgumentError(
      `This AST nests more than ${String(MAX_AST_DEPTH)} levels deep, which is deeper than parse() can produce and deep enough to exhaust the call stack. It was built by hand or arrived as JSON; check for a cycle.`,
      { argument: 'query', received: node.type },
    );
  }

  switch (node.type) {
    case 'EmptyExpression':
      // The empty query matches everything.
      return () => true;

    case 'LogicalExpression': {
      const left = compileExpression(
        node.left,
        context,
        defaultField,
        defaultCaseSensitive,
        depth + 1,
      );
      const right = compileExpression(
        node.right,
        context,
        defaultField,
        defaultCaseSensitive,
        depth + 1,
      );

      if (node.operator.operator === 'AND') {
        /*
         * SHORT-CIRCUITING IS AN OPTIMISATION, AND ONLY WHEN FAILURES ARE SILENT.
         *
         * Under the default `onValueError: 'skip'` a dirty value is simply a
         * non-match, so skipping the right operand cannot change the answer.
         * Under `'throw'` it changes which failures the caller is TOLD about:
         * `a:zzz AND b:>2020-01-01` quietly returned no rows while
         * `b:>2020-01-01 AND a:zzz` threw, for the same data. Whether you hear
         * that a column is unusable should not depend on the order you wrote
         * your clauses in.
         */
        const exhaustive = context.options.onValueError === 'throw';

        return (item, sink) => {
          const checkpoint = sink?.mark() ?? 0;
          const leftMatched = left(item, sink);

          if (!leftMatched && !exhaustive) {
            sink?.rollback(checkpoint);

            return false;
          }

          const rightMatched = right(item, sink);

          // A failed conjunction contributed nothing, so neither side's
          // highlights survive.
          if (!leftMatched || !rightMatched) {
            sink?.rollback(checkpoint);

            return false;
          }

          return true;
        };
      }

      return (item, sink) => {
        // Without a sink, short-circuit as usual -- EXCEPT under a throwing
        // policy, where skipping the right operand means whether an error
        // fires depends on which side happens to match first, and filter()
        // then disagrees with highlight(), which never short-circuits.
        if (sink === null && !exhaustiveScan(context)) {
          return left(item, null) || right(item, null);
        }

        if (sink === null) {
          const leftMatched = left(item, null);
          const rightMatched = right(item, null);

          return leftMatched || rightMatched;
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
      return compileExpression(
        node.expression,
        context,
        defaultField,
        defaultCaseSensitive,
        depth + 1,
      );

    case 'UnaryOperator': {
      const operand = compileExpression(
        node.operand,
        context,
        defaultField,
        defaultCaseSensitive,
        depth + 1,
      );

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
          node.caseSensitive,
          depth + 1,
        );
      }

      return compileClause(node, context, node.field, node.caseSensitive);
    }

    default:
      return compileClause(node, context, defaultField, defaultCaseSensitive);
  }
};

/**
 * Under a throwing policy every candidate must be inspected, or whether an
 * error fires depends on the order of an array.
 */
const exhaustiveScan = (context: EvaluationContext): boolean =>
  context.options.onValueError === 'throw';

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
  /**
   * Whether every candidate must be visited even after one matches.
   *
   * Short-circuiting is correct for a boolean answer, but it makes
   * `onValueError: 'throw'` depend on ARRAY ORDER: a dirty element sitting
   * after a matching one is never coerced, so the same multiset of values
   * throws or does not depending on how it happens to be sorted. It also made
   * filter() and highlight() disagree, since highlight never short-circuits.
   * Under a throwing policy every candidate is inspected.
   */
  exhaustive: boolean,
  hit: (candidate: Candidate) => boolean,
): boolean => {
  let matched = false;

  for (const candidate of candidates) {
    if (hit(candidate)) {
      matched = true;

      if (sink === null && !exhaustive) {
        return true;
      }
    }
  }

  return matched;
};

/** Record a hit, asking the type what to light up inside the matched value. */
/**
 * Can this pattern produce a zero-length match, and so trap a consumer's
 * `exec` loop?
 */
const matchesEmpty = (pattern: RegExp): boolean => {
  /*
   * PROBES, not a scan of the value — and the difference is a two-minute hang.
   *
   * The first version of this ran the consumer's regex over the whole record
   * value, looking for a zero-length match. That put an ARBITRARY, UNSCREENED
   * regex on the match path: a value type whose `highlight` returned `(a+)+$`
   * blocked the process for 118 seconds on a 41-character value. `regexGuard`
   * cannot help, because it screens QUERY patterns and this one arrives from a
   * callback. Nor can a time check — a single `exec` is uninterruptible, so the
   * budget is never consulted.
   *
   * The only safe amount of hostile regex to run is a bounded amount, so the
   * pattern is tried against two tiny fixed strings instead. Backtracking is
   * bounded by input length, so four characters cannot blow up.
   *
   * WHAT THIS CATCHES: `a*`, `(?:)`, `^`, `$`, `[0-9]*`, `\b` — every shape that
   * makes the documented `while ((m = query.exec(text)))` loop spin forever,
   * because a pattern that can match nothing at all will do so against one of
   * these probes.
   *
   * WHAT IT MISSES: a pattern zero-width only in a context the probes lack, such
   * as `(?<=x)`. Stated rather than papered over. The consequence is bounded —
   * such a highlight keeps its regex, and the risk is the consumer's own loop,
   * exactly as it was before this check existed at all.
   */
  const probes = ['', 'a1 A'];

  for (const probe of probes) {
    const scanner = new RegExp(
      pattern.source,
      `${pattern.flags.replace(/[gy]/gu, '')}g`,
    );

    let match = scanner.exec(probe);

    while (match !== null) {
      if (match[0].length === 0) {
        return true;
      }

      match = scanner.exec(probe);
    }
  }

  return false;
};

const emit = (
  sink: HighlightSink,
  bound: BoundOperand,
  value: unknown,
  candidate: Candidate,
  site: OperandSite,
  caseSensitive: boolean,
  context: EvaluationContext,
): void => {
  const [pathRef, , isKey = false] = candidate;
  const segments = pathOf(pathRef);

  // A key hit matched the field's NAME, not its contents. Reporting a pattern
  // would hand the caller one that provably cannot match the value stored at
  // the path, so the path is reported bare -- the same shape used when the
  // whole value is the match.
  if (isKey) {
    sink.add({ path: formatPath(segments), segments });

    return;
  }

  const ctx = valueContext(site, caseSensitive, segments, isKey, context);

  /*
   * SPANS FIRST. A type that can say where the matches are is preferred over one
   * that hands back a pattern, because a pattern is something the CONSUMER runs
   * — on the backtracking engine, in the loop the contract tells them to write.
   */
  const spans = callHighlightSpans(bound.type, value, bound.operand, ctx);

  if (spans) {
    sink.add({
      path: formatPath(segments),
      ranges: spans,
      segments,
    });

    return;
  }

  const query = callHighlight(bound.type, value, bound.operand, ctx);

  // A pattern that can match ZERO CHARACTERS inside this value cannot be looped
  // over. Global `a*` matches "a" at 0, then matches the empty string at 1, and
  // `lastIndex` never advances again — so the `while ((m = query.exec(text)))`
  // loop the contract tells consumers to write spins forever. Every highlighter
  // component writes that loop.
  //
  // Tested against the ACTUAL value rather than guessed from the source, because
  // the source cannot answer it: `a*` matches empty everywhere, `\b` matches
  // empty only inside a word, and `a+` never does. One scan settles it for this
  // value, which is the only value this highlight describes.
  const loops = query !== null && !matchesEmpty(query);

  sink.add(
    query && loops
      ? {
          path: formatPath(segments),
          // A FRESH instance per hit. The type compiles its highlighter once
          // and hands back the same object every time, and a `g` pattern
          // carries lastIndex -- so a caller iterating the returned highlights
          // with .test()/.exec() would get alternating answers from what looks
          // like an independent regex.
          // ALWAYS global, and always a fresh instance. A custom type may
          // legitimately return a non-global RegExp, and a consumer looping on
          // `while (m = query.exec(text))` — which is what every highlighter
          // component does — would then spin forever, because exec without `g`
          // never advances lastIndex. Normalising here means no third-party
          // type can hang a caller's UI.
          query: new RegExp(
            query.source,
            query.flags.includes('g') ? query.flags : `${query.flags}g`,
          ),
          segments,
        }
      : /*
         * No pattern to report. Either the match has no textual footprint at all
         * — a range, a boolean — or the pattern is zero-width here, in which case
         * "the whole value matched" is both true and the only answer a consumer
         * can act on without hanging.
         */
        { path: formatPath(segments), segments },
  );
};

const compileClause = (
  node: Expression,
  context: EvaluationContext,
  field: Field | null,
  clauseCaseSensitive: boolean,
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
        // `:=` may compare against a boolean or null, whose `value` is not a
        // string. This is the RAW text for diagnostics only, so the literal's own
        // spelling is exactly right.
        String(node.expression.value),
      );
      const operator = node.operator.operator;

      return (item, sink) =>
        anyCandidateMatches(
          candidatesFor(item),
          sink,
          exhaustiveScan(context),
          (candidate) => {
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
              return record(
                callPredicate(
                  bound.type,
                  'equals',
                  () => bound.type.equals(read.value, bound.operand),
                  failureSite(
                    bound,
                    site,
                    candidate[0],
                    node.expression.location,
                    read.value,
                    context,
                  ),
                ),
              );
            }

            const ordering = compareOne(
              bound,
              read.value,
              site,
              candidate[0],
              node.expression.location,
              context,
            );

            if (ordering === null) {
              return signalValueFailure({
                kind: 'incomparable',
                location: node.expression.location,
                onValueError: context.options.onValueError,
                path: pathOf(candidate[0]),
                reason: null,
                site: 'ordered',
                typeName: nameOf(bound.type),
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
          },
        );
    }

    // Match tag: a range, or a single operand.
    if (node.expression.type === 'RangeExpression') {
      return compileRange(
        node.expression,
        node.field,
        caseSensitive,
        context,
        candidatesFor,
      );
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
      anyCandidateMatches(
        candidatesFor(item),
        sink,
        exhaustiveScan(context),
        (candidate) => {
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
              node.expression.location,
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
        },
      );
  }

  // ---- A bare term, or a term inside a field group --------------------------
  //
  // Both reach here. Inside a group `field` is the pushed default and
  // `clauseCaseSensitive` is the enclosing clause's collation; unfielded, the
  // field is null and a scan is always case-insensitive because there is no
  // operator to double.
  const caseSensitive = field ? clauseCaseSensitive : false;

  // A range is a legal member of a field group (`n:(1 OR [2 TO 3])`), and it
  // has no operand token -- so it must be routed before the token path, or it
  // compiles to constant false and quietly drops its rows.
  if (node.type === 'RangeExpression') {
    if (field === null) {
      // An unfielded range has nothing to range over.
      return () => false;
    }

    return compileRange(node, field, caseSensitive, context, candidatesFor);
  }

  const site: OperandSite = field ? { field, kind: 'match' } : { kind: 'scan' };
  const token = toOperandToken(node);

  if (token === null) {
    return () => false;
  }

  const bound = resolveOperand(
    token,
    site,
    caseSensitive,
    context,
    node.location,
    sourceOf(node),
  );

  return (item, sink) =>
    anyCandidateMatches(
      candidatesFor(item),
      sink,
      exhaustiveScan(context),
      (candidate) => {
        const read = readValue(
          bound,
          candidate,
          site,
          caseSensitive,
          false,
          node.location,
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
            candidate[2] ?? false,
            node.location,
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
      },
    );
};

/**
 * Compile a range against a field.
 *
 * Takes the range and its field separately rather than a Tag, because a range
 * is equally legal inside a field group (`n:(1 OR [2 TO 3])`) where there is no
 * Tag wrapping it.
 */
const compileRange = (
  range: Extract<Expression, { type: 'RangeExpression' }>,
  field: Field,
  caseSensitive: boolean,
  context: EvaluationContext,
  candidatesFor: (item: unknown) => Candidate[],
): Predicate => {
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
        field,
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
    // `[* TO *]` -- unbounded at both ends. It is NOT "match everything": the
    // field still has to exist and hold a value, or a record with no such key
    // at all would match a range over it. With no boundary to name a type,
    // "has a readable value here" is the strongest claim available.
    return (item, sink) =>
      anyCandidateMatches(
        candidatesFor(item),
        sink,
        exhaustiveScan(context),
        (candidate) => {
          const [pathRef, raw] = candidate;
          const present = raw !== undefined && raw !== null;

          if (present && sink) {
            // Materialised only for a HIT, which is the point of the trail.
            const segments = pathOf(pathRef);

            sink.add({ path: formatPath(segments), segments });
          }

          return present;
        },
      );
  }

  // Two boundaries of the same TYPE can still be incomparable: `datetime`
  // spans both calendar instants and wall-clock times, and
  // `[2020-06-01 TO 14:30]` is as incoherent as mixing a date with a number.
  // Only the name was checked, so that one slipped through as an empty result.
  if (lower && upper && nameOf(lower.type) === nameOf(upper.type)) {
    // QUERY-side, not value-side: both sides here are operands from the query
    // text, so a type throwing while comparing them is a broken query rather
    // than dirty data, and `onValueError` must not be able to swallow it.
    const ordering = compareOperands(lower, upper, range.location, field);

    if (ordering === null) {
      throw new SiftQLOperandError(
        'Range boundaries are not comparable with each other',
        {
          code: 'MIXED_RANGE_TYPES',
          location: range.location,
          raw: '',
          site: { field, inclusive: true, kind: 'range', side: 'upper' },
        },
      );
    }
  }

  if (lower && upper && nameOf(lower.type) !== nameOf(upper.type)) {
    throw new SiftQLOperandError(
      `Range boundaries resolved to different types: "${nameOf(lower.type)}" and "${nameOf(upper.type)}"`,
      {
        code: 'MIXED_RANGE_TYPES',
        location: range.location,
        raw: '',
        site: { field, inclusive: true, kind: 'range', side: 'upper' },
      },
    );
  }

  const site: OperandSite = {
    field,
    inclusive: true,
    kind: 'range',
    side: 'lower',
  };

  return (item, sink) =>
    anyCandidateMatches(
      candidatesFor(item),
      sink,
      exhaustiveScan(context),
      (candidate) => {
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

        const low = withinBoundary(
          lower,
          range.lower,
          read.value,
          'lower',
          site,
          candidate[0],
          range.location,
          context,
        );
        const high = withinBoundary(
          upper,
          range.upper,
          read.value,
          'upper',
          site,
          candidate[0],
          range.location,
          context,
        );

        if (low === null || high === null) {
          return signalValueFailure({
            kind: 'incomparable',
            location: range.location,
            onValueError: context.options.onValueError,
            path: pathOf(candidate[0]),
            reason: null,
            site: 'range',
            typeName: nameOf(reference.type),
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
      },
    );
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
