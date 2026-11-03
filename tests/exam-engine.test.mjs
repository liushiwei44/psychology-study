import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenCases, scoreAnswer, selectSpecialtyQuestions, buildExamPaper, gradeExam } from '../exam-engine.mjs';
import { buildQuestionIndex, questionId } from '../study-queues.mjs';
const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url)));
const originals = read('questions.json');
const bank = read('case-exercises.json');
const config = read('exam-templates.json');
const cases = flattenCases(bank);
const questions = [...originals, ...cases];
const index = buildQuestionIndex(questions);
const attempt = () => ({ attempts: 0 });

test('all six fixed papers match screenshot counts, sections, scoring and subjects, without duplicate IDs', () => {
  for (const template of config.templates) for (let n = 1; n <= 3; n += 1) {
    const paper = buildExamPaper(index, template, n);
    assert.deepEqual(paper, buildExamPaper(index, template, n));
    assert.equal(new Set(paper.entries.map((e) => e.id)).size, paper.entries.length);
    assert.equal(paper.entries.reduce((s, e) => s + e.points, 0), 100);
    assert.equal(paper.entries.length, template.subject === '基础知识' ? 95 : 90);
    for (const section of template.sections) {
      const entries = paper.entries.filter((e) => e.type === section.type);
      assert.equal(entries.length, section.count);
      for (const entry of entries) {
        const q = questions.find((q) => questionId(q) === entry.id);
        assert.equal(q.type, section.type);
        if (q.case_id) assert.equal(q.subject, template.subject);
        assert.equal(index.conflicts.some((g) => g.includes(q)), false);
      }
    }
    const perfect = Object.fromEntries(paper.entries.map((e) => [e.id, { selected: [...questions.find((q) => questionId(q) === e.id).answer] }]));
    assert.equal(gradeExam(paper.entries, questions, perfect).score, 100);
    const blank = gradeExam(paper.entries, questions, {});
    assert.equal(blank.score, 0);
    assert.equal(blank.unanswered, paper.entries.length);
  }
});

test('scoring handles all combinations; partial is fixed 0.5 only for nonempty proper subsets in multiple choice', () => {
  for (const answer of ['A', 'AB', 'ABD', 'ABCD']) for (let mask = 0; mask < 16; mask += 1) {
    const selected = [...'ABCD'].filter((_, n) => mask & (1 << n));
    const q = { type: 'multiple', answer };
    const exact = selected.join('') === answer;
    const subset = selected.length > 0 && selected.every((k) => answer.includes(k));
    assert.deepEqual(scoreAnswer(q, selected, 'multiple-partial', 1), { correct: exact, score: exact ? 1 : subset ? 0.5 : 0 });
    assert.equal(scoreAnswer({ ...q, type: 'case_multiple' }, selected, 'exact', 2).score, exact ? 2 : 0);
  }
});

test('cases have stable unique IDs, real materials and groups, answer keys, explanations and source labels', () => {
  assert.equal(bank.cases.length, 18);
  assert.equal(cases.length, 108);
  assert.equal(new Set(cases.map(questionId)).size, 108);
  for (const q of cases) {
    assert.ok(q.case_id && q.case_material.length > 60 && q.explanation);
    assert.match(q.provenance, /非.*官方/);
    assert.equal(q.options.length, 4);
    assert.ok([...q.answer].every((key) => q.options.some((o) => o.key === key)));
    if (q.type === 'case_single') assert.equal(q.answer.length, 1);
  }
  const changedMaterial = { ...cases[0], source_question_no: 'another', case_material: 'different context' };
  assert.equal(buildQuestionIndex([cases[0], changedMaterial]).groups.length, 2);
});

test('specialties choose only requested unseen type; a covered duplicate is not repeated, review stays <=10', () => {
  const progress = new Map();
  const get = (q) => progress.get(questionId(q)) || attempt();
  const queue = selectSpecialtyQuestions(index, get, 'multiple', 200);
  assert.equal(queue.length, 200);
  for (const id of queue) {
    assert.equal(questions.find((q) => questionId(q) === id).type, 'multiple');
    progress.set(id, { attempts: 1 });
  }
  assert.equal(selectSpecialtyQuestions(index, get, 'multiple', 200, 'review').length, 10);
  assert.equal(selectSpecialtyQuestions(index, get, 'multiple', 200).some((id) => queue.includes(id)), false);
  assert.equal(selectSpecialtyQuestions(index, get, 'case_multiple', 200).length, 18);
});

test('insufficient case pool stops assembly instead of filling cases with ordinary questions', () => {
  assert.throws(() => buildExamPaper(buildQuestionIndex(originals), config.templates[0], 1), /停止组卷/);
});
