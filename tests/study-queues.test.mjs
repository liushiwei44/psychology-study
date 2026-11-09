import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildQuestionIndex, buildPracticeQueue, questionId, selectDueQuestions, selectNewQuestions, isDueForReview } from '../study-queues.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const past = '2026-10-01T00:00:00Z';
const make = (n, overrides = {}) => ({ source_file: 'test.pdf', source_question_no: n, type: 'single', stem: `题目${n}`, options: ['甲', '乙', '丙', '丁'].map((text, i) => ({ key: 'ABCD'[i], text })), answer: 'A', ...overrides });
const wrong = { attempts: 1, correct: 0, wrong: 1, confidence: 'high', lastCorrect: false, dueAt: past, status: 'new', reviewPending: false };

test('50/100/150/200-question rounds never contain more than ten reviews', () => {
  for (const target of [50, 100, 150, 200]) {
    const questions = Array.from({ length: 600 }, (_, i) => make(i));
    const index = buildQuestionIndex(questions);
    const attempts = Object.fromEntries(questions.slice(0, 40).map((q) => [questionId(q), { ...wrong }]));
    const getAttempt = (q) => attempts[questionId(q)] || {};
    const todayIds = [];
    for (let round = 0; round < 2; round++) {
      const due = selectDueQuestions(questions, getAttempt, NOW);
      const queue = buildPracticeQueue({ index, getAttempt, due, todayIds, target });
      assert.equal(queue.length, target);
      assert.equal(queue.filter((id) => attempts[id]).length, 10);
      assert.ok(queue.every((id) => !todayIds.includes(id)));
      for (const id of queue) attempts[id] = { attempts: 1, lastCorrect: true, confidence: 'high', reviewPending: false };
      todayIds.push(...queue);
    }
  }
});

test('few/no due reviews leave the rest of the round to new questions; review entry falls back to new', () => {
  const questions = Array.from({ length: 80 }, (_, i) => make(i));
  const index = buildQuestionIndex(questions);
  for (const count of [0, 3, 20]) {
    const attempts = Object.fromEntries(questions.slice(0, count).map((q) => [questionId(q), wrong]));
    const getAttempt = (q) => attempts[questionId(q)] || {};
    const due = selectDueQuestions(questions, getAttempt, NOW);
    const queue = buildPracticeQueue({ index, getAttempt, due, target: 50 });
    assert.equal(queue.length, 50);
    assert.equal(queue.filter((id) => attempts[id]).length, Math.min(10, count));
    const reviews = buildPracticeQueue({ index, getAttempt, due, target: 50, reviewOnly: true });
    assert.equal(reviews.length, count ? Math.min(10, count) : 50);
  }
  assert.deepEqual(buildPracticeQueue({ index, getAttempt: () => wrong, due: [] }), []);
});

test('daily review limit is shared across all five types, and review IDs are a contiguous prefix', () => {
  const types = ['single', 'multiple', 'judgment', 'case_single', 'case_multiple'];
  const old = Array.from({ length: 25 }, (_, n) => make(n + 1, { type: types[n % types.length] }));
  const fresh = Array.from({ length: 60 }, (_, n) => make(100 + n));
  const questions = [...old, ...fresh];
  const index = buildQuestionIndex(questions);
  const attempts = Object.fromEntries(old.map((q) => [questionId(q), { ...wrong }]));
  const before = structuredClone(attempts);
  const getAttempt = (q) => attempts[questionId(q)] || {};
  const due = selectDueQuestions(questions, getAttempt, NOW);
  for (const reviewOnly of [false, true]) {
    const queue = buildPracticeQueue({ index, getAttempt, due, reviewOnly });
    assert.deepEqual(queue.slice(0, 10), old.slice(0, 10).map(questionId));
    assert.equal(queue.length, reviewOnly ? 10 : 50);
    if (!reviewOnly) assert.ok(queue.slice(10).every((id) => !attempts[id]));
  }
  assert.deepEqual(attempts, before);
});

