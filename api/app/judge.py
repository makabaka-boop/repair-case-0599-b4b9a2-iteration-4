"""ΔE00 的舍入与放行判定。

判定只依据**未舍入**的 ΔE00：ΔE00 <= 2.00 放行，否则超差。
展示用的 ΔE00 与超出量只在最后一步四舍五入到两位小数（逢五进一），
避免“中间舍入不同而结论相反”的手算表问题。
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

# 印刷车间专色墨比对阈值（未舍入值参与比较）
TOLERANCE = 2.0


def round_half_up_2(value: float) -> float:
    """把最终值四舍五入到两位小数（0.005 一律进一，非银行家舍入）。"""
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def judge(delta_e00_raw: float) -> dict[str, float | bool | None]:
    """根据未舍入 ΔE00 给出放行/超差结论。

    返回字段：
        delta_e00        未舍入 ΔE00（供复算）
        delta_e00_round  两位小数展示值
        threshold        阈值 2.00
        passed           未舍入值 <= 2.00 为 True
        excess_raw       超出阈值的未舍入量；放行时为 0.0
        excess_round     两位小数展示用超出量；放行时为 0.0
        relation         “<=” 或 “>”，直接说明阈值关系
    """
    passed = delta_e00_raw <= TOLERANCE
    excess_raw = max(0.0, delta_e00_raw - TOLERANCE)
    return {
        "delta_e00": delta_e00_raw,
        "delta_e00_round": round_half_up_2(delta_e00_raw),
        "threshold": TOLERANCE,
        "passed": passed,
        "excess_raw": excess_raw,
        "excess_round": round_half_up_2(excess_raw),
        "relation": "<=" if passed else ">",
    }
