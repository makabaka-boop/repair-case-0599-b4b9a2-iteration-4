"""复制批次放行单的离线一致性复核。

本模块只回答两件不同的事：

1. **内容是否自洽**：单据内嵌的两组 Lab 原值、逐字符标签原文、编号、生成时间、
   结构化判定/批次字段与正文，能否由当前 CIEDE2000、GS1 与放行单格式重新算出；
2. **签发来源是否真实**：当前系统只认可带服务端密码学签名的新单据。旧单没有
   签名时只能得到“内容自洽/不自洽”，绝不能被称为“已鉴真”。

复核不重新签发，也不生成新编号/新时间；成功响应固定在本次导入的文档快照上。
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any

from .ciede2000 import CIELab, ciede2000
from .gs1 import Gs1ParseError, parse_gs1_label
from .judge import judge
from .release import LabSnapshot, build_release_text

ID_PATTERN = re.compile(r"^REL-(\d{8})T(\d{6})Z-[0-9a-f]{8}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
MAX_LABEL_LENGTH = 512
MAX_TEXT_LENGTH = 10_000

RESULT_KEYS = {
    "delta_e00",
    "delta_e00_round",
    "threshold",
    "passed",
    "relation",
    "excess_raw",
    "excess_round",
}
BATCH_KEYS = {"gtin", "lot", "expires"}
LAB_KEYS = {"L", "a", "b"}
DOCUMENT_KEYS = {
    "id",
    "generated_at",
    "standard",
    "sample",
    "result",
    "batch",
    "label_raw",
    "text",
}


class ReviewImportError(ValueError):
    """结构化单据未通过导入模式校验；应整次返回 422，不保留复核结果。"""

    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("放行单结构无效")
        self.errors = errors


def _error(field: str, message: str, type_: str = "value_error") -> dict[str, str]:
    return {"field": field, "message": message, "type": type_}


def _is_number(value: Any) -> bool:
    # bool 是 int 的子类，但 JSON true/false 不是 Lab 或 ΔE 数值。
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _require_object(
    value: Any, path: str, errors: list[dict[str, str]], *, exact_keys: set[str]
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(_error(path, "必须是对象", "type_error"))
        return None
    keys = set(value)
    missing = exact_keys - keys
    for key in sorted(missing):
        errors.append(_error(f"{path}.{key}" if path else key, "字段缺失", "missing"))
    for key in sorted(keys - exact_keys):
        errors.append(
            _error(f"{path}.{key}" if path else key, "存在未声明字段", "extra_forbidden")
        )
    return value if not missing and not (keys - exact_keys) else None


def _require_lab(
    value: Any, path: str, errors: list[dict[str, str]]
) -> dict[str, float] | None:
    obj = _require_object(value, path, errors, exact_keys=LAB_KEYS)
    if obj is None:
        return None
    valid = True
    bounds = {"L": (0.0, 100.0), "a": (-128.0, 127.0), "b": (-128.0, 127.0)}
    for key in ("L", "a", "b"):
        item = obj[key]
        field = f"{path}.{key}"
        if not _is_number(item):
            errors.append(_error(field, "必须是 JSON 数值", "type_error"))
            valid = False
            continue
        if not math.isfinite(item):
            errors.append(_error(field, "必须是有限数值", "non_finite"))
            valid = False
            continue
        low, high = bounds[key]
        if not low <= item <= high:
            errors.append(_error(field, f"超出允许范围 [{low:g}, {high:g}]", "value_error"))
            valid = False
    return {key: float(obj[key]) for key in ("L", "a", "b")} if valid else None


def _validate_import(document: Any) -> dict[str, Any]:
    """严格校验导入 JSON 的必要字段与类型；任何错误都整次拒绝（422）。"""
    errors: list[dict[str, str]] = []
    root = _require_object(document, "", errors, exact_keys=DOCUMENT_KEYS)
    if root is None:
        raise ReviewImportError(errors)

    for key in ("id", "generated_at", "label_raw", "text"):
        if not isinstance(root[key], str):
            errors.append(_error(key, "必须是字符串", "type_error"))

    standard = _require_lab(root["standard"], "standard", errors)
    sample = _require_lab(root["sample"], "sample", errors)
    result_obj = _require_object(root["result"], "result", errors, exact_keys=RESULT_KEYS)
    batch_obj = _require_object(root["batch"], "batch", errors, exact_keys=BATCH_KEYS)

    if result_obj is not None:
        for key in RESULT_KEYS - {"passed", "relation"}:
            if not _is_number(result_obj[key]):
                errors.append(_error(f"result.{key}", "必须是 JSON 数值", "type_error"))
            elif not math.isfinite(result_obj[key]):
                errors.append(_error(f"result.{key}", "必须是有限数值", "non_finite"))
        relation = result_obj["relation"]
        if not isinstance(relation, str) or relation not in {"<=", ">"}:
            errors.append(_error("result.relation", '必须是字符串 "<=" 或 ">"', "type_error"))
        if not isinstance(result_obj["passed"], bool):
            errors.append(_error("result.passed", "必须是布尔值", "type_error"))

    if batch_obj is not None:
        for key in BATCH_KEYS:
            if not isinstance(batch_obj[key], str):
                errors.append(_error(f"batch.{key}", "必须是字符串", "type_error"))

    if isinstance(root["label_raw"], str):
        if not root["label_raw"]:
            errors.append(_error("label_raw", "标签原文不能为空", "value_error"))
        elif len(root["label_raw"]) > MAX_LABEL_LENGTH:
            errors.append(_error("label_raw", "标签原文超过 512 个字符", "value_error"))

    if isinstance(root["text"], str) and len(root["text"]) > MAX_TEXT_LENGTH:
        errors.append(_error("text", "正文超过 10000 个字符", "value_error"))

    if errors or standard is None or sample is None:
        raise ReviewImportError(errors)

    return root


def _mismatch(
    section: str,
    field: str,
    message: str,
    *,
    expected: Any = None,
    actual: Any = None,
    line: int | None = None,
    column: int | None = None,
    position: int | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "section": section,
        "field": field,
        "message": message,
        "expected": expected,
        "actual": actual,
        "line": line,
        "column": column,
        "position": position,
    }
    return item


def _timestamp_matches_id(doc_id: str, generated_at: str) -> bool:
    return _timestamp_from_id(doc_id) == generated_at


def _timestamp_from_id(doc_id: str) -> str | None:
    match = ID_PATTERN.match(doc_id)
    if match is None:
        return None
    date_part, time_part = match.groups()
    return (
        f"{date_part[0:4]}-{date_part[4:6]}-{date_part[6:8]}T"
        f"{time_part[0:2]}:{time_part[2:4]}:{time_part[4:6]}Z"
    )


def _is_valid_utc_timestamp(value: str) -> bool:
    if not TIMESTAMP_PATTERN.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


def _line_mismatches(actual_text: str, expected_text: str) -> list[dict[str, Any]]:
    """逐行、逐字符定位正文差异；同时识别整行缺失/多余。"""
    actual_lines = actual_text.split("\n")
    expected_lines = expected_text.split("\n")
    mismatches: list[dict[str, Any]] = []
    max_len = max(len(actual_lines), len(expected_lines))
    for index in range(max_len):
        line_no = index + 1
        if index >= len(actual_lines):
            mismatches.append(
                _mismatch(
                    "text",
                    f"text.lines[{line_no}]",
                    "正文缺少复算得到的行",
                    expected=expected_lines[index],
                    actual=None,
                    line=line_no,
                )
            )
            continue
        if index >= len(expected_lines):
            mismatches.append(
                _mismatch(
                    "text",
                    f"text.lines[{line_no}]",
                    "正文存在不应有的额外行",
                    expected=None,
                    actual=actual_lines[index],
                    line=line_no,
                )
            )
            continue
        if actual_lines[index] == expected_lines[index]:
            continue
        actual_line = actual_lines[index]
        expected_line = expected_lines[index]
        column = next(
            (
                pos + 1
                for pos in range(min(len(actual_line), len(expected_line)))
                if actual_line[pos] != expected_line[pos]
            ),
            min(len(actual_line), len(expected_line)) + 1,
        )
        mismatches.append(
            _mismatch(
                "text",
                f"text.lines[{line_no}]",
                f"正文第 {line_no} 行与按单据复算重建的内容不一致（首个差异列 {column}）",
                expected=expected_line,
                actual=actual_line,
                line=line_no,
                column=column,
            )
        )
    return mismatches


def _add_result_mismatches(
    mismatches: list[dict[str, Any]],
    claimed: dict[str, Any],
    recomputed: dict[str, Any],
) -> None:
    for key in (
        "delta_e00",
        "delta_e00_round",
        "threshold",
        "passed",
        "excess_raw",
        "excess_round",
        "relation",
    ):
        if claimed[key] != recomputed[key]:
            mismatches.append(
                _mismatch(
                    "color",
                    f"result.{key}",
                    "内嵌色差判定字段与由两组 Lab 原值复算的结果不一致",
                    expected=recomputed[key],
                    actual=claimed[key],
                )
            )


def review_release_document(document: Any) -> dict[str, Any]:
    """复核已导入的结构化放行单，返回本次快照的自洽性结论。"""
    doc = _validate_import(document)

    standard = LabSnapshot(
        float(doc["standard"]["L"]),
        float(doc["standard"]["a"]),
        float(doc["standard"]["b"]),
    )
    sample = LabSnapshot(
        float(doc["sample"]["L"]),
        float(doc["sample"]["a"]),
        float(doc["sample"]["b"]),
    )
    label_raw: str = doc["label_raw"]
    claimed_result = doc["result"]
    claimed_batch = doc["batch"]
    doc_id: str = doc["id"]
    generated_at: str = doc["generated_at"]
    claimed_text: str = doc["text"]

    mismatches: list[dict[str, Any]] = []

    if not ID_PATTERN.match(doc_id):
        mismatches.append(
            _mismatch(
                "metadata",
                "id",
                "放行单编号不符合 REL-YYYYMMDDTHHMMSSZ-8位十六进制 格式",
                expected="REL-YYYYMMDDTHHMMSSZ-xxxxxxxx",
                actual=doc_id,
            )
        )
    if not _is_valid_utc_timestamp(generated_at):
        mismatches.append(
            _mismatch(
                "metadata",
                "generated_at",
                "生成时间不是秒精度 UTC ISO-8601 字符串（Z 后缀）",
                expected="YYYY-MM-DDTHH:MM:SSZ",
                actual=generated_at,
            )
        )
    elif ID_PATTERN.match(doc_id) and not _timestamp_matches_id(doc_id, generated_at):
        mismatches.append(
            _mismatch(
                "metadata",
                "generated_at",
                "生成时间与放行单编号内嵌的 UTC 时间不一致",
                expected=_timestamp_from_id(doc_id),
                actual=generated_at,
            )
        )

    verdict = judge(
        ciede2000(
            CIELab(standard.L, standard.a, standard.b),
            CIELab(sample.L, sample.a, sample.b),
        )
    )
    color_passed = bool(verdict["passed"])
    _add_result_mismatches(mismatches, claimed_result, verdict)

    try:
        parsed = parse_gs1_label(label_raw)
        label_passed = True
        label_error = None
    except Gs1ParseError as exc:
        parsed = None
        label_passed = False
        label_error = {
            "code": exc.code,
            "message": f"标签解析失败：{exc.message}",
            "position": exc.position,
        }
        mismatches.append(
            _mismatch(
                "label",
                "label_raw",
                "逐字符标签原文无法通过现有 GS1 解析规则",
                expected="包含 AI 01/10/17 且校验位、日期均有效的标签原文",
                actual=label_raw,
                position=exc.position,
            )
        )

    if label_passed and parsed is not None:
        recomputed_batch = parsed["batch"]
        assert isinstance(recomputed_batch, dict)
        for key in ("gtin", "lot", "expires"):
            if claimed_batch[key] != recomputed_batch[key]:
                mismatches.append(
                    _mismatch(
                        "label",
                        f"batch.{key}",
                        "内嵌批次字段与由标签原文重新解析的结果不一致",
                        expected=recomputed_batch[key],
                        actual=claimed_batch[key],
                    )
                )

    recomputed_text = None
    if color_passed and label_passed and parsed is not None:
        recomputed_text = build_release_text(
            standard, sample, label_raw, parsed, verdict, doc_id, generated_at
        )
        mismatches.extend(_line_mismatches(claimed_text, recomputed_text))
    else:
        mismatches.append(
            _mismatch(
                "release",
                "document",
                "导入内容是一张放行单，但按内嵌原值复算时色差或标签未通过；有效放行单不应存在",
                expected={"color_check.passed": True, "label_check.passed": True},
                actual={"color_check.passed": color_passed, "label_check.passed": label_passed},
            )
        )

    content_consistent = not mismatches
    # 当前接口不接收也不验证任何密码学签名；旧单最多证明其自身内容自洽。
    authenticated = False
    if content_consistent:
        authenticity_status = "content_consistent_unsigned"
        authenticity_message = "内容自洽，但本单无服务端签名：未鉴真，不得据此认定签发来源真实。"
    else:
        authenticity_status = "inconsistent_unsigned"
        authenticity_message = "内容不自洽，且本单无服务端签名：未鉴真。"

    return {
        "ok": True,
        "review_scope": "content_consistency_only",
        "authenticated": authenticated,
        "authenticity_status": authenticity_status,
        "authenticity_message": authenticity_message,
        "content_consistent": content_consistent,
        "mismatch_count": len(mismatches),
        "mismatches": mismatches,
        "recalculated": {
            "color_check": {"passed": color_passed, "result": verdict},
            "label_check": (
                {"passed": True, "parsed": parsed}
                if label_passed
                else {"passed": False, "error": label_error}
            ),
            "release": {
                "id": doc_id,
                "generated_at": generated_at,
                "standard": standard.as_dict(),
                "sample": sample.as_dict(),
                "result": verdict,
                "batch": parsed["batch"] if parsed is not None else None,
                "label_raw": label_raw,
                "text": recomputed_text,
            },
        },
        "imported_snapshot": doc,
    }
