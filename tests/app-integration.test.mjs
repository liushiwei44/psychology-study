import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as queues from '../study-queues.mjs';
import * as rules from '../study-rules.mjs';
import * as storageRules from '../progress-storage.mjs';
import * as exams from '../exam-engine.mjs';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const questions = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url)));
const report = JSON.parse(readFileSync(new URL('../data/import_report.json', import.meta.url)));
const caseBank = JSON.parse(readFileSync(new URL('../data/case-exercises.json', import.meta.url)));
const examConfig = JSON.parse(readFileSync(new URL('../data/exam-templates.json', import.meta.url)));
const { STORAGE_KEY, SESSION_STORAGE_KEY, BACKUP_KEY } = storageRules;
const date = (n) => new Date(Date.UTC(2026, 8, n)).toISOString();
const history = Array.from({ length: 15 }, (_, i) => ({ at: date(i + 1), answer: 'A', correct: false, confidence: 'low' }));

async function loadApp(saved, active = null, { failProgressSave = false, existingBackup = null, nowMs = null } = {}) {
  let clockNow = nowMs;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockNow])); }
    static now() { return clockNow; }
  }
  const memory = new Map([[STORAGE_KEY, JSON.stringify(saved)]]);
  if (active) memory.set(SESSION_STORAGE_KEY, JSON.stringify(active));
  if (existingBackup) memory.set(BACKUP_KEY, existingBackup);
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, addEventListener() {}, value: '' });
  const document = { querySelector: (key) => { if (!elements.has(key)) elements.set(key, element()); return elements.get(key); }, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: {} };
  const localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => { if (failProgressSave && key === STORAGE_KEY) throw new Error('QuotaExceeded'); memory.set(key, value); }, removeItem: (key) => memory.delete(key) };
  const context = vm.createContext({ ...queues, ...rules, ...storageRules, ...exams, ...(nowMs === null ? {} : {
    Date: ClockDate,
    planReview: (previous, options) => rules.planReview(previous, { ...options, nowMs: clockNow }),
    isDueForReview: (attempt) => queues.isDueForReview(attempt, clockNow),
    selectDueQuestions: (items, getAttempt) => queues.selectDueQuestions(items, getAttempt, clockNow),
  }), console, document, localStorage, window: { setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, addEventListener() {}, scrollTo() {} },
    fetch: async (url) => ({ json: async () => structuredClone(url.includes('questions.json') ? questions : url.includes('case-exercises') ? caseBank : url.includes('exam-templates') ? examConfig : report) }),
    createCloudSync: async () => ({ configured: false, schedule() {} }),
  });
  vm.runInContext(appSource.replace(/init\(\);\s*$/, 'globalThis.ready = init();'), context);
  await context.ready;
  return { context, memory, run: (code) => vm.runInContext(code, context), html: () => elements.get('#app-view').innerHTML, setNow: (value) => { clockNow = value; } };
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
  assert.match(app.html(), /导出本次升级前备份/);
  assert.match(app.html(), /答案冲突 · 待人工确认/);
});

