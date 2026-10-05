"""批次放行单（可选组合流程）。

一次请求同时提交标准色/首张样张 Lab 值与刚扫描的油墨桶标签原文，后端**复用**
:mod:`app.judge`（CIEDE2000 色差判定）与 :mod:`app.gs1`（GS1 解析）两套既有
规则完成两项核验：

* 两项核验相互独立、在同一次请求内**都必须执行**——色差不因标签失败而省略，
  标签也不因色差超差而跳过；
* 只有“色差放行（未舍入 ΔE00 ≤ 2.00）”且“标签有效”同时成立时，才生成一张
  与本次请求输入**固定绑定**的放行单，凭据内嵌原始输入快照（两组 Lab 数值与
  标签原文逐字符快照）；
* 任一核验失败只返回该核验的失败明细（色差结果 / 标签错误码与位置），
  **绝不生成半张凭据**（``release`` 为 ``None``）；
* 请求体本身的校验失败（字段缺失、非有限、越界、标签原文为空等）由 FastAPI
  在进入本模块前整次拒绝（HTTP 422），与“核验失败”明确区分。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .ciede2000 import CIELab, ciede2000
from .gs1 import Gs1ParseError, parse_gs1_label
from .judge import judge

# 放行单状态前缀；后接 UTC 时间戳与一次性随机段，保证连续提交互不覆盖
RELEASE_ID_PREFIX = "REL"


@dataclass(frozen=True)
class LabSnapshot:
    """一组已通过范围校验的 Lab 数值，作为放行单的原始输入快照。"""

    L: float
    a: float
    b: float

    def as_dict(self) -> dict[str, float]:
        return {"L": self.L, "a": self.a, "b": self.b}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _generated_at() -> str:
    """当前 UTC 时间的 ISO-8601 字符串（秒精度，Z 后缀）。"""
    return _utc_now().isoformat(timespec="seconds").replace("+00:00", "Z")


def _new_release_id(now: datetime) -> str:
    return f"{RELEASE_ID_PREFIX}-{now:%Y%m%dT%H%M%S}Z-{uuid.uuid4().hex[:8]}"


def _fmt_lab(lab: LabSnapshot) -> str:
    return f"L*={lab.L:g} a*={lab.a:g} b*={lab.b:g}"


def _build_release_document(
    standard: LabSnapshot,
    sample: LabSnapshot,
    label_raw: str,
    parsed: dict[str, object],
    verdict: dict[str, Any],
) -> dict[str, Any]:
    """生成与本次请求固定绑定的放行单：结构化字段 + 可复制整文 + 输入快照。

    文本中的批号/标签原文都是本次请求的逐字符快照；结构化字段（数值与字符串）
    供自动化逐字段核对“字段身份”，避免两项独立结果被误配。
    """
    batch = parsed["batch"]
    assert isinstance(batch, dict)
    now = _utc_now()
    doc_id = _new_release_id(now)
    generated_at = _generated_at()

    verdict_word = "✅ 放行" if verdict["passed"] else "⛔ 超差"
    relation = verdict["relation"]
    lines = [
        f"批次放行单 {doc_id}",
        f"生成时间（UTC）：{generated_at}",
        "── 色差核验（CIEDE2000，阈值 2.00，未舍入值判定）──",
        f"标准色：{_fmt_lab(standard)}",
        f"首张样张：{_fmt_lab(sample)}",
        (
            f"ΔE00={verdict['delta_e00_round']:.2f}"
            f"（未舍入 {verdict['delta_e00']:.6f}）{relation} 2.00：{verdict_word}"
        ),
        "── 标签核验（GS1 AI 01/10/17）──",
        f"商品编码 GTIN：{batch['gtin']}",
        f"批号（逐字符快照）：{batch['lot']}",
        f"失效日期：{batch['expires']}",
        "标签原文快照（开始/结束）：",
        ">>>",
        label_raw,
        "<<<",
    ]
    text = "\n".join(lines)

    return {
        "id": doc_id,
        "generated_at": generated_at,
        "standard": standard.as_dict(),
        "sample": sample.as_dict(),
        "result": verdict,
        "batch": dict(batch),
        "label_raw": label_raw,
        "text": text,
    }


def evaluate_batch_release(
    standard: LabSnapshot, sample: LabSnapshot, label_raw: str
) -> dict[str, Any]:
    """在同一次请求内执行色差判定与 GS1 解析，组合裁决并按需生成放行单。

    返回 200 响应体（请求体校验由调用方的 Pydantic 模型负责）：

    ``released`` 仅在 ``color_check.passed and label_check.passed`` 时为 True，
    此时 ``release`` 为放行单；否则 ``release`` 为 None，且两项核验的明细
    仍然各自完整返回。
    """
    # 核验一：复用既有 CIEDE2000 + judge 规则（未舍入 ΔE00 ≤ 2.00 放行）
    verdict = judge(ciede2000(CIELab(standard.L, standard.a, standard.b),
                              CIELab(sample.L, sample.a, sample.b)))
    color_check: dict[str, Any] = {"passed": bool(verdict["passed"]), "result": verdict}

    # 核验二：复用既有 GS1 解析规则；失败带机器可读 code 与首个错误位置
    try:
        parsed = parse_gs1_label(label_raw)
    except Gs1ParseError as exc:
        label_check: dict[str, Any] = {
            "passed": False,
            "error": {
                "code": exc.code,
                "message": f"标签解析失败：{exc.message}",
                "position": exc.position,
            },
        }
    else:
        label_check = {"passed": True, "parsed": parsed}

    released = color_check["passed"] and label_check["passed"]
    response: dict[str, Any] = {
        "ok": True,
        "released": released,
        # 两项核验共同的原始输入快照：凭据与本次请求一一对应
        "inputs": {
            "standard": standard.as_dict(),
            "sample": sample.as_dict(),
            "label_raw": label_raw,
        },
        "color_check": color_check,
        "label_check": label_check,
        # 只有双项通过才出现凭据；任何失败都是 None，不存在半张放行单
        "release": None,
    }
    if released:
        response["release"] = _build_release_document(
            standard, sample, label_raw, label_check["parsed"], verdict
        )
    return response
