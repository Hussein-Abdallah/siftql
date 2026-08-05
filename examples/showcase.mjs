/**
 * siftql — runnable examples.
 *
 *   npm run examples
 *
 * Imports from ../dist, so everything below is the real published package,
 * not the source tree.
 */

import {
  claimed,
  createEngine,
  DECLINED,
  defineValueType,
  filter,
  parse,
  resolved,
  serialize,
  MISS,
  test,
} from '../dist/index.js';

/* ------------------------------------------------------------------ output */

const BOLD = '[1m';
const DIM = '[90m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const OFF = '[0m';

const section = (title) =>
  console.log(`\n${BOLD}${title}${OFF}\n${'─'.repeat(84)}`);

const note = (text) => console.log(`${DIM}  ${text}${OFF}`);

/** Run a query and print the matching ids. */
const show = (query, comment = '', options) => {
  const label = query === '' ? "''" : query;

  try {
    const hits = filter(query, TASKS, options).map((task) => task.id);

    console.log(
      `  ${label.padEnd(40)} ${GREEN}[${hits.join(', ')}]${OFF}` +
        (comment ? `  ${DIM}${comment}${OFF}` : ''),
    );
  } catch (error) {
    console.log(
      `  ${label.padEnd(40)} ${RED}${error.name}${OFF}  ${DIM}${error.message.split('\n')[0].slice(0, 46)}${OFF}`,
    );
  }
};

/* -------------------------------------------------------------------- data */

const TASKS = [
  {
    id: 1,
    title: 'Ship the search box',
    status: 'In Progress',
    priority: 3,
    assignee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    labels: ['frontend', 'urgent'],
    createdAt: '2020-06-15T10:00:00Z',
    archived: false,
    estimate: null,
  },
  {
    id: 2,
    title: 'Refactor the parser',
    status: 'done',
    priority: 1,
    assignee: { name: 'Alan Turing', email: 'alan@example.com' },
    labels: ['backend'],
    createdAt: '2019-01-01',
    archived: true,
    estimate: 8,
  },
  {
    id: 3,
    title: 'Fix inactive user bug',
    status: 'inactive',
    priority: 2,
    assignee: { name: 'Grace Hopper', email: 'grace@example.com' },
    labels: ['backend', 'urgent'],
    createdAt: 1_593_000_000_000, // epoch millis
    archived: false,
    estimate: 3,
  },
  {
    id: 4,
    title: 'Write the docs',
    status: 'active',
    priority: 5,
    assignee: { name: 'ada byron', email: 'byron@example.com' },
    labels: [],
    createdAt: new Date('2021-03-01T00:00:00Z'), // Date object
    archived: false,
    estimate: 2,
  },
];

console.log(`\n${BOLD}  siftql — runnable examples${OFF}`);
console.log(`${DIM}  4 tasks. Every result below is real output.${OFF}`);
console.log(
  `${DIM}  1 "Ship the search box"/In Progress  2 "Refactor the parser"/done${OFF}`,
);
console.log(
  `${DIM}  3 "Fix inactive user bug"/inactive    4 "Write the docs"/active${OFF}`,
);

/* ------------------------------------------------------------------------ */
section('1. Quick start');

console.log(
  `  ${DIM}import { filter, test, parse, serialize } from 'siftql';${OFF}\n`,
);
show('status:active', 'filter(query, tasks)');
console.log(
  `  ${'test(query, tasks[0])'.padEnd(40)} ${GREEN}${test('status:"In Progress"', TASKS[0])}${OFF}`,
);
console.log(
  `  ${'serialize(parse(q))'.padEnd(40)} ${GREEN}${serialize(parse("priority:>=3   AND  status:'active'"))}${OFF}  ${DIM}canonicalised${OFF}`,
);

/* ------------------------------------------------------------------------ */
section('2. The core rule — naming a field means you want precision');

note('A bare word is browsing, so it CONTAINS. Naming a field is an');
note('assertion, so it is EXACT. That single split is most of the design.\n');
show('parser', 'unfielded → contains');
show('ada', 'matches both Adas');
show('title:parser', 'fielded → exact → nothing');
show('title:"Refactor the parser"', 'exact, and it matches');
show('title:*parser*', 'containment, when you ask for it');
console.log();
show('status:active', 'does NOT match "inactive" ← the whole point');
show('status:*active*', 'now it does');

/* ------------------------------------------------------------------------ */
section('3. Case — insensitive by default, `::` when you mean it');

note('Quotes hold a phrase together. They never affect case.\n');
show('status:"in progress"', 'insensitive → matches "In Progress"');
show('status::"In Progress"', 'sensitive, correct case');
show('status::"in progress"', 'sensitive, wrong case → nothing');
console.log();
show('title:"*user*"', 'contains, insensitive');
show('title::"*User*"', 'contains, sensitive');

/* ------------------------------------------------------------------------ */
section('4. Numbers, comparisons and ranges');

show('priority:3');
show('priority:>=3');
show('priority:<3');
show('priority:[2 TO 3]', 'inclusive');
show('priority:{1 TO 5}', 'exclusive');
show('priority:[2 TO 5}', 'mixed');
show('priority:[* TO 2]', 'half-open');
show('priority:[3 TO *]', 'half-open');
show('estimate:null', 'unset or explicitly null');

/* ------------------------------------------------------------------------ */
section('5. Dates — the flagship');

note('Task 1 stores an ISO string, 3 an epoch number, 4 a Date object.');
note('All three resolve to real timestamps and compare chronologically.\n');
show('createdAt:>=2020-01-01', 'three storage shapes, one query');
show('createdAt:<2020-01-01');
show('createdAt:[2020-01-01 TO 2020-12-31]', 'temporal range');
show('createdAt:[2020-01-01 TO *]', 'half-open temporal');
console.log();
show('createdAt:>=2020-06-15T09:00:00+02:00', 'offset applied → 07:00Z');
show('createdAt:>=2020-06-15T13:00:00+02:00', '11:00Z, so task 1 drops out');
note('Note the colons: no quoting needed, even inside a range.');

/* ------------------------------------------------------------------------ */
section('6. Booleans, null, arrays and nested paths');

show('archived:true');
show('archived:false');
show('estimate:null');
show('labels:urgent', 'array — matches if ANY element does');
show('labels:backend');
show('assignee.name:"Grace Hopper"', 'nested path');
show('assignee.email:*@example.com', 'nested + wildcard');
show('archived:"true"', 'quoted → the 4-character string, not the keyword');

/* ------------------------------------------------------------------------ */
section('7. Wildcards and regular expressions');

show('title:Write*', '* = many characters');
show('title:*docs', 'leading wildcard works');
show('title:*the*', 'contains');
show('assignee.name:/^A/', 'regex — its own case rules, no implicit i');
show('assignee.name:/^a/i', 'explicit i flag');
show(String.raw`title:Fix\ inactive*`, 'escaped space in a bare term');

/* ------------------------------------------------------------------------ */
section('8. Boolean logic, grouping and negation');

show('archived:false AND priority:>=3');
show('status:done OR status:active');
show('status:(done OR active)', 'field group — no repetition');
show('NOT archived:true');
show('-archived:true', 'same thing, shorter');
show('urgent backend', 'implicit AND of two bare terms');
show('labels:urgent AND (priority:>=3 OR status:inactive)');

/* ------------------------------------------------------------------------ */
section('9. Fail loud — a wrong query is never a silent empty result');

show('title:>="m"', 'string has no ordering');
show('createdAt:>=2021-02-29', 'shaped like a date; is not one');
show('createdAt:>=notadate');
show('priority:>true', 'booleans do not order');
note('Compare: new Date("2021-02-29") silently returns 1 March 2021.');

/* ------------------------------------------------------------------------ */
section('10. Dirty data is a policy, not a crash');

const dirty = [
  { when: '2020-06-01', who: 'ada' },
  { when: 'n/a', who: 'alan' },
  { when: '2021-01-01', who: 'grace' },
];

console.log(
  `  ${"onValueError:'skip'  (default)".padEnd(40)} ${GREEN}${JSON.stringify(
    filter('when:>=2020-01-01', dirty).map((row) => row.who),
  )}${OFF}  ${DIM}bad row skipped${OFF}`,
);

try {
  filter('when:>=2020-01-01', dirty, { onValueError: 'throw' });
} catch (error) {
  console.log(
    `  ${"onValueError:'throw'".padEnd(40)} ${YELLOW}${error.name}${OFF}  ${DIM}for strict pipelines${OFF}`,
  );
}

console.log(
  `  ${'free-text search over the same data'.padEnd(40)} ${GREEN}${JSON.stringify(
    filter('ada', dirty, { onValueError: 'throw' }).map((row) => row.who),
  )}${OFF}  ${DIM}never errors${OFF}`,
);
note('One dirty column can never destroy a free-text search.');

/* ------------------------------------------------------------------------ */
section('11. Per-engine configuration');

const euro = createEngine({ dateFormat: 'DD-MM-YYYY' });
const usa = createEngine({ dateFormat: 'MM-DD-YYYY' });
const rows = [{ d: '01-06-2020' }, { d: '15-06-2020' }];

console.log(
  `  ${"dateFormat: 'DD-MM-YYYY'".padEnd(40)} ${GREEN}${JSON.stringify(
    euro.filter('d:>=05-06-2020', rows).map((row) => row.d),
  )}${OFF}`,
);
console.log(
  `  ${"dateFormat: 'MM-DD-YYYY'  same data".padEnd(40)} ${GREEN}${JSON.stringify(
    usa.filter('d:>=05-06-2020', rows).map((row) => row.d),
  )}${OFF}`,
);
note(
  'Two engines, one process, no shared state. siftql never guesses DD vs MM.',
);

const seconds = createEngine({
  parseDate: (value) =>
    typeof value === 'number' ? new Date(value * 1000) : null,
});

console.log(
  `\n  ${'parseDate: epoch SECONDS'.padEnd(40)} ${GREEN}${
    seconds.filter('at:>=2020-01-01', [{ at: 1_593_000_000 }]).length
  } match${OFF}  ${DIM}any date library plugs in here${OFF}`,
);

console.log(
  `  ${'matchKeys: true'.padEnd(40)} ${GREEN}${JSON.stringify(
    filter('colour', [{ colour: 'red' }, { size: 'l' }], { matchKeys: true }),
  )}${OFF}  ${DIM}search field NAMES too${OFF}`,
);

/* ------------------------------------------------------------------------ */
section('12. Custom value types — no fork, no core changes');

const parseSemver = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text);

  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const semver = defineValueType({
  coerceValue: (value) => {
    if (typeof value !== 'string') return MISS;
    const parsed = parseSemver(value);
    return parsed === null ? MISS : resolved(parsed);
  },
  equals: (value, operand) => value.every((p, i) => p === operand[i]),
  name: 'semver',
  ordering: {
    compare: (value, operand) => {
      for (const [index, part] of value.entries()) {
        if (part !== operand[index]) return part - operand[index];
      }
      return 0;
    },
  },
  parseOperand: (operand) => {
    if (operand.kind !== 'text') return DECLINED;
    const parsed = parseSemver(operand.text);
    return parsed === null ? DECLINED : claimed(parsed);
  },
});

