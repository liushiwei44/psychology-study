import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildQuestionIndex, questionId } from '../study-queues.mjs';

const input = new URL('../data/questions.json', import.meta.url);
const raw = readFileSync(input);
const questions = JSON.parse(raw);
const index = buildQuestionIndex(questions);
const describe = (q) => ({ id: questionId(q), type: q.type, stem: q.stem, options: q.options, answer: q.answer });
const report = {
  bank_sha256: createHash('sha256').update(raw).digest('hex'),
  policy: '仅在题型、规范化题干、选项内容、正确答案内容全部一致时过滤重复副本；忽略不影响意义的排版及选项顺序。选项引用字母或以上/上述/下述时保留顺序。相同题干但选项不同、答案冲突的题保留待核对。题库和所有历史题号不修改。',
  counts: Object.fromEntries(['single', 'multiple', 'judgment'].map((type) => {
    const groups = index.groups.filter((g) => g[0].type === type);
    const usable = groups.reduce((sum, g) => sum + g.length, 0);
    return [type, { parsed: questions.filter((q) => q.type === type).length, usable, unique: groups.length, filtered: usable - groups.length }];
  })),
  duplicate_groups: index.groups.filter((g) => g.length > 1).map((g) => g.map(describe)),
  answer_conflicts: index.conflicts.map((g) => g.map(describe)),
  same_stem_variants: index.repeatedStems.filter((g) => new Set(g.map((q) => index.groupById.get(questionId(q)))).size > 1).map((g) => g.map(describe)),
};
writeFileSync(new URL('../data/duplicate_report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ counts: report.counts, duplicate_groups: report.duplicate_groups.length, answer_conflicts: report.answer_conflicts.length, same_stem_variants: report.same_stem_variants.length }, null, 2));
