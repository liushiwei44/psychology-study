import { hasConfidenceReviewPending, isWrongBookAttempt } from './study-rules.mjs';

export const REVIEW_LIMIT = 10;
const HARD_WARNINGS = new Set([
  'missing_stem', 'missing_answer', 'too_few_options', 'option_count_not_4',
  'duplicate_option_key', 'answer_refers_to_missing_option',
]);

export function questionId(q) {
  return `${q.source_file}::${q.source_question_no}`;
}

export function isUsable(q) {
  return !(q.parse_warnings || []).some((warning) => HARD_WARNINGS.has(warning));
}

export function normalizeDuplicateText(value = '') {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/\s*([,;:!?()])\s*/g, '$1').replace(/[。?？]+$/, '');
}

function signatures(q) {
  const stem = normalizeDuplicateText(`${q.case_material || ''} ${q.stem}`);
  // Labels/order can carry meaning in “A 和 B” / “以上各项” options.
  const orderMatters = [q.stem, ...q.options.map((o) => o.text)]
    .some((text) => /以上|上述|下述|[A-DＡ-Ｄ]/.test(text));
  const options = q.options.map((o) => [o.key, normalizeDuplicateText(o.text)]);
  const contents = options.map(([key, text]) => orderMatters ? [key, text] : text);
  const answerKeys = new Set(String(q.answer).match(/[A-D]/g) || []);
  const answers = q.type === 'judgment' ? q.answer : options
    .filter(([key]) => answerKeys.has(key))
    .map(([key, text]) => orderMatters ? [key, text] : text).sort();
  return {
    stem: JSON.stringify([q.type, stem]),
    content: JSON.stringify([q.type, stem, contents.sort()]),
    answer: JSON.stringify(answers),
  };
}

// This is a queue index only. Never rewrite question IDs or progress records.
export function buildQuestionIndex(questions) {
  const buckets = new Map();
  const stems = new Map();
  for (const q of questions.filter(isUsable)) {
    const sig = signatures(q);
    if (!buckets.has(sig.content)) buckets.set(sig.content, []);
    buckets.get(sig.content).push({ q, answer: sig.answer });
    if (!stems.has(sig.stem)) stems.set(sig.stem, []);
    stems.get(sig.stem).push(q);
  }
  const groups = [];
  const conflicts = [];
  for (const bucket of buckets.values()) {
    const members = bucket.map(({ q }) => q);
    if (new Set(bucket.map(({ answer }) => answer)).size > 1) {
      conflicts.push(members);
      groups.push(...members.map((q) => [q]));
    } else groups.push(members);
  }
  const position = new Map(questions.map((q, i) => [q, i]));
  groups.sort((a, b) => position.get(a[0]) - position.get(b[0]));
  const groupById = new Map();
  for (const group of groups) for (const q of group) groupById.set(questionId(q), group);
  return { groups, groupById, conflicts, repeatedStems: [...stems.values()].filter((g) => g.length > 1) };
}

export function isDueForReview(attempt, nowMs = Date.now()) {
  if (attempt.status === 'mastered') return false;
  const lastCorrect = attempt.lastCorrect ?? attempt.history?.at(-1)?.correct;
  // A confident wrong answer still needs review; a corrected one can wait.
  if (lastCorrect === true && attempt.confidence === 'high') return false;
  return (isWrongBookAttempt(attempt) || hasConfidenceReviewPending(attempt))
    && (!attempt.dueAt || new Date(attempt.dueAt).getTime() <= nowMs);
}

export function reviewPriority(a, b) {
  const rank = (attempt) => isWrongBookAttempt(attempt) ? 0 : attempt.confidence === 'low' ? 1 : 2;
  return rank(a) - rank(b)
    || Number(b.wrong || 0) - Number(a.wrong || 0)
    || new Date(a.dueAt || 0).getTime() - new Date(b.dueAt || 0).getTime();
}

export function selectDueQuestions(questions, getAttempt, nowMs = Date.now()) {
  // Keep original IDs here, including every historically wrong duplicate.
  return questions.filter((q) => isUsable(q) && isDueForReview(getAttempt(q), nowMs))
    .sort((a, b) => reviewPriority(getAttempt(a), getAttempt(b)));
}

export function selectNewQuestions(index, getAttempt, excludedIds = []) {
  const excluded = new Set(excludedIds);
  return index.groups.filter((group) => ['single', 'multiple'].includes(group[0].type)
    && !group.some((q) => Number(getAttempt(q).attempts || 0) > 0 || excluded.has(questionId(q))))
    .map((group) => group[0]);
}

export function selectReviewRound(due, index, limit = REVIEW_LIMIT, excludedIds = []) {
  const groupKey = (q) => questionId(index.groupById.get(questionId(q))?.[0] || q);
  const excluded = new Set(excludedIds.map((id) => {
    const group = index.groupById.get(id);
    return group ? questionId(group[0]) : id;
  }));
  const selected = [];
  for (const q of due) {
    const key = groupKey(q);
    if (excluded.has(key)) continue;
    if (selected.length >= Math.min(REVIEW_LIMIT, limit)) break;
    excluded.add(key);
    selected.push(q);
  }
  return selected;
}

export function buildPracticeQueue({ index, getAttempt, due, todayIds = [], target = 50, reviewOnly = false }) {
  const limit = Math.max(1, Math.floor(Number(target) || 50));
  const review = selectReviewRound(due, index, limit, todayIds);
  const fresh = selectNewQuestions(index, getAttempt, todayIds);
  const questions = reviewOnly && review.length ? review : [...review, ...fresh].slice(0, limit);
  return questions.map(questionId);
}
