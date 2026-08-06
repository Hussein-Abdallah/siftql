/**
 * Scratch playground for trying siftql out.
 * NOT part of the published package — edit freely and re-run:
 *
 *   npm run playground
 *
 * (or: npx tsx playground.ts)
 */
import {
  createEngine,
  filter,
  highlight,
  parse,
  serialize,
  SiftQLOperandError,
  SiftQLSyntaxError,
  SiftQLValueError,
  type EvaluateOptions,
} from './src/index.js';
import {
  claimed,
  DECLINED,
  defineValueType,
  MISS,
  resolved,
} from './src/registry.js';

/* eslint-disable no-console */

/**
 * How a consumer would actually report a siftql failure: every error class
 * carries a machine-readable `code`, and the three below also carry the source
 * span that caused it.
 */
const firstLine = (message: string): string =>
  message.split('\n')[0] ?? message;

const describe = (error: unknown): string => {
  if (
    error instanceof SiftQLSyntaxError ||
    error instanceof SiftQLOperandError ||
    error instanceof SiftQLValueError
  ) {
    const at = String(error.location.start);

    return `[${error.name} @${at} ${error.code}] ${firstLine(error.message)}`;
  }

  return error instanceof Error
    ? `[${error.name}] ${firstLine(error.message)}`
    : String(error);
};

// Sample rows resembling a task board.
const rows = [
  {
    archived: false,
    assignee: { email: 'ada@example.com', name: 'Ada Lovelace' },
    createdAt: '2020-06-15T10:00:00Z', // ISO string
    estimate: null,
    id: 'a',
    labels: ['frontend', 'urgent'],
    priority: 3,
    status: 'In Progress',
    title: 'Ship the search box',
  },
  {
    archived: true,
    assignee: { email: 'alan@example.com', name: 'Alan Turing' },
    createdAt: '2019-01-01',
    estimate: 8,
    id: 'b',
    labels: ['backend'],
    priority: 1,
    status: 'done',
    title: 'Refactor the parser',
  },
  {
    archived: false,
    assignee: { email: 'grace@example.com', name: 'Grace Hopper' },
    createdAt: 1_593_000_000_000, // epoch millis
    estimate: 3,
    id: 'c',
    labels: ['backend', 'urgent'],
    priority: 2,
    status: 'inactive',
    title: 'Fix inactive user bug',
  },
  {
    archived: false,
    assignee: { email: 'byron@example.com', name: 'ada byron' },
    createdAt: new Date('2021-03-01T00:00:00Z'), // Date object
    estimate: 2,
    id: 'd',
    labels: [],
    priority: 5,
    status: 'active',
    title: 'Write the docs',
  },
];

const run = (query: string, options: EvaluateOptions = {}) => {
  try {
    const matches = filter(query, rows, options).map((row) => row.id);
    console.log('OK    ', query.padEnd(42), '=>', JSON.stringify(matches));
  } catch (error) {
    console.log('ERROR ', query.padEnd(42), '=>', describe(error));
  }
};

console.log('--- unfielded is loose, fielded is exact ---');
run('parser'); //                 b     bare word CONTAINS
run('ada'); //                    a,d   both Adas
run('title:parser'); //           -     naming a field means exact
run('title:"Refactor the parser"'); //  b
run('title:*parser*'); //         b     containment when asked for
run('status:active'); //          d     does NOT match "inactive"
run('status:*active*'); //        c,d

console.log('\n--- case: insensitive by default, `::` when you mean it ---');
run('status:"in progress"'); //   a     quotes hold a phrase, not case
run('status::"In Progress"'); //  a
run('status::"in progress"'); //  -     right query, wrong case
run('title:"*user*"'); //         c
run('title::"*User*"'); //        -

console.log(
  '\n--- comparison operators with date / date-time / epoch / Date ---',
);
run('createdAt:>=2020-01-01'); // a,c,d   three storage shapes, one query
run('createdAt:<2020-01-01'); //  b
run('createdAt:>=2020-06-15T09:00:00+02:00'); // a,c,d  offset -> 07:00Z
run('createdAt:>=2020-06-15T13:00:00+02:00'); // c,d    11:00Z drops a
// Note: no quoting needed despite the colons.

