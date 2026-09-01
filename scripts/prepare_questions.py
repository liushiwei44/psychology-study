#!/usr/bin/env python3
"""Extract the Psychology-test PDFs into a local JSON question bank.

The source PDFs are intentionally left untouched. This importer keeps source
file/question numbers and writes a parse report so malformed or missing items
can be reviewed before they are used in exam simulations.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import pdfplumber


QUESTION_START = re.compile(
    r"^\s*(\d+)\s*[\.、．]\s*(.*)$"
)
# One source line (multiple-choice 3831) omits punctuation after its number.
# Do not accept every bare `number + space` line: PDF line wrapping also
# produces fragments such as "2 分钟" and "6 个月" inside a question.
QUESTION_START_BARE = re.compile(
    r"^\s*(\d{3,})\s+(?=[\u3400-\u9fff“「《（(])(.*)$"
)
OPTION_START = re.compile(r"^\s*([ABCD])\s*[\.、]\s*(.*)$")
ANSWER_LINE = re.compile(r"答案\s*[：:]\s*([A-D]+|正确|错误)")
EXPLANATION_LINE = re.compile(r"解\s*析\s*[：:、，,]\s*(.*)")
PAGE_MARKER = re.compile(r"^===== PAGE \d+ =====$")


def extract_lines(path: Path) -> list[str]:
    lines: list[str] = []
    with pdfplumber.open(path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
            lines.append(f"===== PAGE {page_number} =====")
            lines.extend(text.splitlines())
    return lines


def clean_piece(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = value.replace("\u00a0", " ")
    value = re.sub(r"\s+", " ", value).strip()
    # pdfplumber may insert line-wrap spaces inside Chinese words.
    value = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", value)
    value = re.sub(r"\s+([，。！？；：、）】》])", r"\1", value)
    value = re.sub(r"([（【《])\s+", r"\1", value)
    return value


def normalize_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = re.sub(r"\s+", "", value)
    value = re.sub(r"[（）()]", "", value)
    return value.strip("。？? ")


def normalize_answer(value: str) -> list[str]:
    """Return answer option keys in source order, without duplicate letters."""
    normalized = unicodedata.normalize("NFKC", value).upper()
    if normalized in {"正确", "错误"}:
        return [normalized]
    return list(dict.fromkeys(re.findall(r"[A-D]", normalized)))


def question_start_match(line: str):
    match = QUESTION_START.match(line)
    if match:
        return match
    return QUESTION_START_BARE.match(line)


def split_question_blocks(lines: list[str]) -> list[tuple[int, int, list[str]]]:
    starts: list[tuple[int, int]] = []
    for index, line in enumerate(lines):
        match = question_start_match(line)
        if match and int(match.group(1)) > 0:
            starts.append((index, int(match.group(1))))

    blocks: list[tuple[int, int, list[str]]] = []
    for position, (start, number) in enumerate(starts):
        end = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        blocks.append((number, start, lines[start:end]))
    return blocks


def parse_block(number: int, raw_lines: list[str], source_file: str, question_type: str) -> dict:
    lines = [line.strip() for line in raw_lines if not PAGE_MARKER.match(line.strip())]
    if not lines:
        return {
            "source_file": source_file,
            "source_question_no": number,
            "type": question_type,
            "stem": "",
            "options": [],
            "answer": "",
            "explanation": "",
            "parse_warnings": ["empty_block"],
        }

    first_match = question_start_match(lines[0])
    first_text = first_match.group(2) if first_match else lines[0]
    content_lines = [first_text, *lines[1:]]

    answer = ""
    answer_index = None
    explanation_index = None
    explanation_parts: list[str] = []
    for index, line in enumerate(content_lines):
        answer_match = ANSWER_LINE.search(line)
        if answer_match and not answer:
            answer = answer_match.group(1)
            answer_index = index
        explanation_match = EXPLANATION_LINE.search(line)
        if explanation_match and explanation_index is None:
            explanation_index = index
            explanation_parts.append(explanation_match.group(1))
        elif explanation_index is not None and index > explanation_index:
            explanation_parts.append(line)

    option_entries: list[tuple[str, str]] = []
    current_option: str | None = None
    current_text: list[str] = []
    for line in content_lines:
        option_match = OPTION_START.match(line)
        if option_match:
            if current_option is not None:
                option_entries.append((current_option, clean_piece(" ".join(current_text))))
            current_option = option_match.group(1)
            current_text = [option_match.group(2)]
            continue
        if current_option is not None:
            if ANSWER_LINE.search(line) or EXPLANATION_LINE.search(line):
                option_entries.append((current_option, clean_piece(" ".join(current_text))))
                current_option = None
                current_text = []
            else:
                current_text.append(line)
    if current_option is not None:
        option_entries.append((current_option, clean_piece(" ".join(current_text))))

    stem_end_candidates = [len(content_lines)]
    option_indexes = [
        index for index, line in enumerate(content_lines) if OPTION_START.match(line)
    ]
    if option_indexes:
        stem_end_candidates.append(min(option_indexes))
    if question_type == "judgment":
        judgment_indexes = [
            index for index, line in enumerate(content_lines) if clean_piece(line) in {"正确", "错误"}
        ]
        if judgment_indexes:
            stem_end_candidates.append(min(judgment_indexes))
    if answer_index is not None:
        stem_end_candidates.append(answer_index)
    if explanation_index is not None:
        stem_end_candidates.append(explanation_index)
    stem_end = min(stem_end_candidates)
    stem = clean_piece(" ".join(content_lines[:stem_end]))

    if question_type == "judgment":
        options = [{"key": "正确", "text": "正确"}, {"key": "错误", "text": "错误"}]
    else:
        options = [{"key": key, "text": text} for key, text in option_entries]

    warnings: list[str] = []
    if not stem:
        warnings.append("missing_stem")
    if question_type != "judgment":
        if len(options) < 2:
            warnings.append("too_few_options")
        if len(options) != 4:
            warnings.append("option_count_not_4")
        option_keys = [item["key"] for item in options]
        if len(set(option_keys)) != len(option_keys):
            warnings.append("duplicate_option_key")
        if answer and any(key not in option_keys for key in normalize_answer(answer)):
            warnings.append("answer_refers_to_missing_option")
    if not answer:
        warnings.append("missing_answer")
    if explanation_index is None:
        warnings.append("missing_explanation")

    return {
        "source_file": source_file,
        "source_question_no": number,
        "type": question_type,
        "stem": stem,
        "options": options,
        "answer": answer,
        "explanation": clean_piece(" ".join(explanation_parts)),
        "parse_warnings": warnings,
    }


def parse_pdf(path: Path, question_type: str) -> list[dict]:
    lines = extract_lines(path)
    blocks = split_question_blocks(lines)
    parsed: list[dict] = []
    for number, _, raw in blocks:
        resolved_type = question_type
        if question_type == "mixed_single_judgment":
            resolved_type = "judgment" if number >= 4001 else "single"
        parsed.append(parse_block(number, raw, path.name, resolved_type))
    return parsed


def add_duplicate_metadata(questions: list[dict]) -> None:
    groups: dict[str, list[dict]] = defaultdict(list)
    for question in questions:
        key = normalize_key(question["stem"])
        if key:
            groups[key].append(question)
    duplicate_group = 0
    for key, group in groups.items():
        if len(group) < 2:
            continue
        duplicate_group += 1
        for question in group:
            question["duplicate_group"] = duplicate_group
            question["duplicate_group_size"] = len(group)


def build_report(questions: list[dict], expected_ranges: dict[str, tuple[int, int]]) -> dict:
    by_source = defaultdict(list)
    for question in questions:
        by_source[question["source_file"]].append(question)

    hard_warning_names = {
        "missing_stem",
        "missing_answer",
        "too_few_options",
        "option_count_not_4",
        "duplicate_option_key",
        "answer_refers_to_missing_option",
    }
    report = {"total_parsed": len(questions), "sources": {}, "quality_issues": []}
    for source, items in by_source.items():
        numbers = {item["source_question_no"] for item in items}
        expected_start, expected_end = expected_ranges[source]
        missing = [n for n in range(expected_start, expected_end + 1) if n not in numbers]
        warning_counts = Counter(
            warning for item in items for warning in item.get("parse_warnings", [])
        )
        type_counts = Counter(item["type"] for item in items)
        report["sources"][source] = {
            "parsed": len(items),
            "number_min": min(numbers) if numbers else None,
            "number_max": max(numbers) if numbers else None,
            "missing_number_labels": missing,
            "type_counts": dict(type_counts),
            "warning_counts": dict(warning_counts),
        }
        for item in items:
            hard_warnings = [
                warning
                for warning in item.get("parse_warnings", [])
                if warning in hard_warning_names
            ]
            if hard_warnings:
                report["quality_issues"].append(
                    {
                        "source_file": source,
                        "source_question_no": item["source_question_no"],
                        "type": item["type"],
                        "warnings": hard_warnings,
                        "stem": item["stem"],
                    }
                )
    report["quality_issue_count"] = len(report["quality_issues"])
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    root = args.root
    output = args.output or root / "data" / "questions.json"
    report_path = output.with_name("import_report.json")
    output.parent.mkdir(parents=True, exist_ok=True)

    single_path = root / "最新版【单选题+判断题】.pdf"
    multi_path = root / "最新版【多选题】.pdf"
    single_questions = parse_pdf(single_path, "mixed_single_judgment")
    multi_questions = parse_pdf(multi_path, "multiple")
    questions = single_questions + multi_questions
    add_duplicate_metadata(questions)

    with output.open("w", encoding="utf-8") as stream:
        json.dump(questions, stream, ensure_ascii=False, separators=(",", ":"))

    report = build_report(
        questions,
        {
            single_path.name: (1, 5500),
            multi_path.name: (1, 4000),
        },
    )
    report["notes"] = [
        "Number ranges are expected labels, not guaranteed actual question counts; this import contains 9488 parsed blocks.",
        "Judgment questions are retained for concept practice and are excluded from the current official simulation template by default.",
        "Questions with hard structural warnings are retained in the JSON/report for audit but should not enter practice or mock queues until manually verified.",
        "Topic tags and case-analysis questions are intentionally left for the next enrichment pass.",
    ]
    with report_path.open("w", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
