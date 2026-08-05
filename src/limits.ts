/**
 * The structural limits, in one place because they have to agree.
 *
 * Two of these bound what `parse()` will accept. The third bounds what
 * `serialize()` and the evaluator will accept, and it is DERIVED from the other
 * two rather than chosen independently — that derivation is the point. An AST
 * limit set below what the parser can emit would make `serialize(parse(q))`
 * throw for a query siftql had just accepted, breaking the round-trip law; set
 * above, and a hand-built tree could still exhaust the call stack, which is what
 * these exist to prevent.
 *
 * WHY A DECLARED NUMBER RATHER THAN A MEASURED ONE. The obvious alternative is
 * to find the depth at which the stack actually overflows and stop just short.
 * That was tried and abandoned: on one Node 24 run, a 3,000-deep tree threw
 * `RangeError` while a 3,500-deep tree serialized fine. The available stack is a
 * property of the runtime, the thread, JIT state, and how deep the CALLER
 * already is — not of this code — so there is no measurable boundary to sit
 * below. A declared limit, documented and identical everywhere, is a contract;
 * a measured one is a coincidence.
 */

/** Deepest nesting of parentheses and field groups `parse()` will accept. */
export const MAX_DEPTH = 200;

/**
 * Most clauses one query may contain.
 *
 * Not a nesting limit: `a OR a OR a…` is flat to read and 2,000 levels deep as a
 * left-leaning tree, so this bounds tree depth just as directly as MAX_DEPTH
 * does.
 */
export const MAX_CLAUSES = 2000;

/**
 * Deepest AST `serialize()` and the evaluator will walk.
 *
 * Exactly what the parser can emit — a fully parenthesised maximal query is
 * MAX_DEPTH levels of nesting wrapped around a MAX_CLAUSES-long chain — so
 * every tree siftql produces round-trips, and anything deeper was hand-built or
 * arrived as JSON. Those are refused with a located `SiftQLArgumentError`
 * instead of a raw `RangeError` that names none of the offending structure.
 */
export const MAX_AST_DEPTH = MAX_CLAUSES + MAX_DEPTH;

/**
 * Most node visits `serialize()` and the evaluator will spend on one tree.
 *
 * VISITS, not distinct nodes, and that distinction is the whole reason this
 * exists. Depth alone bounds a chain but not the WORK, because an AST may share
 * a subtree: `{ left: v, right: v }` nested 24 deep is 49 objects and 16 million
 * paths. A depth check waved it through, `assertNode` then took 32 seconds on 29
 * objects, and `serialize()` produced a 100 MB string from 49 — both from a
 * payload small enough to arrive as JSON, which `types.ts` advertises as the
 * supported transport.
 *
 * Sharing is not itself an error and is not refused: `const t = builders.term
 * ('a'); builders.or(t, t)` is a natural thing to write and costs two visits.
 * What is refused is an EXPANSION too large to print or compile, which is the
 * quantity that actually hurts.
 *
 * The value is empirical: the largest tree `parse()` can emit — 199 levels of
 * parentheses around a 1,800-clause chain — expands to about 15,000 visits, so
 * 500,000 leaves a factor of thirty for hand-built trees while capping a
 * serialized string at a few megabytes and this check at tens of milliseconds.
 */
export const MAX_AST_NODES = 500_000;