console.log('\n--- inclusive >= vs strict > (boundary lands on row a) ---');
run('priority:>=3'); //           a,d
run('priority:>3'); //            d       (a dropped)
run('priority:<=3'); //           a,b,c
run('priority:<3'); //            b,c     (a dropped)
run('priority:=3'); //            a

console.log('\n--- ranges: inclusive, exclusive, mixed, half-open ---');
run('priority:[2 TO 3]'); //      a,c
run('priority:{1 TO 5}'); //      a,c
run('priority:[2 TO 5}'); //      a,c
run('priority:{1 TO 3]'); //      a,c
run('priority:[* TO 2]'); //      b,c
run('priority:[3 TO *]'); //      a,d
run('createdAt:[2020-01-01 TO 2020-12-31]'); // a,c
run('createdAt:[2020-01-01 TO *]'); //          a,c,d

console.log('\n--- booleans, null, arrays, nested paths ---');
run('archived:true'); //          b
run('archived:false'); //         a,c,d
run('archived:"true"'); //        -       quoted = the 4-char string
run('estimate:null'); //          a
run('labels:urgent'); //          a,c     array: any element matches
run('assignee.name:"Grace Hopper"'); //   c
run('assignee.email:*@example.com'); //   a,b,c,d

console.log('\n--- wildcards and regex ---');
run('title:Write*'); //           d
run('title:*docs'); //            d       leading wildcard works
run('title:*the*'); //            a,b,d
run(String.raw`title:Fix\ inactive*`); // c   escaped space
run('assignee.name:/^A/'); //     a,b     regex keeps its own case rules
run('assignee.name:/^a/i'); //    a,b,d   explicit i flag

console.log('\n--- boolean logic, grouping, negation ---');
run('archived:false AND priority:>=3'); //   a,d
run('status:done OR status:active'); //      b,d
run('status:(done OR active)'); //           b,d   field group
run('NOT archived:true'); //                 a,c,d
run('-archived:true'); //                    a,c,d
run('urgent backend'); //                    c     implicit AND
run('labels:urgent AND (priority:>=3 OR status:inactive)'); // a,c

console.log(
  '\n--- rejected (SiftQLOperandError: no ordering / not a real date) ---',
);
run('title:>="m"'); //            free text has no defensible ordering
run('createdAt:>=2021-02-29'); // shaped like a date, is not one
run('createdAt:>=notadate');

console.log('\n--- rejected (SiftQLSyntaxError) ---');
run('status: in progress'); //    space after the operator
run('priority:>true'); //         booleans do not order
run('status:(a OR b:c)'); //      a field group cannot nest a field
run('title:foo^2'); //            ^ reserved for v0.2 boost

console.log('\n--- dirty data: skip (default) vs throw ---');
const dirty = [
  { when: '2020-06-01', who: 'ada' },
  { when: 'n/a', who: 'alan' },
  { when: '2021-01-01', who: 'grace' },
];
const dirtyRun = (query: string, options: EvaluateOptions = {}) => {
  const label = `${query} ${JSON.stringify(options)}`.padEnd(42);

  try {
    const who = filter(query, dirty, options).map((row) => row.who);
    console.log('OK    ', label, '=>', JSON.stringify(who));
  } catch (error) {
    console.log('ERROR ', label, '=>', describe(error));
  }
};
dirtyRun('when:>=2020-01-01'); //                        ada,grace
dirtyRun('when:>=2020-01-01', { onValueError: 'throw' }); // throws
dirtyRun('ada', { onValueError: 'throw' }); //           a scan NEVER errors

console.log('\n--- per-engine config: two engines, one process ---');
const euro = createEngine({ dateFormat: 'DD-MM-YYYY' });
const usa = createEngine({ dateFormat: 'MM-DD-YYYY' });
const dates = [{ d: '01-06-2020' }, { d: '15-06-2020' }];
console.log(
  'OK     DD-MM-YYYY  d:>=05-06-2020            =>',
  JSON.stringify(euro.filter('d:>=05-06-2020', dates).map((row) => row.d)),
);
console.log(
  'OK     MM-DD-YYYY  d:>=05-06-2020            =>',
  JSON.stringify(usa.filter('d:>=05-06-2020', dates).map((row) => row.d)),
);

