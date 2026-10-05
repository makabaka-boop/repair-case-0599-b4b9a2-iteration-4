"""CIEDE2000 参考色对验证。

数据来自 Sharma, Wu, Dalal (2005) 公开的 34 对补充测试色对
（api/tests/data/ciede2000_reference.csv，含同一公开文件附加的 3 个边界对）。
要求每一对的实现误差不超过 0.0001。
"""

from __future__ import annotations

import csv
import os

import pytest

from app.ciede2000 import CIELab, ciede2000

DATA_PATH = os.path.join(os.path.dirname(__file__), "data", "ciede2000_reference.csv")
TOLERANCE = 0.0001


def _load_reference_pairs() -> list[tuple[float, ...]]:
    rows: list[tuple[float, ...]] = []
    with open(DATA_PATH, encoding="utf-8") as fh:
        for raw in csv.reader(line for line in fh if not line.startswith("#")):
            if not raw:
                continue
            rows.append(tuple(float(v) for v in raw))
    return rows


PAIRS = _load_reference_pairs()


def test_reference_file_contains_all_published_pairs() -> None:
    """Sharma 论文表 1 共 34 对 + 同文件 3 个极端对。"""
    assert len(PAIRS) == 37


@pytest.mark.parametrize(
    "l1,a1,b1,l2,a2,b2,expected",
    PAIRS,
    ids=[f"pair-{i:02d}" for i in range(1, len(PAIRS) + 1)],
)
def test_ciede2000_matches_reference(
    l1: float, a1: float, b1: float,
    l2: float, a2: float, b2: float,
    expected: float,
) -> None:
    """每一对参考色对误差 <= 0.0001；对称性也必须成立。"""
    lab1 = CIELab(l1, a1, b1)
    lab2 = CIELab(l2, a2, b2)

    got_12 = ciede2000(lab1, lab2)
    got_21 = ciede2000(lab2, lab1)

    assert abs(got_12 - expected) <= TOLERANCE, (
        f"pair {lab1} vs {lab2}: got {got_12:.6f}, expected {expected:.4f}"
    )
    assert abs(got_21 - expected) <= TOLERANCE
    # 色差必须对称且非负
    assert got_12 == pytest.approx(got_21, abs=1e-12)
    assert got_12 >= 0.0


def test_identical_colors_have_zero_difference() -> None:
    assert ciede2000(CIELab(50.0, 2.6772, -79.7751),
                     CIELab(50.0, 2.6772, -79.7751)) == 0.0


def test_threshold_boundary_pair_from_reference() -> None:
    """参考对 #1 的 ΔE00 = 2.0425 > 2，应超差；#25 = 1.2644 应放行。"""
    over = ciede2000(CIELab(50.0, 2.6772, -79.7751),
                     CIELab(50.0, 0.0, -82.7485))
    under = ciede2000(CIELab(60.2574, -34.0099, 36.2677),
                      CIELab(60.4626, -34.1751, 39.4387))
    assert over == pytest.approx(2.0425, abs=1e-4)
    assert over > 2.0
    assert under == pytest.approx(1.2644, abs=1e-4)
    assert under <= 2.0
