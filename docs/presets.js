/**
 * The worked examples.
 *
 * Every `expect` in this file was produced by running the query against
 * `data.js` through the published package — none are hand-written. That is
 * what `?selftest` re-checks in the browser: if the dataset is edited and an
 * example quietly starts saying something else, the page says so instead of
 * presenting a caption that no longer matches what the reader can see.
 *
 * Shape:
 *   q        the query
 *   caption  why the answer is what it is — the actual teaching
 *   expect   matched ids, or 'error' when refusing IS the demonstration
 *   options  engine options, when the example is about an option
 *   data     'SEED' (default) | 'AMBIGUOUS_DATES' | 'DIRTY_DATES'
 *   per      per-call evaluate options
 */
export const GROUPS = [
  {
    id: 'text',
    title: 'Text',
    blurb:
      'Naming a field is an assertion, so it matches the whole value. A bare word is browsing, so it matches anywhere.',
    presets: [
      {
        q: 'ada',
        caption:
          'No field, so this is a substring scan across every value — it finds Ada, ada byron, and Sam Adams.',
        expect: [1, 4, 9, 11, 14],
      },
      {
        q: 'assignee.name:ada',
        caption:
          'Nothing. Naming a field means the WHOLE value must equal "ada" — this is the single rule most substring-by-default libraries get wrong.',
        expect: [],
      },
      {
        q: 'assignee.name:*ada*',
        caption: 'Contains, asked for explicitly.',
        expect: [1, 4, 9, 11, 14],
      },
      {
        q: 'assignee.name:"Ada Lovelace"',
        caption: 'Quotes hold a value together so it can contain spaces.',
        expect: [1, 11, 14],
      },
      {
        q: 'assignee.email:ada@example.com',
        caption: 'An @ and a dot need no escaping in value position.',
        expect: [1, 11, 14],
      },
    ],
  },
  {
    id: 'case',
    title: 'Case',
    blurb:
      'Everything ignores case unless you double the colon. Quotes say nothing about case — that is a common and costly confusion.',
    presets: [
      {
        q: 'status:"in progress"',
        caption:
          'Finds "In Progress". Quoting held the space; it did not ask for case.',
        expect: [1, 7],
      },
      {
        q: 'status::"In Progress"',
        caption: 'The doubled colon is what asks for case sensitivity.',
        expect: [1, 7],
      },
      {
        q: 'status::"in progress"',
        caption:
          'Nothing — same query, wrong capitalisation, and now it matters.',
        expect: [],
      },
      {
        q: 'status:active',
        caption:
          'Three rows. It does NOT match "inactive", because a fielded match is the whole value.',
        expect: [4, 10, 13],
      },
      {
        q: 'status:*active*',
        caption:
          'Four rows — now "inactive" is included, because you asked for containment.',
        expect: [3, 4, 10, 13],
      },
    ],
  },
  {
    id: 'numbers',
    title: 'Numbers',
    blurb: 'Bare numeric text is a number. Quote it and it stays text.',
    presets: [
      { q: 'priority:3', caption: 'Numeric equality.', expect: [1, 7, 13] },
      {
        q: 'priority:>3',
        caption: 'Ordered comparison.',
        expect: [4, 5, 6, 10, 12],
      },
      {
        q: 'priority:<2',
        caption: 'And the other direction.',
        expect: [2, 9, 14],
      },
      {
        q: 'priority:"3"',
        caption:
          'Nothing. Quoting made it the one-character STRING "3", which never equals the number 3.',
        expect: [],
      },
      {
        q: 'estimate:>=13',
        caption:
          'Rows with no estimate are skipped rather than treated as zero.',
        expect: [5, 6, 13],
      },
    ],
  },
  {
    id: 'ranges',
    title: 'Ranges',
    blurb:
      'Six forms, and inclusivity is per boundary — the brackets are not decoration. Each example below returns a different set.',
    presets: [
      {
        q: 'priority:[2 TO 4]',
        caption: 'Inclusive both ends.',
        expect: [1, 3, 5, 7, 8, 10, 11, 13],
      },
      {
        q: 'priority:{2 TO 4}',
        caption: 'Exclusive both ends — the 2s and 4s are gone.',
        expect: [1, 7, 13],
      },
      {
        q: 'priority:[2 TO 4}',
        caption: 'Mixed: 2 is in, 4 is out.',
        expect: [1, 3, 7, 8, 11, 13],
      },
      {
        q: 'priority:{2 TO 4]',
        caption: 'Mixed the other way.',
        expect: [1, 5, 7, 10, 13],
      },
      {
        q: 'priority:[* TO 2]',
        caption: 'Half-open — no lower bound.',
        expect: [2, 3, 8, 9, 11, 14],
      },
      {
        q: 'priority:[4 TO *]',
        caption: 'Half-open — no upper bound.',
        expect: [4, 5, 6, 10, 12],
      },
    ],
  },
  {
    id: 'dates',
    title: 'Dates',
    blurb:
      'The reason this package exists. `created` is stored three different ways across these rows — an ISO string, epoch milliseconds, and a real Date — and every query below reads all three chronologically.',
    presets: [
      {
        q: 'created:>=2021-01-01',
        caption:
          'THE FLAGSHIP. Seven rows, stored as strings, numbers and Date objects. One query, no normalising pass.',
        expect: [4, 6, 9, 11, 12, 13, 14],
      },
      {
        q: 'created:>=2020-06-15T09:00:00+02:00',
        caption: 'An offset is a real instant, not decoration.',
        expect: [1, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14],
      },
      {
        q: 'created:>=2020-06-15T13:00:00+02:00',
        caption:
          'Four hours later, and row 1 drops out. Same date, different instant.',
        expect: [4, 5, 6, 7, 9, 10, 11, 12, 13, 14],
      },
      {
        q: 'created:[2019-01-01 TO 2021-01-01]',
        caption:
          'Rows 2 and 6 sit exactly on the boundaries, and inclusive keeps both.',
        expect: [1, 2, 3, 5, 6, 7, 8, 10],
      },
      {
        q: 'created:{2019-01-01 TO 2021-01-01}',
        caption:
          'Exclusive drops both — this is why the bracket style matters.',
        expect: [1, 3, 5, 7, 8, 10],
      },
      {
        q: 'created:2020-06-15T10:00:00Z',
        caption: 'Equality against an exact instant.',
        expect: [1],
      },
      {
        q: 'dueDate:null',
        caption: 'null matches a null value — and an absent key.',
        expect: [3, 7, 9, 11, 14],
      },
      {
        q: 'created:>=2021-02-29',
        caption:
          'REFUSED. 2021 is not a leap year. `new Date("2021-02-29")` silently gives you 1 March instead.',
        expect: 'error',
      },
    ],
  },
  {
    id: 'dateformat',
    title: 'Date layouts',
    blurb:
      'Non-ISO layouts are declared per engine, never guessed. These run against a two-row dataset where 01-06-2020 means different days under each layout.',
    data: 'AMBIGUOUS_DATES',
    presets: [
      {
        q: 'd:>=05-06-2020',
        caption:
          'Under DD-MM-YYYY this reads as 5 June, and only 15 June is later.',
        expect: [2],
        options: { dateFormat: 'DD-MM-YYYY' },
        data: 'AMBIGUOUS_DATES',
      },
      {
        q: 'd:>=05-06-2020',
        caption:
          'Same query, MM-DD-YYYY: now it reads as 6 May, and neither stored value is a real date under that layout.',
        expect: [],
        options: { dateFormat: 'MM-DD-YYYY' },
        data: 'AMBIGUOUS_DATES',
      },
      {
        q: 'd:>=05-06-2020',
        caption:
          'With no layout declared it is not a date at all — it falls through to string, which has no ordering, and says so.',
        expect: 'error',
        data: 'AMBIGUOUS_DATES',
      },
    ],
  },
  {
    id: 'wildcards',
    title: 'Wildcards',
    blurb:
      'Matched by a two-pointer glob, never a regex — so a pattern like *a*a*a*b cannot blow up.',
    presets: [
      {
        q: 'assignee.name:*ada*',
        caption: 'Any run of characters, either side.',
        expect: [1, 4, 9, 11, 14],
      },
      {
        q: 'assignee.name:A?a*',
        caption: '? is exactly one character — Ada and Alan both fit.',
        expect: [1, 2, 4, 11, 12, 14],
      },
      {
        q: 'title:"*inactive*"',
        caption:
          'Wildcards stay live inside quotes; the quotes are only about spacing.',
        expect: [3],
      },
      {
        q: 'title:*a\\**',
        caption:
          'A backslash escapes the asterisk, so this finds the row with a literal a* in its title.',
        expect: [14],
      },
      {
        q: 'status:*',
        caption: 'Everything with that field present.',
        expect: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      },
    ],
  },
  {
    id: 'regex',
    title: 'Regular expressions',
    blurb:
      'Run on a linear-time automaton, not JavaScript’s backtracking engine. Patterns it cannot match in guaranteed linear time are refused rather than run — see the Regex race panel below.',
    presets: [
      {
        q: 'assignee.name:/^A/',
        caption: 'Anchored, case as written.',
        expect: [1, 2, 11, 12, 14],
      },
      {
        q: 'assignee.name:/^A/i',
        caption: 'A regex keeps its OWN flags — : and :: never touch them.',
        expect: [1, 2, 4, 11, 12, 14],
      },
      {
        q: 'title:/^(a+)+$/',
        caption:
          'Returns instantly. This is the classic catastrophic pattern; a backtracking engine takes seconds on the right input.',
        expect: [],
      },
      {
        q: 'title:/(a*)*/',
        caption:
          'REFUSED — a quantifier whose body can match the empty string. Different from the one above: that one runs safely, this one cannot be given JavaScript’s semantics in linear time.',
        expect: 'error',
      },
      {
        q: 'assignee.name:/(?<=A)da/',
        caption: 'REFUSED — lookbehind cannot be expressed in the automaton.',
        expect: 'error',
      },
      {
        q: 'assignee.name:/(?<=A)da/',
        caption:
          'The same pattern with regexGuard off. It runs on RegExp now — and you lose highlight positions and gain unbounded backtracking.',
        expect: [1, 9, 11, 14],
        options: { regexGuard: false },
      },
    ],
  },
  {
    id: 'logic',
    title: 'Logic',
    blurb:
      'AND, OR, NOT, grouping, and a field group that distributes one field across several values.',
    presets: [
      {
        q: 'status:done AND priority:>=5',
        caption: 'Both must hold.',
        expect: [6, 12],
      },
      {
        q: 'status:done priority:>=5',
        caption: 'A space is an implicit AND — same answer.',
        expect: [6, 12],
      },
      {
        q: 'status:done OR status:active',
        caption: 'Either.',
        expect: [2, 4, 6, 8, 10, 12, 13],
      },
      {
        q: 'status:(done OR active)',
        caption:
          'A field group — the field distributes across the alternatives. Same answer, less typing.',
        expect: [2, 4, 6, 8, 10, 12, 13],
      },
      {
        q: 'NOT archived:true',
        caption: 'Negation.',
        expect: [1, 3, 4, 5, 7, 9, 10, 11, 13, 14],
      },
      {
        q: '-archived:true',
        caption: 'The short spelling of the same thing.',
        expect: [1, 3, 4, 5, 7, 9, 10, 11, 13, 14],
      },
      {
        q: '(status:done OR status:active) AND priority:>=4',
        caption: 'Parentheses override precedence, which is OR < AND < NOT.',
        expect: [4, 6, 10, 12],
      },
    ],
  },
  {
    id: 'shapes',
    title: 'Booleans, null, arrays, paths',
    blurb:
      'Only bare lowercase true/false/null are keywords. Everything else is text.',
    presets: [
      {
        q: 'archived:true',
        caption: 'The boolean keyword.',
        expect: [2, 6, 8, 12],
      },
      {
        q: 'archived:"true"',
        caption:
          'Nothing — quoted, so it is the four-character string, and no row stores that.',
        expect: [],
      },
      {
        q: 'estimate:null',
        caption:
          'Three rows: two store null, and one omits the key entirely. Absence reads as null; 0 and "" do not.',
        expect: [3, 7, 11],
      },
      {
        q: 'labels:urgent',
        caption: 'An array matches if any element does.',
        expect: [1, 3],
      },
      {
        q: 'labels:*end*',
        caption: 'And wildcards work per element.',
        expect: [1, 2, 3, 5, 6, 7, 10],
      },
      {
        q: 'assignee.name:"Grace Hopper"',
        caption: 'A dotted path walks into nested objects.',
        expect: [3, 10],
      },
    ],
  },
  {
    id: 'gotchas',
    title: 'Gotchas',
    blurb:
      'Things that look like they should work. Each is shown because a reader will type it — and because what actually happens is more interesting than hiding it.',
    presets: [
      {
        q: 'created:>=2020',
        caption:
          'NOT a year filter. 2020 is the number 2020, so this matched only the rows whose date is stored as epoch millis — every one of which is a larger number.',
        expect: [3, 6, 10],
      },
      {
        q: 'created:>=1591000000000',
        caption:
          'Same trap from the other side. A bare integer is claimed by the number type, so Date-stored rows never compare. Write the date and every storage shape works.',
        expect: [3, 6, 10],
      },
      {
        q: 'created:>=2020-06',
        caption:
          'REFUSED. Year-month is not a date literal, so it fell through to string — and string has no ordering. Loud, rather than a silent text comparison.',
        expect: 'error',
      },
      {
        q: 'assignee.name:>="m"',
        caption:
          'REFUSED for the same reason: strings are not ordered, so > and >= are meaningless on them.',
        expect: 'error',
      },
      {
        q: 'status:>true',
        caption:
          'REFUSED at parse time — a comparison needs a single text or numeric value.',
        expect: 'error',
      },
      {
        q: 'status:',
        caption:
          'REFUSED, with the position and a caret. A wrong query is never a silent empty result.',
        expect: 'error',
      },
      {
        q: '(status:done',
        caption: 'Unclosed group, pointed at exactly.',
        expect: 'error',
      },
    ],
  },
  {
    id: 'tolerant',
    title: 'Tolerant mode',
    blurb:
      'For search-as-you-type, where a query is malformed on almost every keystroke. Same three queries as above — this engine repairs instead of throwing.',
    options: { tolerant: true },
    presets: [
      {
        q: 'status:',
        caption:
          'The hole is pruned, so a half-typed clause matches everything rather than blanking the screen.',
        expect: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        options: { tolerant: true },
      },
      {
        q: 'status:done AND',
        caption: 'A dangling AND collapses to its one real operand.',
        expect: [2, 6, 8, 12],
        options: { tolerant: true },
      },
      {
        q: '(priority:>2',
        caption: 'And the group closes itself.',
        expect: [1, 4, 5, 6, 7, 10, 12, 13],
        options: { tolerant: true },
      },
    ],
  },
  {
    id: 'dirty',
    title: 'Dirty data',
    blurb:
      'A wrong QUERY throws. A bad VALUE in the data is a policy, because real rows are messy and one of them should not take down a search box. Runs against three rows, the middle one holding "n/a".',
    data: 'DIRTY_DATES',
    presets: [
      {
        q: 'when:>=2020-01-01',
        caption:
          'Default: the unparseable row is skipped, the good rows still answer.',
        expect: [1, 3],
        data: 'DIRTY_DATES',
      },
      {
        q: 'when:>=2020-01-01',
        caption:
          'onValueError: throw — now the same data is an error, naming the row, the path and the value.',
        expect: 'error',
        data: 'DIRTY_DATES',
        per: { onValueError: 'throw' },
      },
    ],
  },
  {
    id: 'matchkeys',
    title: 'Matching keys',
    blurb:
      'Off by default. With it on, a term can match the name of a field as well as its contents.',
    presets: [
      {
        q: 'estimate',
        caption: 'One row — and only because its TITLE contains the word.',
        expect: [11],
      },
      {
        q: 'estimate',
        caption:
          'With matchKeys on, every row with an estimate field matches too.',
        expect: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        options: { matchKeys: true },
      },
    ],
  },
];

/** Flat list, for the self-test. */
export const ALL_PRESETS = GROUPS.flatMap((group) =>
  group.presets.map((preset) => ({ ...preset, group: group.id })),
);

/**
 * What the date inspector shows on load.
 *
 * `01-06-2020` is here for one reason: it is the only sample whose verdict
 * CHANGES when a dateFormat is declared. Without it the layout selector
 * appears to do nothing in this panel, and the claim that the inspector
 * respects the option would be true but impossible to check from the screen.
 */
export const INSPECTOR_SAMPLES = [
  '2020-06-01',
  '2020-06-01T12:00:00Z',
  '2020-06-01T12:00:00+02:00',
  '2020/06/15',
  '2020-06-15 10:00:00',
  '14:30',
  // Two different lessons about declared layouts, so both earn a row:
  // `01-06-2020` is ambiguous ORDER (June under DD-MM, January under MM-DD),
  // while `1999.09.09` uses a SEPARATOR that is not built in at all — ISO
  // shapes accept `-` and `/`, never `.`. Try YYYY.MM.DD on the second.
  '01-06-2020',
  '1999.09.09',
  '2021-02-29',
  '2020-13-01',
  '2020-06',
  '2020-06/01',
  'June 1, 2020',
  '1592179200000',
];
