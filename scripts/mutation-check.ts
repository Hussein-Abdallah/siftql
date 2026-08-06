/**
 * Does the regression diff actually catch changes? Measured, not assumed.
 *
 * WHY THIS EXISTS. `npm run diff` is the tool this project leans on before a
 * commit, and a diagnostic that silently reports "no differences" for a change
 * it is staring at is worse than no diagnostic, because it stops you looking.
 *
 * This measures the property that matters: introduce a KNOWN behaviour change,
 * and see whether the diff reports it. The output is a detection rate and a
 * list of misses.
 *
 * An audit asks a careful reader "can you find a hole?", which depends on their
 * imagination. This asks "what fraction of real changes does it catch?", which
 * does not.
 *
 * EVERY MISS IS A HOLE — either in the harness's comparison or in its corpus.
 * A mutation the corpus cannot reach is not a false alarm; it is the corpus
 * failing to cover a surface, which is exactly how the folding regression
 * survived the commit that introduced it.
 *
 *   npm run mutants
 *   npm run mutants -- --runs 20000
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argRuns = process.argv.indexOf('--runs');
const FIRST_PASS = argRuns === -1 ? 4000 : Number(process.argv[argRuns + 1]);
/** A miss at low volume is retried here, to separate "blind" from "too few". */
const RETRY = FIRST_PASS * 6;