test('specialties append to the same totals and permanent wrong book without changing 3000 legacy records', async () => {
  const saved = base();
  for (const q of questions.filter((q) => q.type === 'single').slice(0, 3100)) saved.attempts[queues.questionId(q)] = { attempts: 1, correct: 0, wrong: 1, lastCorrect: false, confidence: 'low', status: 'new', dueAt: date(1), history: [history[0]], notes: '珍贵笔记' };
  const app = await loadApp(saved, null, { existingBackup: 'old untouched snapshot' });
  assert.equal(app.memory.get(BACKUP_KEY), 'old untouched snapshot');
  assert.equal(JSON.parse(app.memory.get(storageRules.FEATURE_BACKUP_KEY)).progress, JSON.stringify(saved));
  for (const type of ['multiple', 'case_single', 'case_multiple', 'judgment']) {
    app.run(`startSession('specialty', '', { type: '${type}' }); state.selected = new Set(['Z']); recordAnswer(); renderPractice();`);
    assert.equal(app.run('currentQuestion().type'), type);
    assert.equal(app.run('getAttempt(currentQuestion()).wrong'), 1);
    assert.equal(app.run('isWrongBookEntry(getAttempt(currentQuestion()))'), true);
    assert.equal(app.run('state.progress.daily[todayKey()].ids.includes(questionId(currentQuestion()))'), true);
    assert.match(app.html(), /正确答案 ·/);
  }
  const result = JSON.parse(app.memory.get(STORAGE_KEY));
  for (const [id, attempt] of Object.entries(saved.attempts)) assert.deepEqual(result.attempts[id], attempt);
  assert.equal(Object.keys(result.attempts).length, 3104);
  assert.deepEqual(result.mockHistory, saved.mockHistory);
  app.run('renderStats()');
  assert.match(app.html(), /3104/);
});

test('wrong answers from every specialty join the front of daily practice at 24 hours, without changing an open round', async () => {
  const now = Date.parse('2026-11-04T02:00:00Z');
  const app = await loadApp(base(), null, { nowMs: now });
  const ids = [];
  for (const type of ['single', 'multiple', 'judgment', 'case_single', 'case_multiple']) {
    app.run(`startSession('specialty', '', { type: '${type}' });
      state.selected = new Set([currentQuestion().options[0].key]);
      if (isCorrect(currentQuestion(), state.selected)) state.selected = new Set([currentQuestion().options[1].key]);
      recordAnswer();`);
    ids.push(app.run('questionId(currentQuestion())'));
    assert.equal(app.run('getAttempt(currentQuestion()).wrong'), 1);
    assert.equal(Date.parse(app.run('getAttempt(currentQuestion()).dueAt')), now + 86400000);
    assert.match(app.run('reviewStatus(getAttempt(currentQuestion()))'), /下次.*\d{2}:\d{2}/);
  }
  app.setNow(now + 86400000 - 1);
  assert.equal(app.run('dueQuestions().length'), 0);
  app.run(`startSession('daily');`);
  const active = JSON.parse(app.memory.get(SESSION_STORAGE_KEY));
  const saved = JSON.parse(app.memory.get(STORAGE_KEY));
  assert.equal(app.run('state.session.reviewIds.length'), 0);
  const restored = await loadApp(saved, active, { nowMs: now + 86400000 });
  assert.deepEqual(Array.from(restored.run('state.queue')), active.queue);
  assert.equal(restored.run('state.session.reviewIds.length'), 0);
  restored.run(`startSession('daily');`);
  assert.equal(restored.run('state.queue.length'), 50);
  assert.deepEqual(Array.from(restored.run('state.queue.slice(0, 5)')).sort(), ids.slice().sort());
  assert.equal(restored.run('state.session.reviewIds.length'), 5);
  assert.equal(restored.run('state.queue.slice(5).every((id) => !state.progress.attempts[id]?.attempts)'), true);
  assert.match(restored.run('reviewStatus(getAttempt(currentQuestion()))'), /已到期/);
  restored.run('renderDashboard();');
  assert.match(restored.html(), /判断 1 道/);
  assert.match(restored.html(), /多选 1 道/);
  assert.deepEqual(JSON.parse(restored.memory.get(STORAGE_KEY)), saved);
});