const seconds = createEngine({
  parseDate: (value) =>
    typeof value === 'number' ? new Date(value * 1000) : null,
});
console.log(
  'OK     parseDate: epoch SECONDS              =>',
  JSON.stringify(seconds.filter('at:>=2020-01-01', [{ at: 1_593_000_000 }])),
);
console.log(
  'OK     matchKeys: true                       =>',
  JSON.stringify(
    filter('colour', [{ colour: 'red' }, { size: 'l' }], { matchKeys: true }),
  ),
);

console.log(
  '\n--- custom value type: semver in ~25 lines, no core changes ---',
);
const parseSemver = (text: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text);

  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};
const semver = defineValueType<number[], number[]>({
  coerceValue: (value) => {
    if (typeof value !== 'string') return MISS;
    const parsed = parseSemver(value);
    return parsed === null ? MISS : resolved(parsed);
  },
  equals: (value, operand) => value.every((part, i) => part === operand[i]),
  name: 'semver',
  ordering: {
    compare: (value, operand) => {
      for (const [i, part] of value.entries()) {
        if (part !== operand[i]) return part - (operand[i] ?? 0);
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
const releases = createEngine({ types: [semver] });
const versions = [
  { v: '1.2.3' },
  { v: '1.10.0' },
  { v: '0.9.9' },
  { v: '2.0.0' },
];
console.log(
  'OK     v:>=1.2.3                             =>',
  JSON.stringify(releases.filter('v:>=1.2.3', versions).map((r) => r.v)),
  '  (lexically "1.10.0" < "1.2.3")',
);
console.log(
  'OK     v:[1.0.0 TO 1.99.99]                  =>',
  JSON.stringify(
    releases.filter('v:[1.0.0 TO 1.99.99]', versions).map((r) => r.v),
  ),
  '  ranges for free',
);
console.log(
  'OK     resolution order                      =>',
  releases.types
    .describe()
    .map((t) => `${t.name}${t.ordered ? '*' : ''}`)
    .join(' → '),
);

console.log('\n--- tolerant mode: search-as-you-type ---');
for (const partial of [
  'status:',
  'archived:true AND',
  '(priority:>2',
  'title:"Ship',
]) {
  const ast = parse(partial, { tolerant: true });
  console.log(
    'OK    ',
    JSON.stringify(partial).padEnd(42),
    '=>',
    `${JSON.stringify(serialize(ast))}  (${ast.type})`,
  );
}

console.log('\n--- regexes cannot backtrack: they run on an automaton ---');
run('v:/^(a+)+$/'); //      runs in linear time; RegExp would take seconds
run('v:/(a*)*/'); //        same
run('v:/((a+))+/'); //      same, however it is grouped
run('title:/(a|b)*/'); //   an ordinary pattern
run('title:/^Wr.+e/'); //   an ordinary pattern
run('title:*i*t*h*e*s*e*'); // wildcards use a two-pointer glob, not a regex
// Backreferences and lookaround are REFUSED -- no engine matches them in
// guaranteed linear time. createEngine({ regexGuard: false }) runs them on
// RegExp, and the risk is then yours.

console.log('\n--- highlight: which fields matched, and what to light up ---');
const hl = (query: string) => {
  const found = highlight(query, rows[0]).map(
    (entry) => entry.path + (entry.query ? ` ${String(entry.query)}` : ''),
  );
  console.log('OK    ', query.padEnd(42), '=>', JSON.stringify(found));
};
hl('status:"In Progress"'); //                     status
hl('search'); //                                   title (unfielded, unanchored)
hl('labels:urgent'); //                            labels.1 -- the element, not the array
hl('priority:>=3'); //                             priority, no pattern: whole value matched
hl('status:"In Progress" OR status:done'); //      ONLY the branch that matched
hl('status:done OR status:"In Progress"'); //      same answer, either order
hl('NOT status:done'); //                          [] -- status:done did NOT match
hl('title:*search* AND NOT archived:true'); //     only the half that matched
hl('status:done AND title:*search*'); //           [] -- the AND failed

console.log('\n--- parse / serialize round trip ---');
for (const query of [
  "priority:>=3   AND  status:'active'",
  'createdAt:>=2020-06-01T12:00:00+02:00',
  'labels:urgent AND (a OR NOT b)',
  'h:{* TO 2]',
]) {
  console.log('OK    ', query.padEnd(42), '=>', serialize(parse(query)));
}
