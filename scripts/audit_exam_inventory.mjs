import { readFileSync, writeFileSync } from 'node:fs';
import { buildQuestionIndex, isUsable } from '../study-queues.mjs';
import { flattenCases, trainingCategory } from '../exam-engine.mjs';
const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url)));
const original = read('questions.json');
const cases = read('case-exercises.json');
const imported = read('import_report.json');
const duplicates = read('duplicate_report.json');
const questions = [...original, ...flattenCases(cases)];
const index = buildQuestionIndex(original);
const count = (items, key) => items.reduce((result, q) => { const label = key(q); result[label] = (result[label] || 0) + 1; return result; }, {});
const report = {
  auditedAt: '2026-11-03', originalParsed: original.length,
  originalByType: count(original, (q) => q.type),
  originalBlocked: original.filter((q) => !isUsable(q)).length,
  originalDuplicateCopies: original.filter(isUsable).length - index.groups.length,
  originalSameStemGroups: index.repeatedStems.length,
  originalSameStemVariants: duplicates.same_stem_variants.length,
  missingNumberLabels: Object.fromEntries(Object.entries(imported.sources).map(([file, source]) => [file, source.missing_number_labels])),
  crossPageAnomalyCount: null,
  crossPageNote: '原导入报告未单独记录跨页异常计数，本次不重解析PDF；逐题结构异常4道继续隔离，未据此假定跨页异常为0。',
  originalHasIndependentCaseGroups: false,
  trainingTopicDistribution: count(questions.filter(isUsable), (q) => `${trainingCategory(q).subject}/${trainingCategory(q).topic}`),
  topicCaveat: '原PDF无官方知识点/科目标签；原题按关键词粗分，仅为训练参考，不是已核验的知识点分布。案例考点为自编标签。',
  authoredCaseGroups: cases.cases.length, authoredByType: count(flattenCases(cases), (q) => `${q.subject}/${q.type}`),
  importReport: 'import_report.json', duplicateReport: 'duplicate_report.json',
};
writeFileSync(new URL('../data/exam-inventory.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
