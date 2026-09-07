const DAY_MS = 86400000;

export function isWrongBookAttempt(attempt = {}) {
  return Number(attempt.wrong || 0) > 0 || attempt.flagged === true;
}

export function hasConfidenceReviewPending(attempt = {}) {
  if (typeof attempt.reviewPending === 'boolean') return attempt.reviewPending;
  return Number(attempt.attempts || 0) > 0
    && (attempt.confidence === 'medium' || attempt.confidence === 'low');
}

export function normalizeLegacyReviewState(attempt = {}) {
  if (typeof attempt.reviewPending === 'boolean') return attempt;
  if (isWrongBookAttempt(attempt)) return { ...attempt, reviewPending: false };

  const history = attempt.history || [];
  const latest = history.at(-1);
  const preceding = history.at(-2);

  if (!latest?.correct) return { ...attempt, reviewPending: false };

  // Under the new rules, a successful second check closes an earlier
  // confidence-only review even if both answers were saved by an old client.
  if (preceding?.correct && (preceding.confidence === 'medium' || preceding.confidence === 'low')) {
    return { ...attempt, status: 'mastered', dueAt: null, reviewPending: false };
  }

  if (latest.confidence === 'medium' || latest.confidence === 'low') {
    const interval = latest.confidence === 'low' ? 3 : 7;
    const answeredAt = new Date(latest.at || attempt.updatedAt || 0).getTime();
    const dueAt = Number.isFinite(answeredAt) && answeredAt > 0
      ? new Date(answeredAt + interval * DAY_MS).toISOString()
      : attempt.dueAt;
    return { ...attempt, status: 'reviewing', dueAt, reviewPending: true };
  }

  return { ...attempt, dueAt: null, reviewPending: false };
}

export function planReview(previous, { correct, confidence, nowMs = Date.now() }) {
  const dueInDays = (days) => new Date(nowMs + days * DAY_MS).toISOString();

  // Every wrong answer enters (or returns to) the permanent wrong book.
  if (!correct) {
    return {
      status: 'new',
      dueAt: dueInDays(1),
      reviewPending: false,
    };
  }

  // Wrong-book questions keep the original repeated-review graduation rule:
  // one confident correct answer schedules another check; a later confident
  // correct answer marks the item mastered, while the item remains in the book.
  if (isWrongBookAttempt(previous)) {
    const mastered = confidence === 'high' && Number(previous.correct || 0) > 0;
    return {
      status: mastered ? 'mastered' : 'reviewing',
      dueAt: dueInDays(confidence === 'high' ? 7 : 3),
      reviewPending: false,
    };
  }

  // A confidence-based follow-up only needs one successful re-check.
  if (hasConfidenceReviewPending(previous)) {
    return {
      status: 'mastered',
      dueAt: null,
      reviewPending: false,
    };
  }

  if (confidence === 'low') {
    return {
      status: 'reviewing',
      dueAt: dueInDays(3),
      reviewPending: true,
    };
  }

  if (confidence === 'medium') {
    return {
      status: 'reviewing',
      dueAt: dueInDays(7),
      reviewPending: true,
    };
  }

  // A confident correct answer counts toward first-pass coverage without
  // competing with untouched questions in the review queue.
  return {
    status: 'reviewing',
    dueAt: null,
    reviewPending: false,
  };
}