const engine = createEngine({ types: [semver] });
const releases = [
  { v: '1.2.3' },
  { v: '1.10.0' },
  { v: '0.9.9' },
  { v: '2.0.0' },
];

console.log(
  `  ${'v:>=1.2.3'.padEnd(40)} ${GREEN}${JSON.stringify(
    engine.filter('v:>=1.2.3', releases).map((row) => row.v),
  )}${OFF}`,
);
console.log(
  `  ${'v:[1.0.0 TO 1.99.99]'.padEnd(40)} ${GREEN}${JSON.stringify(
    engine.filter('v:[1.0.0 TO 1.99.99]', releases).map((row) => row.v),
  )}${OFF}  ${DIM}ranges for free${OFF}`,
);
note('Lexically "1.10.0" < "1.2.3"; semantically it is greater. ~30 lines,');
note('and ranges/ordering come from core — the type never writes range code.');

console.log(
  `\n  ${'resolution order'.padEnd(40)} ${DIM}${engine.types
    .describe()
    .map((type) => `${type.name}${type.ordered ? '*' : ''}`)
    .join(' → ')}${OFF}`,
);
note('* = ordered. Custom types outrank built-ins; string is last because it');
note('claims everything. `string` being unordered is why title:>="m" throws.');

/* ------------------------------------------------------------------------ */
section('13. Tolerant mode — for search-as-you-type');