test('all shared review entries rotate specialty mistakes past old singles without rewriting an open round or progress', async () => {
  const now = Date.parse('2026-11-09T02:00:00Z');
  const saved = base();
  const singles = questions.filter((q) => q.type === 'single').slice(0, 20);
  for (const q of singles) saved.attempts[queues.questionId(q)] = { attempts: 3, correct: 0, wrong: 3, lastCorrect: false, confidence: 'high', status: 'new', dueAt: date(1), history: [history[0]], notes: '历史笔记' };
  const initial = await loadApp(saved, null, { nowMs: now - 86400000 });
  for (const type of ['multiple', 'judgment', 'case_single', 'case_multiple']) {
    initial.run(`startSession('specialty', '', { type: '${type}' }); state.selected = new Set(['Z']); recordAnswer();`);
  }
  const progress = JSON.parse(initial.memory.get(STORAGE_KEY));
  const active = { savedAt: now - 1000, session: { mode: 'daily', startedAt: now - 1000, answers: {}, reviewIds: singles.slice(0, 10).map(queues.questionId) }, queue: singles.slice(0, 10).map(queues.questionId), queueIndex: 4, selected: ['A'], confidence: 'low', submitted: false, timerSeconds: 0 };
  const app = await loadApp(progress, active, { nowMs: now });
  assert.deepEqual(Array.from(app.run('state.queue')), active.queue);
  assert.equal(app.run('state.queueIndex'), 4);
  assert.equal(app.run('[...state.selected].join()'), 'A');
  for (const mode of ['daily', 'wrong', 'wrong-book']) {
    app.run(`startSession('${mode}');`);
    assert.equal(app.run('state.queue.length'), mode === 'daily' ? 50 : 10);
    assert.equal(app.run('state.session.reviewIds.length'), 10);
    assert.deepEqual(Array.from(app.run('state.queue.slice(0, 5).map((id) => state.questions.find((q) => questionId(q) === id).type)')).sort(), ['single', 'multiple', 'judgment', 'case_single', 'case_multiple'].sort());
  }
  assert.deepEqual(JSON.parse(app.memory.get(STORAGE_KEY)), progress);
  for (const [id, attempt] of Object.entries(saved.attempts)) assert.deepEqual(progress.attempts[id], attempt);
});

test('same source number in single and multiple remains two records; references show type and original number', async () => {
  const single = questions.find((q) => q.type === 'single' && q.source_question_no === 1);
  const multiple = questions.find((q) => q.type === 'multiple' && q.source_question_no === 1);
  const judgment = questions.find((q) => q.type === 'judgment' && q.source_question_no === 4001);
  const saved = base();
  for (const q of [single, multiple, judgment]) saved.attempts[queues.questionId(q)] = { attempts: 1, correct: 0, wrong: 1, lastCorrect: false, confidence: 'high', dueAt: date(1), status: 'new', history: [history[0]] };
  const app = await loadApp(saved);
  assert.notEqual(queues.questionId(single), queues.questionId(multiple));
  assert.equal(app.run('questionReference(state.questions.find((q) => q.type === "single" && q.source_question_no === 1))'), '单选 · 原题号 1');
  assert.equal(app.run('questionReference(state.questions.find((q) => q.type === "multiple" && q.source_question_no === 1))'), '多选 · 原题号 1');
  assert.equal(app.run('questionReference(state.questions.find((q) => q.type === "judgment" && q.source_question_no === 4001))'), '判断 · 原题号 4001');
  app.run('startSession("daily");');
  assert.match(app.html(), /本轮 1 \/ 50 题/);
  assert.match(app.html(), /单选 · 原题号 1/);
  assert.match(app.html(), /来源：最新版【单选题\+判断题】\.pdf/);
  app.run('renderWrong();');
  assert.match(app.html(), /最新版【多选题】\.pdf/);
  assert.match(app.html(), /原题 4001/);
  assert.deepEqual(JSON.parse(app.memory.get(STORAGE_KEY)), saved);
});

