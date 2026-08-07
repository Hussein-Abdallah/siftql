/**
 * The playground's seed data.
 *
 * Built in JavaScript rather than loaded as JSON, because the point of the
 * `created` column is that it holds THREE different storage shapes — an ISO
 * string, epoch milliseconds, and a real `Date` — and JSON can only express
 * two of those. Editing the data panel drops to JSON semantics; that is
 * called out in the UI rather than hidden.
 *
 * Every row earns its place. The properties below are load-bearing for at
 * least one example, so read the comments before trimming anything:
 *
 *   - `created` mixes ISO / epoch / Date across rows, so one query proves
 *     storage shape does not matter.
 *   - `status` contains both "active" and "inactive" so that `status:active`
 *     visibly does NOT substring-match.
 *   - Two assignees are named Ada with different capitalisation.
 *   - Row 9 has an empty `labels` array; row 11 omits `estimate` entirely
 *     (absence, not null); rows 3 and 7 set it to null.
 *   - Row 13 carries an `İstanbul` value for the length-changing case fold.
 *   - Row 14 has a literal asterisk in its title, for escaping.
 */
export const SEED = [
  {
    id: 1,
    title: 'Ship the search box',
    status: 'In Progress',
    priority: 3,
    estimate: 5,
    created: '2020-06-15T10:00:00Z', // ISO string
    dueDate: new Date('2020-07-01T00:00:00Z'),
    archived: false,
    labels: ['frontend', 'urgent'],
    assignee: { name: 'Ada Lovelace', email: 'ada@example.com' },
  },
  {
    id: 2,
    title: 'Refactor the parser',
    status: 'done',
    priority: 1,
    estimate: 8,
    created: '2019-01-01', // date-only ISO, midnight UTC
    dueDate: new Date('2019-02-01T00:00:00Z'),
    archived: true,
    labels: ['backend'],
    assignee: { name: 'Alan Turing', email: 'alan@example.com' },
  },
  {
    id: 3,
    title: 'Fix inactive user bug',
    status: 'inactive',
    priority: 2,
    estimate: null,
    created: 1592179200000, // epoch milliseconds
    dueDate: null,
    archived: false,
    labels: ['backend', 'urgent'],
    assignee: { name: 'Grace Hopper', email: 'grace@example.com' },
  },
  {
    id: 4,
    title: 'Write the docs',
    status: 'active',
    priority: 5,
    estimate: 2,
    created: new Date('2021-03-01T00:00:00Z'), // Date object
    dueDate: new Date('2021-04-01T00:00:00Z'),
    archived: false,
    labels: [],
    assignee: { name: 'ada byron', email: 'byron@example.com' },
  },
  {
    id: 5,
    title: 'Add date range filters',
    status: 'open',
    priority: 4,
    estimate: 13,
    created: '2020-11-20T08:30:00Z',
    dueDate: new Date('2020-12-01T00:00:00Z'),
    archived: false,
    labels: ['frontend', 'dates'],
    assignee: { name: 'Katherine Johnson', email: 'kj@example.com' },
  },
  {
    id: 6,
    title: 'Tighten the regex screening',
    status: 'done',
    priority: 5,
    estimate: 21,
    created: 1609459200000, // 2021-01-01
    dueDate: new Date('2021-01-15T00:00:00Z'),
    archived: true,
    labels: ['security', 'backend'],
    assignee: { name: 'Radia Perlman', email: 'radia@example.com' },
  },
  {
    id: 7,
    title: 'Audit the highlight spans',
    status: 'In Progress',
    priority: 3,
    estimate: null,
    created: new Date('2020-09-09T12:00:00Z'),
    dueDate: null,
    archived: false,
    labels: ['frontend'],
    assignee: { name: 'Barbara Liskov', email: 'barbara@example.com' },
  },
  {
    id: 8,
    title: 'Drop the two-digit year guess',
    status: 'done',
    priority: 2,
    estimate: 1,
    created: '2019-07-04T00:00:00Z',
    dueDate: new Date('2019-08-01T00:00:00Z'),
    archived: true,
    labels: ['dates'],
    assignee: { name: 'Margaret Hamilton', email: 'margaret@example.com' },
  },
  {
    id: 9,
    title: 'Unlabelled housekeeping',
    status: 'open',
    priority: 1,
    estimate: 3,
    created: '2021-05-05T05:05:05Z',
    dueDate: null,
    archived: false,
    labels: [], // empty array
    assignee: { name: 'Sam Adams', email: 'sam@example.com' },
  },
  {
    id: 10,
    title: 'Support offset-less timestamps',
    status: 'active',
    priority: 4,
    estimate: 8,
    created: 1593000000000, // 2020-06-24
    dueDate: new Date('2020-07-15T00:00:00Z'),
    archived: false,
    labels: ['dates', 'backend'],
    assignee: { name: 'Grace Hopper', email: 'grace@example.com' },
  },
  {
    id: 11,
    title: 'Estimate is missing entirely',
    status: 'open',
    priority: 2,
    // no `estimate` key at all — absence, which is NOT the same as null
    created: '2022-02-02T02:02:02Z',
    dueDate: null,
    archived: false,
    labels: ['triage'],
    assignee: { name: 'Ada Lovelace', email: 'ada@example.com' },
  },
  {
    id: 12,
    title: 'Reject impossible dates',
    status: 'done',
    priority: 5,
    estimate: 5,
    created: new Date('2021-02-28T00:00:00Z'),
    dueDate: new Date('2021-03-15T00:00:00Z'),
    archived: true,
    labels: ['dates', 'security'],
    assignee: { name: 'Alan Turing', email: 'alan@example.com' },
  },
  {
    id: 13,
    title: 'İstanbul office rollout',
    status: 'active',
    priority: 3,
    estimate: 34,
    created: '2022-08-01T00:00:00Z',
    dueDate: new Date('2022-09-01T00:00:00Z'),
    archived: false,
    labels: ['ops'],
    assignee: { name: 'Hedy Lamarr', email: 'hedy@example.com' },
  },
  {
    id: 14,
    title: 'Escape a* in wildcards',
    status: 'open',
    priority: 1,
    estimate: 2,
    created: '2023-01-10T00:00:00Z',
    dueDate: null,
    archived: false,
    labels: ['parser'],
    assignee: { name: 'Ada Lovelace', email: 'ada@example.com' },
  },
];

/**
 * A second, deliberately tiny dataset for the `dateFormat` examples.
 *
 * `01-06-2020` is 1 June under DD-MM-YYYY and 6 January under MM-DD-YYYY.
 * siftql never guesses between them — you declare one per engine — and two
 * rows is all it takes to show the two answers differ.
 */
export const AMBIGUOUS_DATES = [
  { id: 1, d: '01-06-2020' },
  { id: 2, d: '15-06-2020' },
];

/** Dirty data, for the `onValueError` examples. */
export const DIRTY_DATES = [
  { id: 1, when: '2020-06-01' },
  { id: 2, when: 'n/a' },
  { id: 3, when: '2021-01-01' },
];
