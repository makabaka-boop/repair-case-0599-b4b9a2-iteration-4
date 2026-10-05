"""FastAPI 入口：两组 CIE L*a*b* 输入、严格校验、ΔE00 判定；GS1 批次标签解析。"""

from __future__ import annotations

import math
from typing import Any, Literal

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .ciede2000 import CIELab, ciede2000
from .gs1 import Gs1ParseError, parse_gs1_label
from .judge import judge
from .release import LabSnapshot, evaluate_batch_release

app = FastAPI(
    title="专色墨 ΔE00 比对 API",
    version="1.0.0",
    description="标准色与首张样张的 CIEDE2000 色差计算与放行判定。",
)

# 各分量允许范围，端点均包含
BOUNDS: dict[str, tuple[float, float]] = {
    "L": (0.0, 100.0),
    "a": (-128.0, 127.0),
    "b": (-128.0, 127.0),
}


class LabInput(BaseModel):
    """一组 CIE L*a*b* 输入，拒绝缺失、非有限与越界值。"""

    model_config = ConfigDict(extra="forbid")

    L: float = Field(..., description="L*，闭区间 [0, 100]")
    a: float = Field(..., description="a*，闭区间 [-128, 127]")
    b: float = Field(..., description="b*，闭区间 [-128, 127]")

    @field_validator("L", "a", "b")
    @classmethod
    def _finite_and_in_range(cls, v: float, info: Any) -> float:
        if not math.isfinite(v):
            raise ValueError("必须是有限数值（拒绝 NaN 与 ±Infinity）")
        low, high = BOUNDS[info.field_name]
        if not (low <= v <= high):
            raise ValueError(f"超出允许范围 [{low:g}, {high:g}]，端点包含")
        return v


class DeltaERequest(BaseModel):
    """请求体：标准色 standard 与首张样张 sample。"""

    model_config = ConfigDict(extra="forbid")

    standard: LabInput
    sample: LabInput


def _field_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """规整为逐字段错误列表，保留字段定位与原因。"""
    result = []
    for err in errors:
        loc = [str(part) for part in err.get("loc", []) if part != "body"]
        result.append(
            {
                "field": ".".join(loc) if loc else "body",
                "message": err.get("msg", "输入无效"),
                "type": err.get("type", "value_error"),
            }
        )
    return result


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Any, exc: RequestValidationError
) -> JSONResponse:
    """整次请求拒绝：任何字段错误都返回 422 与字段明细，前端据此清除旧结果。"""
    return JSONResponse(
        status_code=422,
        content={
            "ok": False,
            "message": "输入校验失败，整次请求被拒绝（未进行计算，也不会更新旧结果）",
            "errors": _field_errors(exc.errors()),
        },
    )


@app.get("/health")
def health() -> dict[str, Literal[True]]:
    return {"ok": True}


@app.post("/api/delta-e")
def delta_e(req: DeltaERequest) -> dict[str, Any]:
    """计算 ΔE00 并给出判定；仅最终 ΔE00 做两位小数舍入。"""
    standard = CIELab(req.standard.L, req.standard.a, req.standard.b)
    sample = CIELab(req.sample.L, req.sample.a, req.sample.b)

    raw = ciede2000(standard, sample)
    verdict = judge(raw)

    return {
        "ok": True,
        "standard": {"L": req.standard.L, "a": req.standard.a, "b": req.standard.b},
        "sample": {"L": req.sample.L, "a": req.sample.a, "b": req.sample.b},
        "result": verdict,
    }


class Gs1LabelRequest(BaseModel):
    """批次标签核验请求：扫码枪读出的原始文本（可读格式或 FNC1 扫描格式）。"""

    model_config = ConfigDict(extra="forbid")

    raw: str = Field(..., min_length=1, max_length=512, description="标签原始文本")


@app.post("/api/gs1-label")
def gs1_label(req: Gs1LabelRequest) -> Any:
    """解析 GS1 批次标签，返回统一批次信息（商品编码/批号/失效日期）。

    解析失败整次拒绝（422），并给出首个无法解析的字符位置 position（0 起），
    供前端在保留的原文中高亮定位。本端点与 /api/delta-e 互不影响。
    """
    try:
        parsed = parse_gs1_label(req.raw)
    except Gs1ParseError as exc:
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "code": exc.code,
                "message": f"标签解析失败：{exc.message}",
                "errors": [
                    {
                        "field": "raw",
                        "message": exc.message,
                        "type": exc.code,
                    }
                ],
                "position": exc.position,
            },
        )
    return {"ok": True, **parsed}


class BatchReleaseRequest(BaseModel):
    """批次放行单请求：两组 Lab 值与标签原文在**同一次请求**中提交。

    与两个独立入口相同：Lab 缺失/非有限/越界由字段校验器整次拒绝（422）；
    标签原文为空串同样在进入组合裁决前拒绝。色差超差与 GS1 解析失败不属于
    请求体校验错误，会在 200 响应里以两项核验明细分别返回（且不生成凭据）。
    """

    model_config = ConfigDict(extra="forbid")

    standard: LabInput
    sample: LabInput
    label_raw: str = Field(..., min_length=1, max_length=512, description="标签原始文本")


@app.post("/api/batch-release")
def batch_release(req: BatchReleaseRequest) -> dict[str, Any]:
    """组合流程：一次请求完成色差判定与 GS1 解析，双项通过才生成放行单。

    与 /api/delta-e、/api/gs1-label 复用同一套规则；两项核验相互独立、同请求
    内都执行。请求体校验失败仍走全局 422 处理器（整次拒绝）；色差超差或标签
    解析失败返回 200，分别落在 ``color_check`` / ``label_check``，``release``
    为 null（不生成半张凭据）。
    """
    standard = LabSnapshot(req.standard.L, req.standard.a, req.standard.b)
    sample = LabSnapshot(req.sample.L, req.sample.a, req.sample.b)
    return evaluate_batch_release(standard, sample, req.label_raw)
