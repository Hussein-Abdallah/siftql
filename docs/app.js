/**
 * The playground.
 *
 * Loads the PUBLISHED package from a CDN, pinned — so what you see here is the
 * artifact `npm install` gives you, not a build of the working tree.
 */
// `parse` is deliberately absent: the AST panel uses `engine.parse` so the
// tree it shows reflects the options in the panel above it, tolerant mode
// included. Importing the free function would quietly ignore them.
// `VERSION` is imported rather than written down again: the badge below has to
// name the build that actually loaded, and a second literal here is free to
// drift from the pin above it — silently, since nothing on this page checks.
import {
  createEngine,
  serialize,
  detectTemporalFormat,
  resolveTemporal,
  isSiftQLError,
  VERSION,
} from 'https://esm.sh/@siftql/core@0.1.3';

import { SEED, AMBIGUOUS_DATES, DIRTY_DATES } from './data.js';
import { GROUPS, ALL_PRESETS, INSPECTOR_SAMPLES } from './presets.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ state */

const SEEDS = { SEED, AMBIGUOUS_DATES, DIRTY_DATES };

const state = {
  query: $('query').value,
  datasetName: 'SEED',
  rows: SEED,
  caption: '',
  options: {
    dateFormat: '',
    tolerant: false,
    matchKeys: false,
    regexGuard: true,
    onValueError: 'skip',
    maxPatternLength: 1000,
  },
};

/**
 * `dateFormat` and `tolerant` are engine-level: passing them per call does
 * nothing at all (verified — `filter(q, rows, { tolerant: true })` still
 * throws). Rebuilding the whole engine on every change is the one behaviour
 * that cannot be subtly wrong.
 */
const buildEngine = () => {
  const {
    dateFormat,
    tolerant,
    matchKeys,
    regexGuard,
    onValueError,
    maxPatternLength,
  } = state.options;

  return createEngine({
    ...(dateFormat ? { dateFormat } : {}),
    tolerant,
    matchKeys,
    regexGuard,
    onValueError,
    maxPatternLength,
  });
};

/* ------------------------------------------------------------- formatting */

