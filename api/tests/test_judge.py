"""舍入与放行判定的单元测试。"""

from __future__ import annotations

from decimal import Decimal

from app.judge import TOLERANCE, judge, round_half_up_2


def test_round_half_up_is_not_bankers() -> None:
    # 用 Decimal 精确构造，规避二进制浮点把 2.005 存成略小值
    assert round_half_up_2(float(Decimal("2.005"))) == 2.01
    assert round_half_up_2(float(Decimal("2.015"))) == 2.02
    assert round_half_up_2(2.004) == 2.00
    # 输出固定两位小数语义
    assert round_half_up_2(0.0425) == 0.04
    assert round_half_up_2(0.045) == 0.05


def test_judge_pass_when_raw_equals_threshold() -> None:
    verdict = judge(TOLERANCE)
    assert verdict["passed"] is True
    assert verdict["relation"] == "<="
    assert verdict["excess_raw"] == 0.0
    assert verdict["excess_round"] == 0.0
    assert verdict["delta_e00_round"] == 2.0


def test_judge_fail_reports_excess() -> None:
    verdict = judge(2.0424596801565764)
    assert verdict["passed"] is False
    assert verdict["relation"] == ">"
    assert verdict["delta_e00_round"] == 2.04
    assert verdict["excess_round"] == 0.04
    assert abs(verdict["excess_raw"] - 0.0424596801565764) < 1e-12


def test_judge_zero() -> None:
    verdict = judge(0.0)
    assert verdict["passed"] is True
    assert verdict["delta_e00_round"] == 0.0
    assert verdict["excess_round"] == 0.0


def test_verdict_based_on_unrounded_value() -> None:
    """未舍入 1.997436… 显示为 2.00，但必须放行（<= 2.00）。"""
    verdict = judge(1.997436234)
    assert verdict["delta_e00_round"] == 2.00
    assert verdict["passed"] is True
