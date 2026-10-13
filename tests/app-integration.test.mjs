import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as queues from '../study-queues.mjs';
import * as rules from '../study-rules.mjs';
import * as storageRules from '../progress-storage.mjs';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const questions = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url)));
const report = JSON.parse(readFileSync(new URL('../data/import_report.json', import.meta.url)));
const { STORAGE_KEY, SESSION_STORAGE_KEY, BACKUP_KEY } = storageRules;
const date = (n) => new Date(Date.UTC(2026, 8, n)).toISOString();
const history = Array.from({ length: 15 }, (_, i) => ({ at: date(i + 1), answer: 'A', correct: false, confidence: 'low' }));

async function loadApp(saved, active = null) {
  const memory = new Map([[STORAGE_KEY, JSON.stringify(saved)]]);
  if (active) memory.set(SESSION_STORAGE_KEY, JSON.stringify(active));
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, addEventListener() {}, value: '' });
  const document = { querySelector: (key) => { if (!elements.has(key)) elements.set(key, element()); return elements.get(key); }, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: {} };
  const localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  const context = vm.createContext({ ...queues, ...rules, ...storageRules, console, document, localStorage, window: { setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, addEventListener() {}, scrollTo() {} },
    fetch: async (url) => ({ json: async () => structuredClone(url.includes('questions.json') ? questions : report) }),
    createCloudSync: async () => ({ configured: false, schedule() {} }),
  });
  vm.runInContext(appSource.replace(/init\(\);\s*$/, 'globalThis.ready = init();'), context);
  await context.ready;
  return { context, memory, run: (code) => vm.runInContext(code, context), html: () => elements.get('#app-view').innerHTML };
}

const base = () => ({ version: 1, attempts: {}, daily: {}, mockHistory: [{ at: date(1), score: 70 }], settings: { dailyTarget: 50 }, updatedAt: date(15) });

test('real app restores legacy active round and byte-for-byte backup, then appends without truncating history', async () => {
  const saved = base();
  const id = queues.questionId(questions[0]);
  saved.attempts[id] = { attempts: 15, correct: 0, wrong: 15, confidence: 'low', lastCorrect: false, status: 'new', reviewPending: false, dueAt: date(16), history, notes: '历史笔记' };
  saved.daily['2026-09-01'] = { ids: [id] };
  const active = { savedAt: Date.now(), session: { mode: 'daily', answers: {}, startedAt: Date.now() }, queue: [id, queues.questionId(questions[1])], queueIndex: 0, selected: ['B'], confidence: 'low', submitted: false, timerSeconds: 0 };
  const app = await loadApp(saved, active);
  assert.equal(app.memory.get(STORAGE_KEY), JSON.stringify(saved));
  assert.equal(JSON.parse(app.memory.get(BACKUP_KEY)).progress, JSON.stringify(saved));
  assert.equal(JSON.parse(app.memory.get(BACKUP_KEY)).activeSession, JSON.stringify(active));
  assert.equal(app.run('state.queueIndex'), 0);
  assert.equal(app.run('[...state.selected].join()'), 'B');
  assert.equal(app.run('state.confidence'), 'low');
  assert.doesNotMatch(app.html(), /正确答案 ·/);
  app.run('recordAnswer(); renderPractice();');
  const result = JSON.parse(app.memory.get(STORAGE_KEY));
  assert.equal(result.attempts[id].history.length, 16);
  assert.deepEqual(result.attempts[id].history.slice(0, 15), history);
  assert.equal(result.attempts[id].wrong, 15);
  assert.equal(result.attempts[id].notes, '历史笔记');
  assert.deepEqual(result.daily['2026-09-01'], saved.daily['2026-09-01']);
  assert.deepEqual(result.mockHistory, saved.mockHistory);
  assert.match(app.html(), /正确答案 · B/);
  app.run('recordAnswer();');
  assert.equal(JSON.parse(app.memory.get(STORAGE_KEY)).attempts[id].history.length, 16);
});

test('real app uses ten reviews on all entries and preserves progress on startup', async () => {
  const saved = base();
  for (const q of questions.slice(0, 25)) saved.attempts[queues.questionId(q)] = { attempts: 1, correct: 0, wrong: 1, lastCorrect: false, confidence: 'high', status: 'new', dueAt: date(1), reviewPending: false, history: [history[0]] };
  const app = await loadApp(saved);
  assert.equal(app.memory.get(STORAGE_KEY), JSON.stringify(saved));
  for (const mode of ['daily', 'wrong', 'wrong-book']) {
    app.run(`startSession('${mode}')`);
    assert.equal(app.run('state.session.reviewIds.length'), 10);
    assert.equal(app.run('state.queue.length'), mode === 'daily' ? 50 : 10);
    assert.match(app.html(), /本轮 10 道复习/);
  }
  app.run('renderStats()');
  assert.match(app.html(), /导出升级前备份/);
  assert.match(app.html(), /答案冲突 · 待人工确认/);
});

test('an answer submitted during cloud upload survives; sync requests one further upload and settles', async () => {
  const source = readFileSync(new URL('../supabase-sync.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '').replace('await import(SUPABASE_ESM_URL)', 'await Promise.resolve({ createClient: testClientFactory })');
  let live = base();
  let cloud = base();
  const timers = [];
  let release;
  let uploadStarted;
  const barrier = new Promise((resolve) => { uploadStarted = resolve; });
  let hold = true;
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'test-user' } } } }), onAuthStateChange() {} },
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { progress: cloud } }), upsert: async ({ progress }) => {
      if (hold) { uploadStarted(); await new Promise((resolve) => { release = resolve; }); }
      cloud = structuredClone(progress);
      return {};
    } }),
  };
  const context = vm.createContext({ console, SUPABASE_URL: 'test', SUPABASE_PUBLISHABLE_KEY: 'test', testClientFactory: () => client, window: { setTimeout: (fn) => timers.push(fn), clearTimeout() {} }, getProgress: () => live, setProgress: (progress) => { live = progress; } });
  vm.runInContext(`${source}\nglobalThis.ready = createCloudSync({ getProgress, setProgress });`, context);
  const sync = await context.ready;
  const pending = sync.syncNow();
  await barrier;
  live.attempts.newAnswer = { attempts: 1, correct: 0, wrong: 1, history: [history[0]], updatedAt: date(16) };
  live.daily['2026-10-13'] = { ids: ['newAnswer'] };
  const writtenWhileUploading = structuredClone(live.attempts.newAnswer);
  release();
  await pending;
  assert.deepEqual(live.attempts.newAnswer, writtenWhileUploading);
  assert.equal(timers.length, 2); // initial login sync + exactly one follow-up
  hold = false;
  await sync.syncNow();
  assert.deepEqual(cloud.attempts.newAnswer, writtenWhileUploading);
  assert.equal(timers.length, 2);
});
