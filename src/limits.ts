/**
 * The structural limits, in one place because they have to agree.
 *
 * Two of these bound what `parse()` will accept. The other two bound what
 * `serialize()` and the evaluator will accept, and MAX_AST_DEPTH is DERIVED from
 * the parser's own caps rather than chosen independently — that derivation is the point. An AST
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
 * Most dotted segments one field path may have: `a.b.c` is three.
 *
 * Exists so {@link MAX_AST_NODES}'s derivation is true. Nothing capped this or
 * {@link MAX_WILDCARD_SEGMENTS}, so the "largest tree `parse()` can emit" was
 * not 11,996 visits — a 2,000-clause query of 120-segment paths is 990 kB of
 * text, parses fine, and expands to over 500,000 visits, at which point
 * `serialize()`, `filter()`, `test()` and `highlight()` all refuse the tree
 * `parse()` had just produced. That is the exact failure this file's opening
 * paragraph says it is designed to prevent.
 *
 * 32 is far past any real record shape — the deepest path in a typical document
 * is single digits — while keeping the parser's output inside the node budget.
 */
export const MAX_FIELD_SEGMENTS = 32;

/**
 * Most segments one wildcard pattern may have: `a*b?c` is five.
 *
 * Same reason as {@link MAX_FIELD_SEGMENTS}. `*` runs are collapsed before this
 * is counted, so it bounds meaningful alternation points rather than typing.
 *
 * 512 rather than something tighter because the README demonstrates 200 stars
 * against a 5,000-character value — `'*a'.repeat(200)` is 400 segments — and a
 * cap that quietly retired a documented capability would be the narrowing
 * getting ahead of itself.
 *
 * Per-clause caps alone cannot bound the tree, because the PRODUCT with
 * {@link MAX_CLAUSES} is what expands: 2,000 clauses of 512 segments is millions
 * of visits whatever each cap says. {@link MAX_AST_NODES} is therefore checked
 * by `parse()` itself, so the product is bounded where it actually matters.
 */
export const MAX_WILDCARD_SEGMENTS = 512;

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
 * The value is empirical, and the derivation below is only sound because
 * {@link MAX_FIELD_SEGMENTS} and {@link MAX_WILDCARD_SEGMENTS} exist. Without
 * them a query the parser accepts could expand past this cap, and every entry
 * point would then refuse a tree `parse()` had just produced — see those two
 * constants for the 990 kB query that did exactly that.
 *
 * Parenthesis-only shapes: 199 levels of parentheses around a 1,800-clause
 * chain expands to 11,194 visits, and the true maximum over every paren/clause
 * split is 11,996 (parentheses consume the clause budget too, so the fully
 * nested shape is not the largest).
 *
 * THIS CONSTANT DOES NOT SIT ABOVE THE MAXIMAL QUERY, and an earlier version of
 * this comment claimed it did — citing a `test/limits.test.ts` that has never
 * existed. A maximal shape (MAX_CLAUSES tags, each with a MAX_FIELD_SEGMENTS
 * path and a MAX_WILDCARD_SEGMENTS value) is accepted at 453 clauses and 499,202
 * visits and refused at 454, so the budget is roughly a quarter of what the per-clause caps alone
 * would permit.
 *
 * That is not a defect, but it is the whole reason `parse()` checks this at
 * runtime rather than trusting the caps: what expands is the PRODUCT of clause
 * count and segments per clause, and no per-clause cap can bound a product.
 * The invariant that matters — whatever `parse()` accepts, every consumer
 * accepts — is asserted by P9 in `test/properties.test.ts`.
 */
export const MAX_AST_NODES = 500_000;
