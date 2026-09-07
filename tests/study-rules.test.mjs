import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasConfidenceReviewPending,
  isWrongBookAttempt,
  normalizeLegacyReviewState,
  planReview,
} from '../study-rules.mjs';

const NOW = Date.parse('2026-09-07T00:00:00.000Z');
const dueAfter = (days) => new Date(NOW + days * 86400000).toISOString();
const fresh = { attempts: 0, correct: 0, wrong: 0, confidence: null };

test('confident first-pass correct answers do not enter review', () => {
  assert.deepEqual(planReview(fresh, { correct: true, confidence: 'high', nowMs: NOW }), {
    status: 'reviewing',
    dueAt: null,
    reviewPending: false,
  });
});

test('guessed and uncertain first-pass correct answers use 3-day and 7-day intervals', () => {
  assert.deepEqual(planReview(fresh, { correct: true, confidence: 'low', nowMs: NOW }), {
    status: 'reviewing',
    dueAt: dueAfter(3),
    reviewPending: true,
  });
  assert.deepEqual(planReview(fresh, { correct: true, confidence: 'medium', nowMs: NOW }), {
    status: 'reviewing',
    dueAt: dueAfter(7),
    reviewPending: true,
  });
});

test('a correct confidence follow-up exits the review queue', () => {
  for (const confidence of ['low', 'medium', 'high']) {
    const previous = { attempts: 1, correct: 1, wrong: 0, confidence: 'low', reviewPending: true };
    assert.deepEqual(planReview(previous, { correct: true, confidence, nowMs: NOW }), {
      status: 'mastered',
      dueAt: null,
      reviewPending: false,
    });
  }
});

test('every wrong answer is due tomorrow and belongs to the wrong book', () => {
  for (const confidence of ['low', 'medium', 'high']) {
    const result = planReview(fresh, { correct: false, confidence, nowMs: NOW });
    assert.deepEqual(result, {
      status: 'new',
      dueAt: dueAfter(1),
      reviewPending: false,
    });
  }
  assert.equal(isWrongBookAttempt({ wrong: 1 }), true);
});

test('wrong-book questions retain the original repeated-review graduation rule', () => {
  const firstCorrect = planReview(
    { attempts: 1, correct: 0, wrong: 1, confidence: 'high' },
    { correct: true, confidence: 'high', nowMs: NOW },
  );
  assert.deepEqual(firstCorrect, {
    status: 'reviewing',
    dueAt: dueAfter(7),
    reviewPending: false,
  });

  const secondCorrect = planReview(
    { attempts: 2, correct: 1, wrong: 1, confidence: 'high' },
    { correct: true, confidence: 'high', nowMs: NOW },
  );
  assert.equal(secondCorrect.status, 'mastered');
  assert.equal(isWrongBookAttempt({ wrong: 1, status: 'mastered' }), true);
});

test('legacy uncertain records remain eligible for one confidence review', () => {
  assert.equal(hasConfidenceReviewPending({ attempts: 1, confidence: 'medium' }), true);
  assert.equal(hasConfidenceReviewPending({ attempts: 1, confidence: 'high' }), false);
  assert.equal(hasConfidenceReviewPending({ attempts: 2, confidence: 'low', reviewPending: false }), false);
});

test('legacy records are converted to the new confidence intervals without clearing progress', () => {
  const medium = normalizeLegacyReviewState({
    attempts: 1,
    correct: 1,
    wrong: 0,
    confidence: 'medium',
    dueAt: dueAfter(3),
    history: [{ at: new Date(NOW).toISOString(), correct: true, confidence: 'medium' }],
  });
  assert.equal(medium.reviewPending, true);
  assert.equal(medium.dueAt, dueAfter(7));

  const checkedAgain = normalizeLegacyReviewState({
    attempts: 2,
    correct: 2,
    wrong: 0,
    confidence: 'low',
    history: [
      { at: new Date(NOW - 3 * 86400000).toISOString(), correct: true, confidence: 'medium' },
      { at: new Date(NOW).toISOString(), correct: true, confidence: 'low' },
    ],
  });
  assert.equal(checkedAgain.reviewPending, false);
  assert.equal(checkedAgain.dueAt, null);
  assert.equal(checkedAgain.status, 'mastered');
});