test('a large single-choice backlog cannot crowd due specialty mistakes out of a review round', () => {
  const singles = Array.from({ length: 20 }, (_, n) => make(n + 1));
  const specialties = ['multiple', 'judgment', 'case_single', 'case_multiple'].map((type, n) => make(100 + n, { type }));
  const fresh = Array.from({ length: 50 }, (_, n) => make(200 + n));
  const questions = [...singles, ...specialties, ...fresh];
  const index = buildQuestionIndex(questions);
  const attempts = Object.fromEntries([...singles, ...specialties].map((q) => [questionId(q), { ...wrong, wrong: q.type === 'single' ? 3 : 1 }]));
  const before = structuredClone(attempts);
  const getAttempt = (q) => attempts[questionId(q)] || {};
  const due = selectDueQuestions(questions, getAttempt, NOW);
  for (const reviewOnly of [false, true]) {
    const queue = buildPracticeQueue({ index, getAttempt, due, reviewOnly });
    assert.deepEqual(queue.slice(0, 5), [singles[0], ...specialties].map(questionId));
    assert.deepEqual(queue.slice(5, 10), singles.slice(1, 6).map(questionId));
    assert.equal(queue.length, reviewOnly ? 10 : 50);
    if (!reviewOnly) assert.ok(queue.slice(10).every((id) => !attempts[id]));
  }
  assert.deepEqual(attempts, before);
});

test('type rotation filters today and duplicate groups before assigning slots, then keeps within-type priority', () => {
  const singles = Array.from({ length: 20 }, (_, n) => make(n + 1));
  const multiples = Array.from({ length: 13 }, (_, n) => make(100 + n, { type: 'multiple' }));
  const duplicate = make(999, { type: 'multiple', stem: multiples[0].stem });
  const questions = [...singles, ...multiples, duplicate];
  const index = buildQuestionIndex(questions);
  const attempts = Object.fromEntries(questions.map((q) => [questionId(q), { ...wrong, wrong: q.type === 'single' ? 3 : 1 }]));
  attempts[questionId(singles[2])].wrong = 5;
  attempts[questionId(singles[4])].dueAt = '2026-09-01T00:00:00Z';
  const getAttempt = (q) => attempts[questionId(q)] || {};
  const todayIds = [duplicate, ...multiples.slice(1, 12)].map(questionId);
  const queue = buildPracticeQueue({ index, getAttempt, due: selectDueQuestions(questions, getAttempt, NOW), todayIds, reviewOnly: true });
  assert.deepEqual(queue.slice(0, 3), [singles[2], multiples[12], singles[4]].map(questionId));
  assert.equal(queue.length, 10);
  assert.ok(queue.every((id) => !todayIds.includes(id)));
  assert.ok(!queue.includes(questionId(multiples[0])));
});

test('type rotation retains wrong-before-guessed-before-uncertain priority', () => {
  for (const count of [1, 8, 12]) {
    const mistakes = Array.from({ length: count }, (_, n) => make(n + 1));
    const guesses = Array.from({ length: 5 }, (_, n) => make(100 + n, { type: 'multiple' }));
    const uncertain = make(200, { type: 'judgment' });
    const questions = [...mistakes, ...guesses, uncertain];
    const getAttempt = (q) => q.type === 'single' ? wrong : { ...wrong, wrong: 0, lastCorrect: true, confidence: q.type === 'multiple' ? 'low' : 'medium', reviewPending: true };
    const queue = buildPracticeQueue({ index: buildQuestionIndex(questions), getAttempt, due: selectDueQuestions(questions, getAttempt, NOW), reviewOnly: true });
    assert.deepEqual(queue, questions.slice(0, 10).map(questionId));
  }
});

test('wrong then guessed then uncertain; confident corrected items pause without mutation', () => {
  const questions = Array.from({ length: 6 }, (_, i) => make(i));
  const values = [
    { ...wrong, wrong: 0, confidence: 'medium', lastCorrect: true, reviewPending: true },
    { ...wrong, wrong: 0, confidence: 'low', lastCorrect: true, reviewPending: true },
    { ...wrong },
    { ...wrong, lastCorrect: true },
    { ...wrong, dueAt: '2030-01-01' },
    { ...wrong, status: 'mastered' },
  ];
  const before = structuredClone(values);
  assert.deepEqual(selectDueQuestions(questions, (q) => values[q.source_question_no], NOW).map((q) => q.source_question_no), [2, 1, 0]);
  assert.deepEqual(values, before);
  assert.equal(isDueForReview({ ...wrong, lastCorrect: undefined, history: [{ correct: true }] }, NOW), false);
});