const fmt = (value) => {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.length ? value.join(', ') : '[]';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/** How `created` is stored on this row — the whole point of that column. */
const shapeOf = (value) => {
  if (value instanceof Date) return 'Date';
  if (typeof value === 'number') return 'epoch';
  if (typeof value === 'string') return 'ISO';
  return '';
};

const describeError = (error) => {
  if (!isSiftQLError(error)) {
    return {
      meta: error?.name ?? 'Error',
      body: String(error?.message ?? error),
    };
  }

  const bits = [error.name, error.code];
  if (error.location) bits.push(`at ${error.location.start}`);
  if (Array.isArray(error.expected) && error.expected.length)
    bits.push(`expected ${error.expected.join(' | ')}`);
  if (error.raw !== undefined)
    bits.push(`operand ${JSON.stringify(error.raw)}`);
  if (Array.isArray(error.candidates) && error.candidates.length)
    bits.push(`tried ${error.candidates.join(' → ')}`);
  if (error.path) bits.push(`path ${error.path.join('.')}`);

  return { meta: bits.join('  ·  '), body: error.message };
};

/* ----------------------------------------------------------------- render */

const renderResults = (matched) => {
  const table = $('results');
  const rows = state.rows;

  if (!rows.length) {
    table.innerHTML = '<tbody><tr><td>No data.</td></tr></tbody>';
    return;
  }

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const hit = new Set(matched);

  const head = `<thead><tr>${columns
    .map((c) => `<th scope="col">${c}</th>`)
    .join('')}</tr></thead>`;

  const body = rows
    .map((row) => {
      const on = hit.has(row);
      const cells = columns
        .map((column) => {
          const value = row[column];
          const shape = column === 'created' ? shapeOf(value) : '';

          return `<td class="mono">${escapeHtml(fmt(value))}${
            shape ? `<span class="shape">${shape}</span>` : ''
          }</td>`;
        })
        .join('');

      return `<tr style="opacity:${on ? 1 : 0.32}">${cells}</tr>`;
    })
    .join('');

  table.innerHTML = `${head}<tbody>${body}</tbody>`;
};

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

const renderAst = (query, engine) => {
  const serialized = $('serialized');
  const roundtrip = $('roundtrip');
  const tree = $('ast');

  try {
    const ast = engine.parse(query);
    serialized.textContent = serialize(ast) || '(empty)';

    const clone = JSON.parse(JSON.stringify(ast));
    const stable = serialize(clone) === serialize(ast);
    roundtrip.textContent = `serialize(JSON.parse(JSON.stringify(ast))) === serialize(ast)  →  ${stable}`;

    tree.textContent = JSON.stringify(
      ast,
      (key, value) => (key === 'location' ? undefined : value),
      2,
    );
  } catch (error) {
    const { body } = describeError(error);
    serialized.textContent = '—';
    roundtrip.textContent = '—';
    tree.textContent = body;
  }
};

/* -------------------------------------------------------------------- run */

/**
 * Say which dataset is loaded, and shout when it is not the default.
 *
 * Switching dataset changes the COLUMNS — DIRTY_DATES has only `id` and
 * `when` — so a reader who clicks a dirty-data example and suddenly sees a
 * two-column table needs to be told the data changed underneath them. Without
 * this the table reads as broken.
 */
const renderDatasetBadge = () => {
  const badge = $('datasetBadge');
  const columns = new Set(state.rows.flatMap((row) => Object.keys(row))).size;

  badge.textContent = `${state.datasetName} · ${state.rows.length} rows · ${columns} columns`;
  badge.classList.toggle('is-switched', state.datasetName !== 'SEED');
};

const DEFAULT_OPTIONS = {
  dateFormat: '',
  tolerant: false,
  matchKeys: false,
  regexGuard: true,
  onValueError: 'skip',
  maxPatternLength: 1000,
};

/**
 * Show every option that is not at its default.
 *
 * Clicking an example REPLACES whatever you set by hand, because an example
 * has to mean the same thing however you arrived at it. That reset was
 * previously silent, which is the worse half of the trade — it cost me a
 * bogus measurement while testing this very page. Naming the active options
 * makes both the preset's choices and your own visible at all times.
 */
const renderOptionBadges = () => {
  const active = Object.entries(state.options)
    .filter(([key, value]) => value !== DEFAULT_OPTIONS[key])
    .map(([key, value]) =>
      typeof value === 'boolean'
        ? value
          ? key
          : `${key}: off`
        : `${key}: ${value}`,
    );

  $('optionBadges').innerHTML = active
    .map((label) => `<span class="option-badge">${escapeHtml(label)}</span>`)
    .join('');
};

const run = () => {
  const query = state.query;

  const caption = $('caption');
  caption.textContent = state.caption;
  caption.hidden = !state.caption;

  renderDatasetBadge();
  renderOptionBadges();

  const errorBox = $('error');
  let matched = [];

  // A layout is typed by hand, so it can be nonsense — `createEngine` validates
  // it eagerly and throws SiftQLDateFormatError, which is the right call
  // (a bad layout should never surface on record N). It has to be caught HERE
  // rather than around the query: it happens before a query is even considered,
  // and letting it escape would take the whole page down on a half-typed
  // layout like `DD-MM`.
  let engine;

  try {
    engine = buildEngine();
  } catch (error) {
    const { meta, body } = describeError(error);
    errorBox.hidden = false;
    errorBox.innerHTML = `<span class="err-meta">${escapeHtml(meta)}</span>${escapeHtml(body)}`;
    $('stats').textContent =
      `engine not built · ${state.rows.length} rows unfiltered`;
    $('serialized').textContent = '—';
    $('roundtrip').textContent = '—';
    $('ast').textContent = body;
    renderResults([]);
    return;
  }

  renderAst(query, engine);

  try {
    const t0 = performance.now();
    engine.parse(query);
    const parsed = performance.now() - t0;

    const t1 = performance.now();
    matched = engine.filter(query, state.rows);
    const filtered = performance.now() - t1;

    errorBox.hidden = true;
    $('stats').textContent =
      `${matched.length} of ${state.rows.length} rows · ` +
      `parsed ${parsed.toFixed(2)} ms · filtered ${filtered.toFixed(2)} ms`;
  } catch (error) {
    const { meta, body } = describeError(error);
    errorBox.hidden = false;
    errorBox.innerHTML = `<span class="err-meta">${escapeHtml(meta)}</span>${escapeHtml(body)}`;
    $('stats').textContent = `0 of ${state.rows.length} rows · refused`;
  }

  renderResults(matched);
  renderResolved(engine);
};

const renderResolved = (engine) => {
  const resolved = engine.options;

  // `dateFormat` and `parseDate` are flat going IN and nested under `temporal`
  // coming OUT. Reaching through is the only way to echo them honestly.
  $('resolved').textContent = JSON.stringify(
    {
      id: resolved.id,
      tolerant: resolved.tolerant,
      matchKeys: resolved.matchKeys,
      regexGuard: resolved.regexGuard,
      maxPatternLength: resolved.maxPatternLength,
      onValueError: resolved.onValueError,
      onRecovered: resolved.onRecovered,
      'temporal.dateFormat': resolved.temporal?.dateFormat ?? null,
    },
    null,
    2,
  );
};

/* ------------------------------------------------------------------ chips */

const applyPreset = (preset, group, button) => {
  document
    .querySelectorAll('.chip[aria-pressed="true"]')
    .forEach((el) => el.setAttribute('aria-pressed', 'false'));
  button.setAttribute('aria-pressed', 'true');

  const options = { ...preset.options, ...group.options };
  state.options = {
    dateFormat: options.dateFormat ?? '',
    tolerant: options.tolerant ?? false,
    matchKeys: options.matchKeys ?? false,
    regexGuard: options.regexGuard ?? true,
    onValueError: preset.per?.onValueError ?? 'skip',
    maxPatternLength: 1000,
  };

  state.datasetName = preset.data ?? group.data ?? 'SEED';
  state.rows = SEEDS[state.datasetName];
  state.query = preset.q;
  state.caption = preset.caption;

  $('query').value = preset.q;
  syncOptionInputs();
  syncDataPanel();
  run();
  runInspector();
};

const renderGroups = () => {
  // An accordion rather than a wall. Fourteen groups of chips is a lot to
  // scan, and the first one open is enough to show what the control does.
  $('groups').innerHTML = GROUPS.map(
    (group, index) => `
      <details class="group"${index === 0 ? ' open' : ''}>
        <summary>
          ${escapeHtml(group.title)}
          <span class="count">${group.presets.length}</span>
        </summary>
        <div class="group-body">
          <p>${escapeHtml(group.blurb)}</p>
          <div class="chips" data-group="${group.id}"></div>
        </div>
      </details>`,
  ).join('');

  GROUPS.forEach((group) => {
    const host = document.querySelector(`.chips[data-group="${group.id}"]`);

    group.presets.forEach((preset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        'chip' + (preset.expect === 'error' ? ' is-error' : '');
      button.textContent = preset.q;
      button.title = preset.caption;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () =>
        applyPreset(preset, group, button),
      );
      host.append(button);
    });
  });
};