interface Mutation {
  /** What behaviour this changes, in the words of the contract it breaks. */
  readonly label: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

/**
 * One mutation per surface, each a change a careless edit could really make.
 *
 * Deliberately NOT exotic. The point is coverage of ordinary mistakes — a
 * flipped comparison, a dropped escape, an off-by-one, a changed code — because
 * those are what a regression actually looks like.
 */
const MUTATIONS: readonly Mutation[] = [
  {
    file: 'src/parser/tokenizer.ts',
    find: 'recovered ??= STRAY_SKIPPED;',
    label: 'tokenizer: a skipped stray is no longer marked recovered',
    replace: '',
  },
  /*
   * DELIBERATELY ABSENT: raising `compileExpression`'s own MAX_AST_DEPTH guard.
   *
   * It reported as a miss and was not one. `assertNode` refuses a too-deep tree
   * before compilation begins, so that guard is defence in depth and cannot be
   * observed through any public entry point — an EQUIVALENT MUTANT. Chasing it
   * would have meant widening the corpus to reach something unreachable.
   *
   * This is the standing hazard of the technique: a battery is only as honest
   * as its mutations, and a reported "miss" is a claim to verify before it is a
   * hole to fix.
   */
  {
    file: 'src/values/scalars.ts',
    find: "return ctx.site.kind === 'scan'\n      ? folded.includes(operand.needle)\n      : folded === operand.needle;",
    label: 'string: a fielded clause matches by containment instead of exactly',
    replace: 'return folded.includes(operand.needle);',
  },
  {
    file: 'src/values/scalars.ts',
    find: '  equals: (value, operand) =>\n    (operand.caseSensitive ? value : value.toLowerCase()) === operand.needle,',
    label: 'string: := ignores case sensitivity',
    replace:
      '  equals: (value, operand) => value.toLowerCase() === operand.needle,',
  },
  {
    file: 'src/serialize.ts',
    find: '  if (RESERVED_WORDS.has(value) || KEYWORD_LITERALS.has(value)) {',
    label: 'serialize: keywords are no longer escaped on the way out',
    replace: '  if (false && RESERVED_WORDS.has(value)) {',
  },
  {
    file: 'src/regex/linear.ts',
    find: '            at = end > start ? end : start + 1;',
    label: 'regex: spans() advances one character too far',
    replace: '            at = end > start ? end + 1 : start + 1;',
  },
  {
    /*
     * NOT the linear/binary lookup threshold, which was the first thing tried
     * here. Switching `ranges.length <= 8` to `<= 0` changes which branch runs
     * over the same sorted, disjoint ranges and cannot change an answer — an
     * EQUIVALENT MUTANT. It showed up as a "miss" and was not one; a mutation
     * battery is only as honest as its mutations.
     */
    file: 'src/regex/linear.ts',
    find: '      if (code >= from && code <= to) {',
    label: 'regex: a character class excludes its upper bound',
    replace: '      if (code >= from && code < to) {',
  },
  {
    file: 'src/limits.ts',
    find: 'export const MAX_CLAUSES = 2000;',
    label: 'limits: the clause cap is halved',
    replace: 'export const MAX_CLAUSES = 1000;',
  },
  {
    file: 'src/limits.ts',
    find: 'export const MAX_FIELD_SEGMENTS = 32;',
    label: 'limits: the field-path cap is halved',
    replace: 'export const MAX_FIELD_SEGMENTS = 16;',
  },
  {
    file: 'src/engine/prune.ts',
    find: "    case 'MissingExpression':\n      return null;",
    label: 'prune: a hole is kept instead of eliminated',
    replace: "    case 'MissingExpression':\n      return node;",
  },
  {
    file: 'src/engine/highlight.ts',
    find: '      if (!seen.has(key)) {',
    label: 'highlight: duplicate hits are no longer collapsed',
    replace: '      if (true) {',
  },
  {
    file: 'src/errors.ts',
    find: "      details.code ?? 'SYNTAX',",
    label: 'errors: a syntax error reports a different code',
    replace: "      details.code ?? 'MUTATED_CODE',",
  },
  {
    file: 'src/engine/evaluate.ts',
    find: 'const ordering = readOrdering(bound.type);',
    label: 'evaluate: an ordered comparison silently reports no ordering',
    replace: 'const ordering = undefined;',
  },
  {
    file: 'src/engine/access.ts',
    find: "  segments.join('.');",
    label: 'access: a highlight path is joined with a different separator',
    replace: "  segments.join('/');",
  },
  {
    file: 'src/parser/parser.ts',
    find: '\'The required marker "+" is reserved and not supported in this version\'',
    label: 'parser: a refusal message is reworded',
    replace: "'MUTATED refusal text'",
  },
  {
    file: 'src/values/patterns.ts',
    find: '      if (haystack.length !== value.length || operand.literals.length === 0) {',
    label: 'wildcard: the length-changing fold guard is removed',
    replace: '      if (operand.literals.length === 0) {',
  },
  {
    file: 'src/temporal/resolve.ts',
    find: 'Number.isFinite',
    label: 'temporal: a non-finite instant is accepted',
    replace: 'Number.isNaN',
  },
  /*
   * Below: the surfaces a round-eleven auditor found uncovered. Fourteen
   * mutations aimed at them were caught ZERO times, while the battery above
   * reported 100% — the battery was measuring the corpus's own shape back at
   * itself. A rate is only as honest as the surfaces its mutations reach.
   */
  {
    file: 'src/errors.ts',
    find: '    this.site = details.site;\n    this.raw = details.raw;',
    label: 'errors: an operand error reports a different site and raw value',
    replace: "    this.site = 'scan';\n    this.raw = 'MUTATED';",
  },
  {
    file: 'src/errors.ts',
    find: '    this.argument = details.argument;\n    this.received = details.received;',
    label: 'errors: an argument error names a different argument',
    replace:
      "    this.argument = 'MUTATED';\n    this.received = details.received;",
  },
  {
    file: 'src/engine/create.ts',
    find: "createEngine({ ...options, ...assertOptions(extra, 'engine.extend') })",
    label: 'engine: extend() resets instead of merging over the parent',
    replace: "createEngine(assertOptions(extra, 'engine.extend'))",
  },
  {
    file: 'src/engine/evaluate.ts',
    find: 'return record(ordering > 0);',
    label: 'evaluate: `:>` includes its own boundary',
    replace: 'return record(ordering >= 0);',
  },
  {
    file: 'src/engine/evaluate.ts',
    find: 'return record(ordering <= 0);',
    label: 'evaluate: `:<=` excludes its own boundary',
    replace: 'return record(ordering < 0);',
  },
  {
    file: 'src/parser/parser.ts',
    find: 'if (token.segments.length > MAX_FIELD_SEGMENTS) {',
    label: 'limits: the field-path cap moves while the message still says 32',
    replace: 'if (token.segments.length > 16) {',
  },
];

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const main = (): void => {
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const head = git(repo, 'rev-parse', '--short', 'HEAD');

  if (git(repo, 'status', '--porcelain').length > 0) {
    console.log(
      'working tree is dirty — commit or stash first, so the mutant differs\nfrom HEAD only by the mutation under test.',
    );
    process.exitCode = 1;

    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'siftql-mutants-'));
  const mutant = join(scratch, 'mutant');

