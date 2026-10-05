"""逐项实现的 CIEDE2000 色差公式。

严格依据：
    Sharma, G., Wu, W., Dalal, E. N. (2005),
    "The CIEDE2000 Color-Difference Formula: Implementation Notes,
    Supplementary Test Data, and Mathematical Observations",
    Color Research & Application, 30(1), 21-30.

本模块只使用 Python 标准库 math，不调用任何色差库、查表或近似结果。
参数因子 kL、kC、kH 固定取 1（工业印刷默认条件）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# CIEDE2000 常量（论文 Eq. (14) / (22)）
_C_25_7 = 25.0**7
_K_L = 1.0
_K_C = 1.0
_K_H = 1.0


def _hue_angle(a: float, b: float) -> float:
    """返回 Lab 坐标 (a*, b*) 的色相角 h，范围 [0, 360) 度。"""
    if math.isclose(a, 0.0, abs_tol=1e-12) and math.isclose(b, 0.0, abs_tol=1e-12):
        # 论文规定：无彩轴上 a'=b'=0 时色相角取 0（后续差值才为 0）
        return 0.0
    angle = math.degrees(math.atan2(b, a))
    return angle + 360.0 if angle < 0.0 else angle


def _hue_difference(h1: float, h2: float, c1: float, c2: float) -> float:
    """计算 Δh'，论文 Eq. (10)。"""
    if c1 * c2 == 0.0:
        # 任一颜色在无彩轴上时 Δh' = 0
        return 0.0
    diff = h2 - h1
    if diff > 180.0:
        diff -= 360.0
    elif diff < -180.0:
        diff += 360.0
    return diff


def _mean_hue(h1: float, h2: float, c1: float, c2: float) -> float:
    """计算平均色相 h̄'，论文 Eq. (13)。"""
    if c1 * c2 == 0.0:
        # 任一颜色无彩时，平均色相取另一个颜色的色相角
        return h1 + h2
    s = h1 + h2
    d = abs(h1 - h2)
    if d <= 180.0:
        return s / 2.0
    # 色相角相差超过 180°
    if s < 360.0:
        return (s + 360.0) / 2.0
    return (s - 360.0) / 2.0


@dataclass(frozen=True)
class CIELab:
    """CIE L*a*b* 三元组。"""

    L: float
    a: float
    b: float


def ciede2000(lab1: CIELab, lab2: CIELab) -> float:
    """计算两个 CIE L*a*b* 颜色之间的 ΔE00（kL = kC = kH = 1）。

    返回未经舍入的色差。舍入与放行判定由调用方负责，
    以避免中间舍入导致结论不一致。
    """
    L1, a1, b1 = lab1.L, lab1.a, lab1.b
    L2, a2, b2 = lab2.L, lab2.a, lab2.b

    # ── 步骤 1：彩度与色相角（论文 Eq. (8)）────────────────────────────
    C1_ab = math.hypot(a1, b1)
    C2_ab = math.hypot(a2, b2)
    C_bar_ab = (C1_ab + C2_ab) / 2.0

    # 论文 Eq. (8)：G 项对 a* 轴做灰区修正
    G = 0.5 * (1.0 - math.sqrt(C_bar_ab**7 / (C_bar_ab**7 + _C_25_7)))
    a1_prime = (1.0 + G) * a1
    a2_prime = (1.0 + G) * a2

    C1_prime = math.hypot(a1_prime, b1)
    C2_prime = math.hypot(a2_prime, b2)
    h1_prime = _hue_angle(a1_prime, b1)
    h2_prime = _hue_angle(a2_prime, b2)

    # ── 步骤 2：三项差值（论文 Eq. (9)-(11)）──────────────────────────
    delta_L_prime = L2 - L1
    delta_C_prime = C2_prime - C1_prime
    delta_h_prime = _hue_difference(h1_prime, h2_prime, C1_prime, C2_prime)
    # ΔH' = 2 sqrt(C1' C2') sin(Δh'/2)（论文 Eq. (11)）
    delta_H_prime = (
        2.0
        * math.sqrt(C1_prime * C2_prime)
        * math.sin(math.radians(delta_h_prime / 2.0))
    )

    # ── 步骤 3：加权函数（论文 Eq. (12)-(14)）─────────────────────────
    L_bar_prime = (L1 + L2) / 2.0
    C_bar_prime = (C1_prime + C2_prime) / 2.0
    h_bar_prime = _mean_hue(h1_prime, h2_prime, C1_prime, C2_prime)

    T = (
        1.0
        - 0.17 * math.cos(math.radians(h_bar_prime - 30.0))
        + 0.24 * math.cos(math.radians(2.0 * h_bar_prime))
        + 0.32 * math.cos(math.radians(3.0 * h_bar_prime + 6.0))
        - 0.20 * math.cos(math.radians(4.0 * h_bar_prime - 63.0))
    )

    # S 加权项（论文 Eq. (15)）
    S_L = 1.0 + (0.015 * (L_bar_prime - 50.0) ** 2) / math.sqrt(
        20.0 + (L_bar_prime - 50.0) ** 2
    )
    S_C = 1.0 + 0.045 * C_bar_prime
    S_H = 1.0 + 0.015 * C_bar_prime * T

    # R_C（论文 Eq. (16)）
    R_C = 2.0 * math.sqrt(
        C_bar_prime**7 / (C_bar_prime**7 + _C_25_7)
    )

    # 蓝色旋转项 R_T（论文 Eq. (17)）
    delta_theta = 30.0 * math.exp(-(((h_bar_prime - 275.0) / 25.0) ** 2))
    R_T = -math.sin(math.radians(2.0 * delta_theta)) * R_C

    # ── 步骤 4：最终合成（论文 Eq. (22)）──────────────────────────────
    term_L = delta_L_prime / (_K_L * S_L)
    term_C = delta_C_prime / (_K_C * S_C)
    term_H = delta_H_prime / (_K_H * S_H)

    delta_e00 = math.sqrt(
        term_L**2
        + term_C**2
        + term_H**2
        + R_T * term_C * term_H
    )
    return delta_e00