/* -------------------------------------------------------------- inspector */

const runInspector = () => {
  const typed = $('inspect').value;
  const dateFormat = state.options.dateFormat;
  const temporal = dateFormat ? { dateFormat } : {};

  const rows = [typed, ...INSPECTOR_SAMPLES.filter((s) => s !== typed)];

  const body = rows
    .map((sample, index) => {
      let detected = null;
      let resolvedValue = null;

      try {
        detected = detectTemporalFormat(sample, temporal);
      } catch {
        detected = null;
      }
      try {
        resolvedValue = resolveTemporal(sample, temporal);
      } catch {
        resolvedValue = null;
      }

      // FOUR combinations, not three. `detectTemporalFormat` recognises the
      // built-in ISO shapes ONLY — a declared `dateFormat` is applied inside
      // `resolveTemporal`, so detect never sees it. That produces a case the
      // obvious framing misses: not ISO-shaped, yet resolved.
      const verdict =
        detected !== null && resolvedValue === null
          ? {
              className: 'no',
              text: 'ISO-shaped, but not a real date → siftql refuses the query',
            }
          : detected === null && resolvedValue !== null
            ? {
                className: 'yes',
                text: `not ISO-shaped — your declared ${dateFormat} layout resolved it`,
              }
            : resolvedValue === null
              ? {
                  className: 'muted',
                  text: 'not a date under any rule in force',
                }
              : { className: 'yes', text: 'ISO-shaped and real' };

      return `<tr${index === 0 ? ' style="font-weight:600"' : ''}>
        <td class="mono">${escapeHtml(sample)}</td>
        <td class="mono">${detected === null ? '<span class="no">null</span>' : escapeHtml(detected)}</td>
        <td class="mono">${
          resolvedValue === null
            ? '<span class="no">null</span>'
            : escapeHtml(resolvedValue.domain)
        }</td>
        <td class="mono">${resolvedValue === null ? '—' : escapeHtml(String(resolvedValue.value))}</td>
        <td><span class="${verdict.className}">${escapeHtml(verdict.text)}</span></td>
      </tr>`;
    })
    .join('');

  $('inspector').innerHTML = `<thead><tr>
       <th scope="col">value</th>
       <th scope="col">detectTemporalFormat</th>
       <th scope="col">domain</th>
       <th scope="col">resolved</th>
       <th scope="col">verdict</th>
     </tr></thead><tbody>${body}</tbody>`;
};

