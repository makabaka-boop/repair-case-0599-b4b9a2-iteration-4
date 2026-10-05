"""放行单复核（交接班独立入口）。

接班调色员拿到的是一张**已经复制出来的**结构化批次放行单 JSON，本模块只回答
一个问题：单据内嵌的色差、标签批次与可读正文彼此是否**自洽**——即把内嵌的
两组 Lab 原值与逐字符标签原文当作原始输入，**重新走一遍**签发时的既有规则
（:mod:`app.ciede2000` / :mod:`app.judge` / :mod:`app.gs1` /
:func:`app.release.build_release_text`），再逐项与单据声称的结论、批次与正文比对。

两个结论必须严格区分：

* **内容自洽**（``content_self_consistent``）：单据内嵌原值的复算结果与单据自己
  声称的判定、解析批次、正文逐项一致。它只能证明“这张单子没有被改坏/误配”。
* **签发来源真实**（``source_authentic``）：需要服务端签名等签发凭据核验。本
  系统签发的放行单**不带任何签名**，因此本入口**永远**给出
  ``source_authentic = false`` 与固定措辞说明，自洽也不得冒称已鉴真。

结构层面的非法导入（缺失/类型错误/Lab 非有限或越界/标签原文空串/多余字段）
由端点的 Pydantic 模型整次拒绝（HTTP 422），**不产生复核结论**；进入本模块的
文档结构一定合法，所有“复算与声称不符”都以定位到字段的不一致明细（finding）
返回，HTTP 状态始终是 200。
"""

from __future__ import annotations

import re
from typing import Any

from .ciede2000 import CIELab, ciede2000
from .gs1 import Gs1ParseError, parse_gs1_label
from .judge import judge
from .release import LabSnapshot, build_release_text

# 放行单编号/时间格式：只做格式与相互一致性检查，不因此声称编号来自服务端
_ID_RE = re.compile(r"REL-\d{8}T\d{6}Z-[0-9a-f]{8}")
_TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")

# 复算浮点与单据内嵌值的比对容差：仅吸收 JSON 往返量级误差，篡改必被定位
_NUM_ABS_TOL = 1e-9
_NUM_REL_TOL = 1e-9

# 鉴真固定结论：系统从不在放行单上签名，任何复制件都无法凭内容证明来源
_SOURCE_MESSAGE = (
    "未鉴真：本系统放行单不含服务端签名，复制件无法证明签发来源；"
    "以下结论仅表示单据内嵌原值与自身声称内容是否自洽。"
)


def _mismatch(check: str, field: str, embedded: Any, recomputed: Any,
              message: str) -> dict[str, Any]:
    """一条定位到字段的不一致明细。"""
    return {
        "check": check,
        "field": field,
        "embedded": embedded,
        "recomputed": recomputed,
        "message": message,
    }


def _num_equal(a: float, b: float) -> bool:
    return abs(a - b) <= max(_NUM_ABS_TOL, _NUM_REL_TOL * max(abs(a), abs(b)))