test('new mocks hide answers and history until hand-in, then retain partial scores and all attempts exactly once', async () => {
  const saved = base();
  const app = await loadApp(saved);
  app.run(`startSession('mock', '基础知识'); state.selected = new Set(getCorrectKeys(currentQuestion())); recordAnswer(); renderPractice();`);
  assert.equal(app.run('state.queue.length'), 95);
  assert.equal(app.memory.get(STORAGE_KEY), JSON.stringify(saved));
  assert.doesNotMatch(app.html(), /正确答案 ·|option correct|已进入错题本|下次复习/);
  const firstId = app.run('state.queue[0]');
  app.run(`jumpMock(75); state.selected = new Set([getCorrectKeys(currentQuestion())[0]]); recordAnswer(); renderPractice();`);
  assert.doesNotMatch(app.html(), /正确答案 ·|option correct/);
  const partialId = app.run('questionId(currentQuestion())');
  const active = JSON.parse(app.memory.get(SESSION_STORAGE_KEY));
  const restored = await loadApp(saved, active);
  assert.equal(restored.run('state.queueIndex'), 75);
  assert.equal(restored.run('state.selected.size'), 1);
  restored.run('finalizeMock()');
  const progress = JSON.parse(restored.memory.get(STORAGE_KEY));
  assert.equal(progress.attempts[firstId].correct, 1);
  assert.equal(progress.attempts[partialId].wrong, 1);
  assert.equal(progress.mockHistory.at(-1).score, 1.5);
  assert.equal(progress.mockHistory.at(-1).unanswered, 93);
  assert.equal(progress.mockHistory.at(-1).rows.length, 95);
  assert.equal(Object.keys(progress.attempts).length, 2);
  assert.equal(restored.memory.has(SESSION_STORAGE_KEY), false);
  restored.run('finalizeMock()');
  assert.deepEqual(JSON.parse(restored.memory.get(STORAGE_KEY)), progress);
  assert.match(restored.html(), /逐题答案与解析/);
});

test('mock editing changes only the draft; failed hand-in preserves draft and original progress', async () => {
  const saved = base();
  const app = await loadApp(saved, null, { failProgressSave: true });
  app.run(`startSession('mock', '专业技能'); state.selected = new Set(['A']); recordAnswer(); jumpMock(0); state.selected = new Set(['B']); recordAnswer(); finalizeMock();`);
  assert.equal(app.memory.get(STORAGE_KEY), JSON.stringify(saved));
  assert.equal(app.run('Object.keys(state.progress.attempts).length'), 0);
  assert.equal(app.run('state.session.mode'), 'mock');
  assert.equal(app.run('state.session.answers[state.queue[0]].selected.join()'), 'B');
  assert.equal(app.memory.has(SESSION_STORAGE_KEY), true);
});

test('an unfinished old mock uses its old grading and never duplicates saved attempts', async () => {
  const saved = base();
  const id = queues.questionId(questions[0]);
  saved.attempts[id] = { attempts: 1, correct: 1, wrong: 0, history: [history[0]] };
  const active = { savedAt: Date.now(), session: { mode: 'mock', subject: '基础知识', answers: { [id]: { answered: true, correct: true } }, startedAt: Date.now() }, queue: [id], queueIndex: 0, selected: ['B'], confidence: 'high', submitted: true, timerSeconds: 500 };
  const app = await loadApp(saved, active);
  assert.doesNotMatch(app.html(), /正确答案 ·|option correct/);
  app.run('finalizeMock()');
  const progress = JSON.parse(app.memory.get(STORAGE_KEY));
  assert.deepEqual(progress.attempts, saved.attempts);
  assert.equal(progress.mockHistory.at(-1).score, 100);
  assert.equal(progress.mockHistory.at(-1).scoringVersion, undefined);
});

test('clearing a saved multiple-choice draft really clears it when navigating or handing in', async () => {
  const app = await loadApp(base());
  app.run(`startSession('mock', '基础知识'); jumpMock(75); state.selected = new Set(['A']); recordAnswer(); jumpMock(75); state.selected = new Set(); jumpMock(76);`);
  assert.equal(app.run('Boolean(state.session.answers[state.queue[75]])'), false);
  app.run(`state.selected = new Set(['B']); recordAnswer(); jumpMock(76); state.selected = new Set(); finalizeMock();`);
  assert.equal(app.run('state.progress.mockHistory.at(-1).unanswered'), 95);
  assert.equal(app.run('Object.keys(state.progress.attempts).length'), 0);
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