/* ------------------------------------------------------------- regex race */

const RACE_PATTERN = '^(a+)+$';

const runRace = async () => {
  const n = Number($('raceN').value);
  const subject = 'a'.repeat(n) + '!';
  const engine = createEngine();

  const t0 = performance.now();
  engine.filter(`v:/${RACE_PATTERN}/`, [{ v: subject }]);
  const linear = performance.now() - t0;

  $('race').innerHTML =
    `<thead><tr><th scope="col">engine</th><th scope="col">time</th><th scope="col">note</th></tr></thead>
     <tbody>
       <tr><td>siftql (linear automaton)</td><td class="num">${linear.toFixed(2)} ms</td><td class="yes">answered</td></tr>
       <tr><td>native RegExp (worker)</td><td class="num" id="raceNative">running…</td><td id="raceNativeNote">—</td></tr>
     </tbody>`;
  $('raceNote').textContent = '';

  const worker = new Worker('./race-worker.js', { type: 'module' });
  const BUDGET_MS = 2000;

  const settle = (time, note, className) => {
    $('raceNative').textContent = time;
    const cell = $('raceNativeNote');
    cell.textContent = note;
    cell.className = className;
  };

  const killer = setTimeout(() => {
    worker.terminate();
    settle(`> ${BUDGET_MS} ms`, 'killed — still backtracking', 'no');
    $('raceNote').textContent =
      `The worker was terminated after ${BUDGET_MS} ms. On the main thread this is a frozen tab, ` +
      `and nothing can interrupt it — which is the whole reason siftql refuses to run patterns it ` +
      `cannot bound.`;
  }, BUDGET_MS);

  worker.addEventListener('message', (event) => {
    clearTimeout(killer);
    worker.terminate();
    settle(`${event.data.ms.toFixed(2)} ms`, 'answered', 'yes');
    $('raceNote').textContent =
      `Native took ${(event.data.ms / Math.max(linear, 0.01)).toFixed(0)}× longer at n=${n}. ` +
      `Raise n by two and it roughly doubles; siftql stays flat.`;
  });

  worker.postMessage({ pattern: RACE_PATTERN, subject });
};

/* -------------------------------------------------------------- self-test */

const runSelfTest = () => {
  const groupById = Object.fromEntries(GROUPS.map((g) => [g.id, g]));
  const failures = [];
  let passed = 0;

  for (const preset of ALL_PRESETS) {
    const group = groupById[preset.group];
    const rows = SEEDS[preset.data ?? group.data ?? 'SEED'];
    const options = { ...preset.options, ...group.options };

    let actual;
    try {
      actual = createEngine({
        ...(options.dateFormat ? { dateFormat: options.dateFormat } : {}),
        tolerant: options.tolerant ?? false,
        matchKeys: options.matchKeys ?? false,
        regexGuard: options.regexGuard ?? true,
      })
        .filter(preset.q, rows, preset.per ?? {})
        .map((row) => row.id);
    } catch {
      actual = 'error';
    }

    const want = preset.expect;
    const ok =
      want === 'error'
        ? actual === 'error'
        : Array.isArray(actual) &&
          JSON.stringify(actual) === JSON.stringify(want);

    if (ok) passed += 1;
    else
      failures.push(
        `[${preset.group}] ${preset.q}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(actual)}`,
      );
  }

  $('selftest-panel').hidden = false;
  $('selftest').textContent =
    `${ALL_PRESETS.length} examples · ${passed} pass · ${failures.length} fail\n` +
    (failures.length
      ? '\n' + failures.join('\n')
      : '\nEvery caption on this page matches what the engine actually returns.');
};

