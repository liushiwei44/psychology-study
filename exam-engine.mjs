import { questionId, isUsable } from './study-queues.mjs?v=20261109a';

export const CASE_SOURCE = '自编案例训练（非官方真题）';
export const PRACTICE_TYPES = ['single', 'multiple', 'case_single', 'case_multiple', 'judgment'];

export function flattenCases(bank) {
  return bank.cases.flatMap((item) => item.questions.map((q) => ({
    ...q, source_file: CASE_SOURCE, source_question_no: q.id,
    case_id: item.id, case_title: item.title, case_material: item.material,
    subject: item.subject, topic: item.topic, provenance: bank.provenance,
    parse_warnings: [],
  })));
}

export function selectSpecialtyQuestions(index, getAttempt, type, target = 50, scope = 'new') {
  const groups = index.groups.filter((g) => g[0].type === type);
  const limit = scope === 'new' ? target : Math.min(10, target);
  const candidates = groups.filter((g) => scope === 'new'
    ? !g.some((q) => getAttempt(q).attempts > 0)
    : g.some((q) => getAttempt(q).attempts > 0))
    .map((g) => scope === 'new' ? g[0] : g.find((q) => getAttempt(q).attempts > 0));
  if (scope !== 'new') candidates.sort((a, b) => {
    const time = (q) => new Date(getAttempt(q).updatedAt || getAttempt(q).history?.at(-1)?.at || 0).getTime();
    return time(a) - time(b);
  });
  return candidates.slice(0, limit).map(questionId);
}

export function scoreAnswer(q, selected, rule = 'exact', points = 1) {
  const keys = new Set(selected);
  const answer = q.type === 'judgment' ? [q.answer] : [...String(q.answer)];
  const exact = keys.size === answer.length && answer.every((key) => keys.has(key));
  if (exact) return { correct: true, score: points };
  const subset = keys.size > 0 && [...keys].every((key) => answer.includes(key));
  return { correct: false, score: rule === 'multiple-partial' && subset ? 0.5 : 0 };
}

// Original PDFs have no official subject/topic tags. This only classifies training pools.
export function trainingCategory(q) {
  if (q.subject) return { subject: q.subject, topic: q.topic };
  const text = `${q.stem} ${q.options.map((o) => o.text).join(' ')}`;
  const topics = [
    ['咨询伦理', /保密|伦理|转介|知情同意|多重关系|专业边界|督导/],
    ['咨询技能', /咨询师|咨询关系|来访者|求助者|共情|摄入性|倾听|面质|参与性技术|影响性技术|咨询目标|咨询方案/],
    ['咨询方法', /疗法|认知重构|自动化思维|系统脱敏|暴露|空椅|自由联想|合理情绪|焦点解决|家庭作业/],
    ['心理评估', /测验|量表|常模|效度|信度|SCL|SDS|SAS|MMPI|EPQ|16PF|PHQ|GAD|评估报告/],
  ];
  for (const [topic, pattern] of topics) if (pattern.test(text)) return { subject: '专业技能', topic };
  const basic = [
    ['发展心理', /婴儿|幼儿|儿童|青春|青少年|老年|发展阶段|依恋|皮亚杰|埃里克森/],
    ['社会心理', /社会心理|归因|从众|服从|社会促进|群体|刻板印象|人际|态度/],
    ['心理健康与异常', /障碍|抑郁|焦虑|精神分裂|神经症|心理问题|应激|心理健康/],
    ['人格心理', /人格|气质|性格|大五/],
  ];
  return { subject: '基础知识', topic: basic.find(([, pattern]) => pattern.test(text))?.[0] || '基础心理' };
}

function shuffled(items, seed) {
  const result = items.slice();
  let n = seed >>> 0;
  for (let i = result.length - 1; i > 0; i -= 1) {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    const j = n % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function buildExamPaper(index, template, setNumber) {
  const conflicts = new Set(index.conflicts.flatMap((g) => g.map(questionId)));
  const unique = index.groups.map((g) => g[0]).filter((q) => isUsable(q) && !conflicts.has(questionId(q)));
  const entries = [];
  for (const [sectionIndex, section] of template.sections.entries()) {
    const pool = unique.filter((q) => q.type === section.type && trainingCategory(q).subject === template.subject);
    if (pool.length < section.count) throw new Error(`${template.subject}的${section.label}只有 ${pool.length} 题，需要 ${section.count} 题；停止组卷，未用其他题型替代。`);
    const ordered = shuffled(pool, template.seed + sectionIndex * 71);
    const offset = (setNumber - 1) * section.count;
    const chosen = Array.from({ length: section.count }, (_, i) => ordered[(offset + i) % ordered.length]);
    // Keep questions about the same material together for reading.
    if (section.type.startsWith('case_')) chosen.sort((a, b) => a.case_id.localeCompare(b.case_id) || String(a.source_question_no).localeCompare(String(b.source_question_no)));
    entries.push(...chosen.map((q) => ({ id: questionId(q), section: section.label, type: section.type, points: section.points, rule: section.rule })));
  }
  return { id: `${template.id}-${setNumber}`, title: `${template.subject} · 训练卷 ${setNumber}`, setNumber, templateId: template.id, entries };
}

export function gradeExam(entries, questions, answers) {
  const byId = new Map(questions.map((q) => [questionId(q), q]));
  const rows = entries.map((entry) => {
    const q = byId.get(entry.id);
    const answer = answers[entry.id];
    return { ...entry, answer: answer?.selected || [], confidence: answer?.confidence || 'high',
      answered: Boolean(answer?.selected?.length), ...scoreAnswer(q, answer?.selected || [], entry.rule, entry.points),
      topic: trainingCategory(q).topic };
  });
  const aggregate = (key) => [...new Set(rows.map((row) => row[key]))].map((label) => {
    const list = rows.filter((row) => row[key] === label);
    return { label, total: list.length, correct: list.filter((r) => r.correct).length,
      score: list.reduce((s, r) => s + r.score, 0), maxScore: list.reduce((s, r) => s + r.points, 0) };
  });
  return { rows, score: rows.reduce((s, r) => s + r.score, 0), total: rows.length,
    correct: rows.filter((r) => r.correct).length, unanswered: rows.filter((r) => !r.answered).length,
    sections: aggregate('section'), topics: aggregate('topic') };
}
