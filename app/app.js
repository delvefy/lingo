'use strict';

const LESSON_SIZE = 10;
const NEW_PER_LESSON = 2;
const LEARNED_AT = 5; // correct answers in a row before a sentence is learned and stops coming back
const SAVE_DELAY_MS = 400;

const DIRECTIONS = {
  'ro-sv': { learn: 'Swedish', targetLang: 'sv', hintLang: 'ro' },
  'sv-ro': { learn: 'Romanian', targetLang: 'ro', hintLang: 'sv' },
};

const THEMES = ['light', 'dark', 'system'];

const KEYS = {
  meta: 'lingo:meta',
  progress: (dir) => `lingo:progress:${dir}`,
  excluded: 'lingo:excluded',
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- storage

const store = (() => {
  let available = false;
  try {
    localStorage.setItem('lingo:probe', '1');
    localStorage.removeItem('lingo:probe');
    available = true;
  } catch (e) { /* storage blocked: run without saving */ }

  const pending = new Map();
  let timer = null;

  function read(key, fallback) {
    if (!available) return fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function flush() {
    clearTimeout(timer);
    if (available) {
      for (const [key, value] of pending) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota exceeded */ }
      }
    }
    pending.clear();
  }

  function write(key, value) {
    pending.set(key, value);
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  return { available, read, write, flush };
})();

// ---------------------------------------------------------------- dates

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Calendar-day arithmetic; setDate keeps local midnight across DST changes.
function addDays(ts, days) {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------- state

function defaultMeta() {
  return {
    direction: 'ro-sv',
    streak: 0,
    lastLessonDay: null,
    today: { day: null, reviewed: 0 },
    installDismissed: false,
    theme: 'light',
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function loadMeta() {
  const saved = store.read(KEYS.meta, {});
  const meta = Object.assign(defaultMeta(), isPlainObject(saved) ? saved : {});
  if (!DIRECTIONS[meta.direction]) meta.direction = 'ro-sv';
  if (!THEMES.includes(meta.theme)) meta.theme = 'light';
  if (!isPlainObject(meta.today)) meta.today = { day: null, reviewed: 0 };
  return meta;
}

function loadProgress(dir) {
  const saved = store.read(KEYS.progress(dir), {});
  return isPlainObject(saved) ? saved : {};
}

// dir -> { id: { target, hint, at } }; the text is kept so Settings can list them without loading the data.
function loadExcluded() {
  const saved = store.read(KEYS.excluded, {});
  const excluded = {};
  for (const dir of Object.keys(DIRECTIONS)) {
    excluded[dir] = isPlainObject(saved) && isPlainObject(saved[dir]) ? saved[dir] : {};
  }
  return excluded;
}

const state = {
  meta: loadMeta(),
  progress: { 'ro-sv': loadProgress('ro-sv'), 'sv-ro': loadProgress('sv-ro') },
  excluded: loadExcluded(),
  data: {},      // dir -> items, in difficulty order
  loading: {},   // dir -> pending fetch promise
  lesson: null,
};

function saveMeta() { store.write(KEYS.meta, state.meta); }
function saveProgress(dir) { store.write(KEYS.progress(dir), state.progress[dir]); }
function saveExcluded() { store.write(KEYS.excluded, state.excluded); }

function isExcluded(dir, id) { return Object.prototype.hasOwnProperty.call(state.excluded[dir], id); }

// The direction's sentences minus the ones the learner excluded, or null while loading.
function activeItems(dir) {
  const items = state.data[dir];
  return items ? items.filter((it) => !isExcluded(dir, it.id)) : null;
}

// ---------------------------------------------------------------- scheduling

function isLearned(rec) { return rec.count >= LEARNED_AT; }
function isDue(rec, now) { return !isLearned(rec) && rec.due <= now; }

// Correct: one more day of waiting per correct answer in a row. Wrong: due again right away.
function recordAnswer(dir, id, correct, now = Date.now()) {
  const progress = state.progress[dir];
  const rec = progress[id] || { count: 0, due: 0, seen: 0, correct: 0 };
  rec.seen += 1;
  if (correct) {
    rec.correct += 1;
    rec.count += 1;
    rec.due = addDays(now, rec.count);
  } else {
    rec.count = 0;
    rec.due = now;
  }
  progress[id] = rec;
  saveProgress(dir);
  countReviewToday(now);
}

// Up to 8 due reviews (most overdue first), new sentences for the rest of the 10 slots,
// then more reviews if new sentences run out. No two items share an answer.
function buildLesson(items, progress, now = Date.now()) {
  const due = items
    .filter((it) => progress[it.id] && isDue(progress[it.id], now))
    .sort((a, b) => progress[a.id].due - progress[b.id].due);
  const fresh = items.filter((it) => !progress[it.id]);

  const picked = [];
  const answers = new Set();
  const take = (list, limit) => {
    for (const it of list) {
      if (picked.length >= limit) return;
      const key = it.answer.toLocaleLowerCase();
      if (answers.has(key) || picked.includes(it)) continue;
      answers.add(key);
      picked.push(it);
    }
  };
  take(due, LESSON_SIZE - NEW_PER_LESSON);
  take(fresh, LESSON_SIZE);
  take(due, LESSON_SIZE);
  return shuffle(picked);
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Only sentences still in the dataset count; a rebuild can drop ids that have saved progress.
function nextDueDate(dir, now = Date.now()) {
  const ids = new Set((activeItems(dir) || []).map((it) => it.id));
  let next = Infinity;
  for (const [id, rec] of Object.entries(state.progress[dir])) {
    if (!ids.has(id) || isLearned(rec)) continue;
    if (rec.due > now && rec.due < next) next = rec.due;
  }
  return next === Infinity ? null : next;
}

// ---------------------------------------------------------------- stats

function countReviewToday(now) {
  const today = dayKey(now);
  if (state.meta.today.day !== today) state.meta.today = { day: today, reviewed: 0 };
  state.meta.today.reviewed += 1;
  saveMeta();
}

function reviewedToday() {
  return state.meta.today.day === dayKey(Date.now()) ? state.meta.today.reviewed : 0;
}

function markLessonDone(now = Date.now()) {
  const today = dayKey(now);
  const yesterday = dayKey(addDays(now, -1));
  const { meta } = state;
  if (meta.lastLessonDay !== today) {
    meta.streak = meta.lastLessonDay === yesterday ? meta.streak + 1 : 1;
    meta.lastLessonDay = today;
  }
  saveMeta();
}

function currentStreak(now = Date.now()) {
  const last = state.meta.lastLessonDay;
  const alive = last === dayKey(now) || last === dayKey(addDays(now, -1));
  return alive ? state.meta.streak : 0;
}

// In play: seen at least once but not learned yet, out of the whole dataset (total shown once
// it has loaded). Learned: retired after LEARNED_AT right in a row. Excluded sentences count nowhere.
function renderInPlay(dir) {
  const progress = state.progress[dir];
  const items = activeItems(dir);
  const ids = items ? items.map((it) => it.id) : Object.keys(progress).filter((id) => !isExcluded(dir, id));
  let inPlay = 0;
  let learned = 0;
  for (const id of ids) {
    const rec = progress[id];
    if (!rec) continue;
    if (isLearned(rec)) learned += 1;
    else inPlay += 1;
  }
  $('stat-in-play').textContent = inPlay.toLocaleString();
  $('stat-learned').textContent = learned.toLocaleString();
  $('stat-total').textContent = items ? `/ ${items.length.toLocaleString()}` : '';
}

// ---------------------------------------------------------------- data

function loadDirection(dir) {
  if (state.data[dir]) return Promise.resolve(state.data[dir]);
  if (!state.loading[dir]) {
    state.loading[dir] = fetch(`data/${dir}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((items) => {
        state.data[dir] = items;
        return items;
      })
      .finally(() => { delete state.loading[dir]; });
  }
  return state.loading[dir];
}

// Splits the target sentence around the blank word, using the same tokens as the data pipeline.
function splitAtBlank(item) {
  const words = [...item.target.matchAll(/\p{L}+/gu)];
  const word = words[item.blank];
  let start = word && word[0] === item.answer ? word.index : item.target.indexOf(item.answer);
  if (start < 0) start = item.target.length;
  return {
    before: item.target.slice(0, start),
    after: item.target.slice(start + item.answer.length),
  };
}

// ---------------------------------------------------------------- theme

const THEME_COLORS = { light: '#EEF2F8', dark: '#0E1729' };
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// Resolves "system" to light or dark; the CSS only knows data-theme="dark".
function applyTheme() {
  const pref = state.meta.theme;
  const resolved = pref === 'dark' || (pref === 'system' && darkQuery.matches) ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]').content = THEME_COLORS[resolved];
  for (const btn of $('theme-picker').children) {
    btn.setAttribute('aria-checked', String(btn.dataset.theme === pref));
  }
}

function selectTheme(theme) {
  if (!THEMES.includes(theme)) return;
  state.meta.theme = theme;
  saveMeta();
  applyTheme();
}

// ---------------------------------------------------------------- navigation

const screens = ['start', 'quiz', 'end', 'settings', 'excluded', 'about'];

function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
  if (name === 'start') renderStart();
  if (name === 'settings') {
    setStatus('');
    renderExcludedButton();
  }
  if (name === 'excluded') renderExcluded();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- start screen

function renderStart() {
  const dir = state.meta.direction;
  for (const btn of document.querySelectorAll('.direction-option')) {
    btn.setAttribute('aria-checked', String(btn.dataset.dir === dir));
  }
  $('stat-today').textContent = reviewedToday();
  $('stat-streak').textContent = currentStreak();
  renderInPlay(dir);
  $('storage-notice').hidden = store.available;
  renderInstallNotice();
  renderLessonPreview();
}

function renderLessonPreview() {
  const dir = state.meta.direction;
  const preview = $('lesson-preview');
  const startBtn = $('start-btn');

  if (!state.data[dir]) {
    preview.textContent = 'Loading sentences…';
    startBtn.disabled = true;
    loadDirection(dir)
      .then(() => { if (state.meta.direction === dir) renderLessonPreview(); })
      .catch(() => {
        if (state.meta.direction !== dir) return;
        preview.textContent = 'Couldn’t load the sentences. Check your connection and try again.';
        startBtn.textContent = 'Try again';
        startBtn.disabled = false;
      });
    return;
  }

  renderInPlay(dir);
  const progress = state.progress[dir];
  const lesson = buildLesson(activeItems(dir), progress);
  const reviews = lesson.filter((it) => progress[it.id]).length;
  const fresh = lesson.length - reviews;
  startBtn.textContent = 'Start lesson';
  startBtn.disabled = lesson.length === 0;

  if (lesson.length === 0) {
    const next = nextDueDate(dir);
    const when = next ? new Date(next).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : null;
    preview.textContent = when
      ? `You’ve done every sentence. The next review is due on ${when}.`
      : 'You’ve done every sentence.';
    return;
  }
  preview.innerHTML = '';
  preview.append('Next lesson: ', strong(plural(reviews, 'review')), ' and ', strong(plural(fresh, 'new sentence')));
}

function strong(text) {
  const el = document.createElement('strong');
  el.textContent = text;
  return el;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function selectDirection(dir) {
  if (!DIRECTIONS[dir] || dir === state.meta.direction) return;
  state.meta.direction = dir;
  saveMeta();
  renderStart();
}

// ---------------------------------------------------------------- lesson

function startLesson() {
  const dir = state.meta.direction;
  if (!state.data[dir]) {
    renderLessonPreview();
    return;
  }
  const items = buildLesson(activeItems(dir), state.progress[dir]);
  if (items.length === 0) return;
  state.lesson = { dir, items, index: 0, answered: false, results: [] };
  show('quiz');
  renderProgress();
  renderQuestion();
}

function renderProgress() {
  const { items, index, results } = state.lesson;
  const bar = $('progress');
  bar.replaceChildren(...items.map((_, i) => {
    const li = document.createElement('li');
    if (results[i]) li.className = results[i].correct ? 'is-right' : 'is-wrong';
    else if (i === index) li.className = 'is-current';
    return li;
  }));
  $('progress-count').textContent = `${index + 1}/${items.length}`;
}

function renderQuestion() {
  const { dir, items, index } = state.lesson;
  const item = items[index];
  const { targetLang, hintLang } = DIRECTIONS[dir];
  const { before, after } = splitAtBlank(item);

  const blank = document.createElement('span');
  blank.className = 'blank';
  blank.id = 'blank';
  blank.setAttribute('aria-label', 'missing word');
  const sentence = $('sentence');
  sentence.lang = targetLang;
  sentence.replaceChildren(before, blank, after);

  $('hint').lang = hintLang;
  $('hint').textContent = item.hint;
  renderTally(dir, item);
  $('source').hidden = true;

  $('options').replaceChildren(...item.options.map((text, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option';
    btn.lang = targetLang;
    btn.dataset.index = String(i);
    btn.textContent = text;
    return btn;
  }));

  $('next-btn').hidden = true;
  $('next-tip').hidden = true;
  state.lesson.answered = false;
}

function answer(choiceIndex) {
  const lesson = state.lesson;
  if (!lesson || lesson.answered) return;
  lesson.answered = true;

  const item = lesson.items[lesson.index];
  const choice = item.options[choiceIndex];
  const correct = choice === item.answer;
  recordAnswer(lesson.dir, item.id, correct);
  lesson.results[lesson.index] = { item, choice, correct };

  for (const btn of $('options').children) {
    const text = item.options[Number(btn.dataset.index)];
    btn.classList.add('is-locked');
    btn.setAttribute('aria-disabled', 'true');
    if (text === item.answer) markOption(btn, 'is-correct', '✓', 'correct answer');
    else if (text === choice) markOption(btn, 'is-wrong', '✗', 'your answer');
  }

  const blank = $('blank');
  blank.textContent = item.answer;
  blank.classList.add('is-filled');
  blank.removeAttribute('aria-label');

  renderTally(lesson.dir, item);
  renderSource(item);
  renderProgress();
  $('progress-count').textContent = `${lesson.index + 1}/${lesson.items.length}`;
  const next = $('next-btn');
  next.textContent = lesson.index + 1 < lesson.items.length ? 'Next' : 'See results';
  next.hidden = false;
  $('next-tip').hidden = false;
  next.focus({ preventScroll: true });
}

function markOption(btn, cls, symbol, label) {
  btn.classList.add(cls);
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = symbol;
  mark.setAttribute('aria-label', label);
  btn.append(mark);
}

// How often this sentence has been answered right, so progress toward "learned" is visible.
function renderTally(dir, item) {
  const rec = state.progress[dir][item.id];
  const tally = $('tally');
  if (!rec || rec.seen === 0) {
    tally.textContent = 'New sentence';
    return;
  }
  const times = (n) => (n === 1 ? '1 time' : `${n} times`);
  let text = `Correct ${rec.correct} of ${times(rec.seen)} · ${rec.count} in a row`;
  if (isLearned(rec)) text += ' · learned';
  tally.textContent = text;
}

function renderSource(item) {
  const source = $('source');
  const link = document.createElement('a');
  link.href = `https://tatoeba.org/sentences/show/${encodeURIComponent(item.id)}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Sentence on Tatoeba';
  source.replaceChildren(link);
  source.hidden = false;
}

function nextQuestion() {
  const lesson = state.lesson;
  if (!lesson || !lesson.answered) return;
  lesson.index += 1;
  if (lesson.index >= lesson.items.length) {
    finishLesson();
    return;
  }
  renderProgress();
  renderQuestion();
}

function finishLesson() {
  const { results } = state.lesson;
  markLessonDone();
  store.flush();

  const right = results.filter((r) => r.correct).length;
  $('score').textContent = `${right} of ${results.length}`;
  $('score-note').textContent = scoreNote(right, results.length);
  $('recap').replaceChildren(...results.map(recapItem));
  show('end');
}

function scoreNote(right, total) {
  if (right === total) return 'Every one right. These sentences come back in a day.';
  const wrong = total - right;
  return `${plural(wrong, 'sentence')} will come back in your next lesson.`;
}

function recapItem({ item, choice, correct }) {
  const li = document.createElement('li');
  const { before, after } = splitAtBlank(item);
  const mark = document.createElement('mark');
  mark.textContent = item.answer;
  li.lang = DIRECTIONS[state.lesson.dir].targetLang;
  li.append(before, mark, after);
  if (!correct) {
    const missed = document.createElement('span');
    missed.className = 'missed';
    missed.textContent = `You picked “${choice}”`;
    li.append(missed);
  }
  return li;
}

function quitLesson() {
  state.lesson = null;
  store.flush();
  show('start');
}

// Takes the current sentence out of the pool (e.g. a wrong translation) and moves on.
async function excludeCurrent() {
  const lesson = state.lesson;
  if (!lesson) return;
  const item = lesson.items[lesson.index];
  const choice = await confirmChoice({
    title: 'Exclude this sentence?',
    body: 'It won’t appear in your lessons or count in your totals. You can restore it from Settings.',
    actions: [
      { label: 'Exclude sentence', value: 'exclude', style: 'btn-danger' },
      { label: 'Cancel', value: 'cancel', style: 'btn-quiet' },
    ],
  });
  if (choice !== 'exclude' || state.lesson !== lesson) return;

  state.excluded[lesson.dir][item.id] = { target: item.target, hint: item.hint, at: Date.now() };
  saveExcluded();
  lesson.items.splice(lesson.index, 1);
  lesson.results.splice(lesson.index, 1);

  if (lesson.index < lesson.items.length) {
    renderProgress();
    renderQuestion();
  } else if (lesson.results.some(Boolean)) {
    finishLesson();
  } else {
    quitLesson();
  }
}

// ---------------------------------------------------------------- excluded sentences

function excludedCount() {
  return Object.values(state.excluded).reduce((n, recs) => n + Object.keys(recs).length, 0);
}

function renderExcludedButton() {
  const n = excludedCount();
  $('excluded-btn').textContent = n ? `Show excluded sentences (${n})` : 'Show excluded sentences';
}

function renderExcluded() {
  const entries = [];
  for (const [dir, recs] of Object.entries(state.excluded)) {
    for (const [id, rec] of Object.entries(recs)) entries.push({ dir, id, ...rec });
  }
  entries.sort((a, b) => (b.at || 0) - (a.at || 0));
  $('excluded-empty').hidden = entries.length > 0;
  $('excluded-list').replaceChildren(...entries.map(excludedItem));
}

function excludedItem({ dir, id, target, hint }) {
  const { learn, targetLang, hintLang } = DIRECTIONS[dir];
  const li = document.createElement('li');
  const text = document.createElement('div');
  text.className = 'excluded-text';
  const label = document.createElement('span');
  label.className = 'excluded-lang';
  label.textContent = learn;
  const sentence = document.createElement('p');
  sentence.className = 'excluded-sentence';
  sentence.lang = targetLang;
  sentence.textContent = target || `Sentence ${id}`;
  const hintEl = document.createElement('p');
  hintEl.className = 'excluded-hint';
  hintEl.lang = hintLang;
  hintEl.textContent = hint || '';
  text.append(label, sentence, hintEl);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-small';
  btn.textContent = 'Restore';
  btn.dataset.dir = dir;
  btn.dataset.id = id;
  btn.setAttribute('aria-label', `Restore “${target || id}”`);
  li.append(text, btn);
  return li;
}

function restoreExcluded(dir, id) {
  if (!state.excluded[dir]) return;
  delete state.excluded[dir][id];
  saveExcluded();
  renderExcluded();
}

// ---------------------------------------------------------------- confirm dialog

function confirmChoice({ title, body, actions }) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-actions').replaceChildren(...actions.map((a) => {
    const btn = document.createElement('button');
    btn.className = `btn ${a.style || ''}`.trim();
    btn.value = a.value;
    btn.textContent = a.label;
    return btn;
  }));
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue || null), { once: true });
    dialog.showModal();
  });
}