/* ------------------------------------------------------------------ wiring */

const syncOptionInputs = () => {
  $('dateFormat').value = state.options.dateFormat;
  $('tolerant').checked = state.options.tolerant;
  $('matchKeys').checked = state.options.matchKeys;
  $('regexGuard').checked = state.options.regexGuard;
  $('onValueError').value = state.options.onValueError;
  $('maxPatternLength').value = String(state.options.maxPatternLength);
  $('dataset').value = state.datasetName;
};

const syncDataPanel = () => {
  $('data').value = JSON.stringify(state.rows, null, 2);
  $('dataError').textContent = '';
};

const readOptionInputs = () => {
  state.options = {
    dateFormat: $('dateFormat').value,
    tolerant: $('tolerant').checked,
    matchKeys: $('matchKeys').checked,
    regexGuard: $('regexGuard').checked,
    onValueError: $('onValueError').value,
    maxPatternLength: Number($('maxPatternLength').value) || 1000,
  };
};

const debounce = (fn, ms) => {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
};

const onQueryInput = debounce(() => {
  state.query = $('query').value;
  state.caption = '';
  document
    .querySelectorAll('.chip[aria-pressed="true"]')
    .forEach((el) => el.setAttribute('aria-pressed', 'false'));
  run();
}, 120);

$('query').addEventListener('input', onQueryInput);
$('inspect').addEventListener('input', debounce(runInspector, 120));

const applyOptionChange = () => {
  readOptionInputs();
  state.caption = '';
  run();
  runInspector();
};

// `dateFormat` is typed, so it also needs `input` — debounced, or every
// keystroke of "YYYY.MM.DD" builds an engine on an invalid partial layout.
$('dateFormat').addEventListener('input', debounce(applyOptionChange, 250));

[
  'dateFormat',
  'tolerant',
  'matchKeys',
  'regexGuard',
  'onValueError',
  'maxPatternLength',
].forEach((id) => $(id).addEventListener('change', applyOptionChange));

$('dataset').addEventListener('change', () => {
  state.datasetName = $('dataset').value;
  state.rows = SEEDS[state.datasetName];
  state.caption = '';
  syncDataPanel();
  run();
});

$('applyData').addEventListener('click', () => {
  try {
    const parsed = JSON.parse($('data').value);
    if (!Array.isArray(parsed))
      throw new Error('Expected an array of objects.');
    state.rows = parsed;
    $('dataError').textContent = '';
    run();
  } catch (error) {
    $('dataError').textContent = error.message;
  }
});

$('resetData').addEventListener('click', () => {
  state.rows = SEEDS[state.datasetName];
  syncDataPanel();
  run();
});

$('resetOptions').addEventListener('click', () => {
  state.options = { ...DEFAULT_OPTIONS };
  state.datasetName = 'SEED';
  state.rows = SEEDS.SEED;
  state.caption = '';
  document
    .querySelectorAll('.chip[aria-pressed="true"]')
    .forEach((el) => el.setAttribute('aria-pressed', 'false'));
  syncOptionInputs();
  syncDataPanel();
  run();
  runInspector();
});

$('raceN').addEventListener('input', () => {
  $('raceNOut').textContent = $('raceN').value;
});
$('raceRun').addEventListener('click', runRace);

/* ------------------------------------------------------------------- boot */

$('version').textContent = `v${VERSION} · loaded from esm.sh`;
renderGroups();
syncOptionInputs();
syncDataPanel();
run();
runInspector();

if (new URLSearchParams(location.search).has('selftest')) runSelfTest();