test('dedup handles shuffled options but retains changed options, negation, types and conflicting answers', () => {
  const base = make(1, { stem: '长时记忆的编码方式？' });
  const shuffled = make(2, { stem: '长时记忆的编码方式?', options: [...base.options].reverse().map((o, i) => ({ key: 'ABCD'[i], text: o.text })), answer: 'D' });
  const changed = make(3, { stem: base.stem, options: base.options.map((o) => o.key === 'B' ? { ...o, text: '另一种选择' } : o) });
  const negated = make(4, { stem: '不是长时记忆的编码方式？' });
  const multiple = make(5, { stem: base.stem, type: 'multiple' });
  const items = [base, shuffled, changed, negated, multiple];
  const before = structuredClone(items);
  assert.equal(buildQuestionIndex(items).groups.length, 4);
  const conflict = make(6, { stem: base.stem, answer: 'B' });
  const index = buildQuestionIndex([...items, conflict]);
  assert.equal(index.groups.length, 6);
  assert.equal(index.conflicts.length, 1);
  assert.deepEqual(items, before);
});

test('order-sensitive options are not collapsed after shuffling', () => {
  const a = make(1, { options: ['甲', '乙', 'A 和 B', '以上各项'].map((text, i) => ({ key: 'ABCD'[i], text })) });
  const b = make(2, { stem: a.stem, options: [...a.options].reverse().map((o, i) => ({ ...o, key: 'ABCD'[i] })), answer: 'D' });
  assert.equal(buildQuestionIndex([a, b]).groups.length, 2);
});

test('a completed noncanonical duplicate covers the group; old wrong/guessed IDs remain reviewable', () => {
  const a = make(1), b = make(2, { stem: a.stem }), fresh = make(3);
  const questions = [a, b, fresh];
  const index = buildQuestionIndex(questions);
  const attempts = { [questionId(b)]: { ...wrong, confidence: 'low', notes: '保留备注' } };
  const original = structuredClone(attempts);
  const getAttempt = (q) => attempts[questionId(q)] || {};
  assert.deepEqual(selectNewQuestions(index, getAttempt).map(questionId), [questionId(fresh)]);
  assert.deepEqual(buildPracticeQueue({ index, getAttempt, due: selectDueQuestions(questions, getAttempt, NOW) }), [questionId(b), questionId(fresh)]);
  assert.deepEqual(attempts, original);
  attempts[questionId(a)] = { ...wrong };
  const due = selectDueQuestions(questions, getAttempt, NOW);
  assert.equal(due.length, 2);
  assert.equal(buildPracticeQueue({ index, getAttempt, due, reviewOnly: true }).length, 1);
  assert.deepEqual(buildPracticeQueue({ index, getAttempt, due, todayIds: [questionId(b)], reviewOnly: true }), [questionId(fresh)]);
  assert.equal(Object.keys(attempts).length, 2);
});

test('full-bank audit remains reproducible; every usable original ID stays indexed', () => {
  const raw = readFileSync(new URL('../data/questions.json', import.meta.url));
  const questions = JSON.parse(raw);
  const report = JSON.parse(readFileSync(new URL('../data/duplicate_report.json', import.meta.url)));
  const index = buildQuestionIndex(questions);
  assert.equal(questions.length, 9488);
  assert.equal(index.groupById.size, 9484);
  assert.equal(index.groups.length, 9451);
  assert.equal(index.groups.filter((g) => g[0].type !== 'judgment').length, 7979);
  assert.equal(index.conflicts.length, 1);
  assert.equal(report.bank_sha256, createHash('sha256').update(raw).digest('hex'));
});