  console.log(
    `mutating a worktree at ${head}, ${String(MUTATIONS.length)} mutations`,
  );
  console.log(
    `${String(FIRST_PASS)} cases each, misses retried at ${String(RETRY)}\n`,
  );

  const missed: string[] = [];
  const invalid: string[] = [];

  let detected = 0;

  try {
    git(repo, 'worktree', 'add', '--detach', '--quiet', mutant, head);
    execFileSync('ln', [
      '-sfn',
      join(repo, 'node_modules'),
      join(mutant, 'node_modules'),
    ]);

    for (const mutation of MUTATIONS) {
      const path = join(mutant, mutation.file);
      const before = readFileSync(path, 'utf8');

      if (!before.includes(mutation.find)) {
        invalid.push(
          `${mutation.label} — anchor not found in ${mutation.file}`,
        );
        continue;
      }

      const after = before.replace(mutation.find, mutation.replace);

      if (after === before) {
        // A no-op probe: the anchor exists but nothing changed. Not a miss.
        continue;
      }

      writeFileSync(path, after);

      const run = (runs: number): boolean => {
        const output = execFileSync(
          'npx',
          ['tsx', 'scripts/regression-diff.ts', head],
          {
            cwd: mutant,
            encoding: 'utf8',
            env: { ...process.env, SIFTQL_DIFF_RUNS: String(runs) },
            maxBuffer: 64 * 1024 * 1024,
          },
        );

        return !output.includes('no behavioural differences');
      };

      let caught = false;

      try {
        caught = run(FIRST_PASS) || run(RETRY);
      } catch {
        // A mutation that makes the harness itself crash still counts as a
        // detected change — silence is the only failure mode that matters.
        caught = true;
      }

      writeFileSync(path, before);

      if (caught) {
        detected += 1;
        console.log(`  caught   ${mutation.label}`);
      } else {
        missed.push(mutation.label);
        console.log(`  MISSED   ${mutation.label}`);
      }
    }
  } finally {
    try {
      git(repo, 'worktree', 'remove', '--force', mutant);
    } catch {
      // Fall through to prune, which is the recovery.
    }

    try {
      git(repo, 'worktree', 'prune');
    } catch {
      // Nothing to prune.
    }

    rmSync(scratch, { force: true, recursive: true });
  }

  const total = detected + missed.length;

  console.log(
    `\n${String(detected)} of ${String(total)} mutations detected${total === 0 ? '' : ` (${((detected / total) * 100).toFixed(0)}%)`}`,
  );

  if (invalid.length > 0) {
    console.log(
      `\n${String(invalid.length)} mutation(s) could not be applied — the anchor moved, so this\nfile needs updating before the number above means anything:`,
    );

    for (const entry of invalid) {
      console.log(`  ${entry}`);
    }
  }

  if (missed.length > 0) {
    console.log(
      '\nEvery miss is a hole in the diff — in its comparison, or in a corpus that\ncannot reach the surface. Neither is acceptable in a tool used to decide\nwhether a change was safe:',
    );

    for (const entry of missed) {
      console.log(`  ${entry}`);
    }

    process.exitCode = 1;
  }
};

main();