for (const partial of [
  'status:',
  'archived:true AND',
  '(priority:>2',
  'title:"Ship',
]) {
  const ast = parse(partial, { tolerant: true });

  console.log(
    `  ${JSON.stringify(partial).padEnd(40)} ${GREEN}${serialize(ast).trim() || '<empty>'}${OFF}  ${DIM}${ast.type}${OFF}`,
  );
}
note(
  'Every recovered node is flagged, so a UI can grey out the clause in flight.',
);

/* ------------------------------------------------------------------------ */
section('14. The AST is a documented public contract');

const ast = parse('status::"In Progress" AND priority:>=3');

console.log(
  `  ${'parse(...)'.padEnd(40)} ${DIM}${ast.type} ${ast.operator.operator}${OFF}`,
);
console.log(
  `  ${'  .left'.padEnd(40)} ${DIM}${ast.left.type} caseSensitive=${ast.left.caseSensitive}${OFF}`,
);
console.log(
  `  ${'  .right'.padEnd(40)} ${DIM}${ast.right.type} ${ast.right.operator.operator}${OFF}`,
);
console.log(
  `  ${'JSON round trip'.padEnd(40)} ${GREEN}${
    serialize(JSON.parse(JSON.stringify(ast))) === serialize(ast)
  }${OFF}  ${DIM}pure JSON: cacheable, hashable, worker-safe${OFF}`,
);

const ROUND_TRIP = [
  'status:active',
  'priority:[2 TO 5}',
  'createdAt:>=2020-06-01T12:00:00+02:00',
  'labels:urgent AND (a OR NOT b)',
  String.raw`title:Fix\ inactive*`,
];

console.log();
for (const query of ROUND_TRIP) {
  const stable =
    serialize(parse(serialize(parse(query)))) === serialize(parse(query));

  console.log(
    `  ${query.padEnd(40)} ${stable ? `${GREEN}stable${OFF}` : `${RED}CHANGED${OFF}`}  ${DIM}parse → serialize → parse${OFF}`,
  );
}

/* ------------------------------------------------------------------------ */
section('Not in 0.1 yet');
console.log(`
  highlight(ast, item)   which fields matched, for UI highlighting
  boost ^2, fuzzy ~2     parsed positions reserved; v0.2
  SQL / Mongo / ES       AST compiles to them without a breaking change
`);