def _check_meta(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """元数据检查：编号格式、时间格式、编号与时间相互一致。"""
    findings: list[dict[str, Any]] = []
    doc_id = doc["id"]
    generated_at = doc["generated_at"]
    if not _ID_RE.fullmatch(doc_id):
        findings.append(
            _mismatch(
                "meta", "id", doc_id, None,
                f"放行单编号不符合签发格式（REL-YYYYMMDDTHHMMSSZ-xxxxxxxx）：{doc_id!r}",
            )
        )
    if not _TIME_RE.fullmatch(generated_at):
        findings.append(
            _mismatch(
                "meta", "generated_at", generated_at, None,
                f"生成时间不符合 UTC ISO-8601（YYYY-MM-DDTHH:MM:SSZ）：{generated_at!r}",
            )
        )
    # 编号中段时间戳必须与生成时间逐位一致（自洽性，不是来源真实性）
    if _ID_RE.fullmatch(doc_id) and _TIME_RE.fullmatch(generated_at):
        id_ts = doc_id[len("REL-") : len("REL-") + 15]
        time_ts = (
            generated_at[0:4] + generated_at[5:7] + generated_at[8:10]
            + "T" + generated_at[11:13] + generated_at[14:16] + generated_at[17:19]
        )
        if id_ts != time_ts:
            findings.append(
                _mismatch(
                    "meta", "id/generated_at", doc_id, generated_at,
                    "编号内时间戳与生成时间不一致",
                )
            )
    return findings


# verdict 内嵌字段 → （人类可读名, 是否按浮点容差比对）
_VERDICT_FIELDS = (
    ("delta_e00", "未舍入 ΔE00", True),
    ("delta_e00_round", "两位小数 ΔE00", True),
    ("threshold", "阈值", True),
    ("passed", "放行判定", False),
    ("excess_raw", "未舍入超出量", True),
    ("excess_round", "两位小数超出量", True),
    ("relation", "阈值关系", False),
)


def _check_color(doc: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """色差复核：用内嵌两组 Lab 原值重走 CIEDE2000 + judge，逐项比对复算字段。

    返回 (不一致明细, 复算 verdict)。
    """
    findings: list[dict[str, Any]] = []
    standard = LabSnapshot(**doc["standard"])
    sample = LabSnapshot(**doc["sample"])
    verdict = judge(
        ciede2000(
            CIELab(standard.L, standard.a, standard.b),
            CIELab(sample.L, sample.a, sample.b),
        )
    )
    embedded_result = doc["result"]
    for key, label, numeric in _VERDICT_FIELDS:
        claimed = embedded_result[key]
        actual = verdict[key]
        equal = _num_equal(claimed, actual) if numeric else claimed == actual
        if not equal:
            findings.append(
                _mismatch(
                    "color",
                    f"result.{key}",
                    claimed,
                    actual,
                    f"内嵌 Lab 复算的{label}与单据声称不一致",
                )
            )
    return findings, verdict


def _check_label(
    doc: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, object] | None]:
    """标签复核：用逐字符标签原文重走 GS1 解析，比对格式与批次三字段。

    返回 (不一致明细, 解析结果或 None)。解析失败本身就是定位到标签的不一致：
    这张放行单声称自己由有效标签签发，内嵌原文却无法解析出同一批次。
    """
    label_raw: str = doc["label_raw"]
    try:
        parsed = parse_gs1_label(label_raw)
    except Gs1ParseError as exc:
        return [
            _mismatch(
                "label",
                "label_raw",
                label_raw,
                {"code": exc.code, "position": exc.position},
                f"内嵌标签原文重新解析失败（{exc.code}，位置 {exc.position}）：{exc.message}",
            )
        ], None

    findings: list[dict[str, Any]] = []
    embedded_batch = doc["batch"]
    actual_batch = parsed["batch"]
    assert isinstance(actual_batch, dict)
    for key in ("gtin", "lot", "expires"):
        if embedded_batch[key] != actual_batch[key]:
            findings.append(
                _mismatch(
                    "label",
                    f"batch.{key}",
                    embedded_batch[key],
                    actual_batch[key],
                    f"内嵌标签原文重新解析出的{key}与单据声称批次不一致",
                )
            )
    return findings, parsed


def _check_release_rule(
    verdict: dict[str, Any],
    label_parsed: dict[str, object] | None,
) -> list[dict[str, Any]]:
    """组合放行规则复核：签发时只有色差放行且标签有效才应存在放行单。"""
    should_release = bool(verdict["passed"]) and label_parsed is not None
    if not should_release:
        reasons = []
        if not verdict["passed"]:
            reasons.append("色差复算为超差")
        if label_parsed is None:
            reasons.append("标签原文无法重新解析")
        return [
            _mismatch(
                "release_rule",
                "release",
                "存在放行单（文档被导入即说明它声称已签发）",
                "不应签发",
                "组合放行规则不一致：" + "、".join(reasons) + "，单据不应作为放行单存在",
            )
        ]
    return []


def _first_text_diff(actual: str, expected: str) -> dict[str, Any]:
    """定位两段正文首个不一致的位置（行号 1 起、列号 1 起，按码点计）。"""
    actual_lines = actual.split("\n")
    expected_lines = expected.split("\n")
    for li in range(max(len(actual_lines), len(expected_lines))):
        a = actual_lines[li] if li < len(actual_lines) else None
        e = expected_lines[li] if li < len(expected_lines) else None
        if a == e:
            continue
        if a is None:
            return {"line": li + 1, "column": 1, "kind": "missing_line",
                    "embedded": None, "recomputed": e}
        if e is None:
            return {"line": li + 1, "column": 1, "kind": "unexpected_line",
                    "embedded": a, "recomputed": None}
        for col in range(max(len(a), len(e))):
            ca = a[col] if col < len(a) else None
            ce = e[col] if col < len(e) else None
            if ca != ce:
                return {"line": li + 1, "column": col + 1,
                        "kind": "character", "embedded": ca, "recomputed": ce}
    return {"line": None, "column": None, "kind": "identical",
            "embedded": None, "recomputed": None}


def _check_text(
    doc: dict[str, Any],
    verdict: dict[str, Any],
    parsed: dict[str, object] | None,
) -> tuple[list[dict[str, Any]], str | None]:
    """正文复核：用单据自身编号、时间和复算字段逐字符重建正文，再比对差异位置。"""
    if parsed is None:
        return [
            _mismatch(
                "text", "text", None, None,
                "标签原文无法重新解析，无法在同一批次基础上重建正文；"
                "正文一致性不可判定（标签不一致已在上一条定位）",
            )
        ], None

    standard = LabSnapshot(**doc["standard"])
    sample = LabSnapshot(**doc["sample"])
    batch = parsed["batch"]
    assert isinstance(batch, dict)
    rebuilt = build_release_text(
        doc["id"], doc["generated_at"], standard, sample,
        doc["label_raw"], batch, verdict,
    )
    embedded_text = doc["text"]
    if embedded_text == rebuilt:
        return [], rebuilt
    diff = _first_text_diff(embedded_text, rebuilt)
    return [
        _mismatch(
            "text", "text", embedded_text, rebuilt,
            "可读正文与按单据编号/时间/复算字段重建的正文不一致："
            f"首个差异在第 {diff['line']} 行第 {diff['column']} 列（{diff['kind']}）",
        )
        | {"position": {"line": diff["line"], "column": diff["column"],
                        "kind": diff["kind"], "embedded": diff["embedded"],
                        "recomputed": diff["recomputed"]}},
    ], rebuilt


def review_release_document(doc: dict[str, Any]) -> dict[str, Any]:
    """对结构合法的放行单 JSON 执行自洽性复核，返回 200 响应体。

    响应固定于**本次导入快照**：只读取 ``doc`` 内嵌内容，不接触任何正在填写的
    表单，也不签发/替换任何放行单。
    """
    checks_order = ("meta", "color", "label", "release_rule", "text")

    meta_findings = _check_meta(doc)
    color_findings, verdict = _check_color(doc)
    label_findings, parsed = _check_label(doc)
    rule_findings = _check_release_rule(verdict, parsed)
    text_findings, rebuilt_text = _check_text(doc, verdict, parsed)

    grouped = {
        "meta": meta_findings,
        "color": color_findings,
        "label": label_findings,
        "release_rule": rule_findings,
        "text": text_findings,
    }
    all_findings = [f for name in checks_order for f in grouped[name]]
    passed_checks = [name for name in checks_order if not grouped[name]]
    failed_checks = [name for name in checks_order if grouped[name]]

    return {
        "ok": True,
        # 内容自洽 ≠ 来源真实：无签名复制件最多得到前一种结论
        "content_self_consistent": not all_findings,
        "source_authentic": False,
        "authentication": {
            "authenticated": False,
            "signed": False,
            "message": _SOURCE_MESSAGE,
        },
        "checks": {
            "passed": passed_checks,
            "failed": failed_checks,
            "mismatches": all_findings,
        },
        "recomputed": {
            "color": verdict,
            "batch": parsed["batch"] if parsed is not None else None,
            "text": rebuilt_text,
        },
        # 复核结论固定于本次导入快照（逐字段回显，含标签原文/正文的每一个空格）
        "imported": {
            "id": doc["id"],
            "generated_at": doc["generated_at"],
            "standard": dict(doc["standard"]),
            "sample": dict(doc["sample"]),
            "label_raw": doc["label_raw"],
            "batch": dict(doc["batch"]),
            "text": doc["text"],
        },
    }