// ---------------------------------------------------------------- backup

function setStatus(text, isError = false) {
  const el = $('settings-status');
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}

async function exportProgress() {
  store.flush();
  const payload = {
    app: 'lingo',
    version: 1,
    exportedAt: new Date().toISOString(),
    meta: state.meta,
    progress: state.progress,
    excluded: state.excluded,
  };
  const name = `lingo-progress-${dayKey(Date.now())}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });

  // On phones the share sheet is the reliable way to save a file.
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      setStatus('Backup ready.');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      // Sharing isn't actually available: fall back to a download.
    }
  }
  downloadFile(blob, name);
  setStatus(`Saved ${name}.`);
}

function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isValidRecord(rec) {
  return isPlainObject(rec)
    && ['count', 'due', 'seen', 'correct'].every((k) => Number.isFinite(rec[k]) && rec[k] >= 0);
}

// Returns a clean copy of the backup, or throws with a message for the user.
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('That file isn’t valid JSON.');
  }
  if (!isPlainObject(data) || data.app !== 'lingo' || !isPlainObject(data.progress)) {
    throw new Error('That file isn’t a lingo backup.');
  }
  const progress = {};
  for (const dir of Object.keys(DIRECTIONS)) {
    const recs = data.progress[dir] ?? {};
    if (!isPlainObject(recs)) throw new Error('The backup’s progress data is damaged.');
    progress[dir] = {};
    for (const [id, rec] of Object.entries(recs)) {
      if (!isValidRecord(rec)) throw new Error('The backup’s progress data is damaged.');
      progress[dir][id] = { count: rec.count, due: rec.due, seen: rec.seen, correct: rec.correct };
    }
  }
  // Older backups have no exclusions; damaged entries are skipped rather than failing the import.
  const excluded = {};
  for (const dir of Object.keys(DIRECTIONS)) {
    const recs = isPlainObject(data.excluded) && isPlainObject(data.excluded[dir]) ? data.excluded[dir] : {};
    excluded[dir] = {};
    for (const [id, rec] of Object.entries(recs)) {
      if (!isPlainObject(rec)) continue;
      excluded[dir][id] = {
        target: typeof rec.target === 'string' ? rec.target : '',
        hint: typeof rec.hint === 'string' ? rec.hint : '',
        at: Number.isFinite(rec.at) ? rec.at : 0,
      };
    }
  }
  const meta = isPlainObject(data.meta) ? data.meta : {};
  return { progress, meta, excluded };
}

function applyBackup(backup, mode) {
  for (const dir of Object.keys(DIRECTIONS)) {
    if (mode === 'replace') {
      state.progress[dir] = backup.progress[dir];
    } else {
      // Merge: per sentence, keep whichever record has more practice behind it.
      const mine = state.progress[dir];
      for (const [id, rec] of Object.entries(backup.progress[dir])) {
        const cur = mine[id];
        if (!cur || rec.seen > cur.seen || (rec.seen === cur.seen && rec.due > cur.due)) mine[id] = rec;
      }
    }
    saveProgress(dir);
    // Exclusions are about bad sentences, not progress, so both modes keep the union.
    for (const [id, rec] of Object.entries(backup.excluded[dir])) {
      if (!isExcluded(dir, id)) state.excluded[dir][id] = rec;
    }
  }
  saveExcluded();

  const theirs = backup.meta;
  const validDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (validDay(theirs.lastLessonDay) && Number.isFinite(theirs.streak)) {
    const takeTheirs = mode === 'replace' || !state.meta.lastLessonDay || theirs.lastLessonDay > state.meta.lastLessonDay;
    if (takeTheirs) {
      state.meta.lastLessonDay = theirs.lastLessonDay;
      state.meta.streak = theirs.streak;
    }
  }
  saveMeta();
  store.flush();
}

async function importProgress(file) {
  setStatus('');
  let backup;
  try {
    backup = parseBackup(await file.text());
  } catch (e) {
    setStatus(e.message, true);
    return;
  }
  const count = Object.values(backup.progress).reduce((n, recs) => n + Object.keys(recs).length, 0);
  const mode = await confirmChoice({
    title: 'Import this backup?',
    body: `It has progress for ${plural(count, 'sentence')}. Merge keeps the most practised version of each sentence. Replace swaps your current progress for the backup.`,
    actions: [
      { label: 'Merge with my progress', value: 'merge', style: 'btn-primary' },
      { label: 'Replace my progress', value: 'replace', style: 'btn-danger' },
      { label: 'Cancel', value: 'cancel', style: 'btn-quiet' },
    ],
  });
  if (mode !== 'merge' && mode !== 'replace') return;
  applyBackup(backup, mode);
  setStatus(mode === 'merge' ? 'Backup merged.' : 'Progress replaced with the backup.');
}

async function resetProgress() {
  const choice = await confirmChoice({
    title: 'Erase all progress?',
    body: 'This removes your reviews, streak and stats for both languages on this device. It can’t be undone, so export a backup first if you might want them back.',
    actions: [
      { label: 'Erase progress', value: 'reset', style: 'btn-danger' },
      { label: 'Cancel', value: 'cancel', style: 'btn-quiet' },
    ],
  });
  if (choice !== 'reset') return;
  const { direction, installDismissed, theme } = state.meta;
  state.meta = Object.assign(defaultMeta(), { direction, installDismissed, theme });
  for (const dir of Object.keys(DIRECTIONS)) {
    state.progress[dir] = {};
    saveProgress(dir);
  }
  saveMeta();
  store.flush();
  setStatus('Progress erased.');
}

// ---------------------------------------------------------------- install

let installPrompt = null;

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function renderInstallNotice() {
  const notice = $('install-notice');
  const canOffer = installPrompt || isIOS();
  notice.hidden = isStandalone() || state.meta.installDismissed || !canOffer || !store.available;
  if (notice.hidden) return;
  $('install-btn').hidden = !installPrompt;
  $('install-text').textContent = installPrompt
    ? 'Install lingo so it opens like an app and keeps your progress safe.'
    : 'Add lingo to your Home Screen to keep your progress safe. Safari may clear data for sites that aren’t installed. Tap Share, then Add to Home Screen.';
}

async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  renderInstallNotice();
}

// ---------------------------------------------------------------- events

function bindEvents() {
  for (const btn of document.querySelectorAll('.direction-option')) {
    btn.addEventListener('click', () => selectDirection(btn.dataset.dir));
  }
  for (const el of document.querySelectorAll('[data-go]')) {
    el.addEventListener('click', () => show(el.dataset.go));
  }

  $('start-btn').addEventListener('click', startLesson);
  $('again-btn').addEventListener('click', startLesson);
  $('quit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    quitLesson();
  });

  $('exclude-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    excludeCurrent();
  });
  $('excluded-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (btn) restoreExcluded(btn.dataset.dir, btn.dataset.id);
  });

  $('options').addEventListener('click', (e) => {
    const btn = e.target.closest('.option');
    if (!btn) return;
    e.stopPropagation();
    if (state.lesson.answered) nextQuestion();
    else answer(Number(btn.dataset.index));
  });
  $('next-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    nextQuestion();
  });
  // After answering, a tap anywhere on the quiz screen moves on (links excepted).
  $('screen-quiz').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    if (state.lesson && state.lesson.answered) nextQuestion();
  });

  document.addEventListener('keydown', (e) => {
    if ($('screen-quiz').hidden || !state.lesson || $('confirm').open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!state.lesson.answered && /^[1-5]$/.test(e.key)) {
      answer(Number(e.key) - 1);
    } else if (state.lesson.answered && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      nextQuestion();
    }
  });

  for (const btn of $('theme-picker').children) {
    btn.addEventListener('click', () => selectTheme(btn.dataset.theme));
  }
  darkQuery.addEventListener('change', applyTheme);

  $('export-btn').addEventListener('click', exportProgress);
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) importProgress(file);
  });
  $('reset-btn').addEventListener('click', resetProgress);

  $('install-btn').addEventListener('click', installApp);
  $('install-dismiss').addEventListener('click', () => {
    state.meta.installDismissed = true;
    saveMeta();
    renderInstallNotice();
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    renderInstallNotice();
  });

  // Write pending changes before the page is hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flush();
  });
  window.addEventListener('pagehide', store.flush);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
    // A new deploy's worker takes over mid-session: reload once so its files are used right away.
    if (navigator.serviceWorker.controller) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded || state.lesson) return;
        reloaded = true;
        location.reload();
      });
    }
  }
  // Ask the browser not to evict our data under storage pressure.
  if (store.available && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

bindEvents();
applyTheme();
show('start');
registerServiceWorker();
