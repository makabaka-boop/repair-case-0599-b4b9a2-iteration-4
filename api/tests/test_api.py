"""FastAPI 端点测试：校验拒绝、字段错误、判定舍入与阈值关系。"""

from __future__ import annotations

from decimal import Decimal

from fastapi.testclient import TestClient

from app.judge import round_half_up_2
from app.main import app

client = TestClient(app)


def _payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "standard": {"L": 50.0, "a": 2.6772, "b": -79.7751},
        "sample": {"L": 50.0, "a": 0.0, "b": -82.7485},
    }
    payload.update(overrides)
    return payload


# ── 正常计算与判定 ──────────────────────────────────────────────────────

def test_pass_case_returns_full_result() -> None:
    res = client.post(
        "/api/delta-e",
        json={
            "standard": {"L": 60.2574, "a": -34.0099, "b": 36.2677},
            "sample": {"L": 60.4626, "a": -34.1751, "b": 39.4387},
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    result = body["result"]
    assert abs(result["delta_e00"] - 1.2644) <= 1e-3
    assert result["delta_e00_round"] == 1.26
    assert result["passed"] is True
    assert result["relation"] == "<="
    assert result["excess_raw"] == 0.0
    assert result["excess_round"] == 0.0
    assert result["threshold"] == 2.0


def test_fail_case_reports_excess() -> None:
    res = client.post("/api/delta-e", json=_payload())
    body = res.json()
    assert res.status_code == 200
    result = body["result"]
    assert abs(result["delta_e00"] - 2.0425) <= 1e-3
    assert result["passed"] is False
    assert result["relation"] == ">"
    assert result["delta_e00_round"] == 2.04
    assert abs(result["excess_raw"] - 0.0425) <= 1e-3
    assert result["excess_round"] == 0.04


def test_half_up_rounding_is_not_bankers_rounding() -> None:
    """最终展示值用“逢五进一”而非银行家舍入。

    用 Decimal 精确构造 2.005，避免二进制浮点把 2.005 存成略小的值。
    """
    # 2.005 -> 2.01（进一），银行家舍入会错误地给 2.00
    assert round_half_up_2(float(Decimal("2.005"))) == 2.01
    # 2.004 -> 2.00
    assert round_half_up_2(float(Decimal("2.004"))) == 2.00
    # 2.015 -> 2.02，验证不是“四舍六入五成双”
    assert round_half_up_2(float(Decimal("2.015"))) == 2.02


def test_threshold_is_inclusive() -> None:
    """未舍入 ΔE00 恰好等于 2.00 时放行（<=）。"""
    # 同一颜色 ΔE00 = 0，确认放行边界含义
    res = client.post(
        "/api/delta-e",
        json={
            "standard": {"L": 50.0, "a": 10.0, "b": -10.0},
            "sample": {"L": 50.0, "a": 10.0, "b": -10.0},
        },
    )
    result = res.json()["result"]
    assert result["delta_e00"] == 0.0
    assert result["passed"] is True


def test_verdict_uses_unrounded_value_not_display_value() -> None:
    """显示 2.00 可能来自未舍入 1.997x；此时必须放行而非按 2.00 误判。

    纯明度差对：sample L = 52.004。
    未舍入 ΔE00 ≈ 1.997436 <= 2.00 → 放行，两位小数显示为 2.00。
    手算表若先舍入后比较，会在 2.00 边界上做出相反结论。
    """
    res = client.post(
        "/api/delta-e",
        json={
            "standard": {"L": 50.0, "a": 0.0, "b": 0.0},
            "sample": {"L": 52.004, "a": 0.0, "b": 0.0},
        },
    )
    result = res.json()["result"]
    assert result["delta_e00_round"] == 2.00
    assert result["delta_e00"] < 2.0
    assert result["passed"] is True
    assert result["relation"] == "<="
    assert result["excess_round"] == 0.0


def test_boundary_component_values_are_accepted() -> None:
    """L* 端点 0/100、a*/b* 端点 -128/127 均包含。"""
    res = client.post(
        "/api/delta-e",
        json={
            "standard": {"L": 0.0, "a": -128.0, "b": -128.0},
            "sample": {"L": 100.0, "a": 127.0, "b": 127.0},
        },
    )
    assert res.status_code == 200
    assert res.json()["ok"] is True


# ── 整次拒绝与字段错误 ──────────────────────────────────────────────────

def _assert_rejected(body: dict[str, object]) -> None:
    assert body["ok"] is False
    assert "errors" in body and body["errors"]
    for err in body["errors"]:
        assert err["field"]
        assert err["message"]


def test_missing_field_is_rejected_with_field_error() -> None:
    res = client.post(
        "/api/delta-e",
        json={"standard": {"L": 50.0, "a": 1.0}, "sample": {"L": 50.0, "a": 0.0, "b": 0.0}},
    )
    assert res.status_code == 422
    body = res.json()
    _assert_rejected(body)
    assert any(e["field"] == "standard.b" for e in body["errors"])


def test_missing_whole_color_is_rejected() -> None:
    res = client.post("/api/delta-e", json={"sample": {"L": 1, "a": 0, "b": 0}})
    assert res.status_code == 422
    assert any(e["field"] == "standard" for e in res.json()["errors"])


def test_non_finite_values_are_rejected() -> None:
    for bad in ("NaN", "Infinity", "-Infinity"):
        res = client.post(
            "/api/delta-e",
            json={
                "standard": {"L": 50.0, "a": 0.0, "b": 0.0},
                "sample": {"L": 50.0, "a": 0.0, "b": bad},
            },
        )
        assert res.status_code == 422, (bad, res.text)
        assert any(e["field"] == "sample.b" for e in res.json()["errors"])


def test_overflow_literal_is_rejected_as_non_finite() -> None:
    """原始 JSON 中的 1e999 会被解析为 ±Infinity，仍须拒绝。"""
    res = client.post(
        "/api/delta-e",
        content=(
            b'{"standard":{"L":50,"a":0,"b":0},'
            b'"sample":{"L":50,"a":0,"b":1e999}}'
        ),
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 422
    assert any(e["field"] == "sample.b" for e in res.json()["errors"])


def test_out_of_range_is_rejected_inclusive_endpoints() -> None:
    cases = [
        ("standard", "L", -0.0001),
        ("standard", "L", 100.0001),
        ("sample", "a", -128.0001),
        ("sample", "a", 127.0001),
        ("sample", "b", -129.0),
        ("sample", "b", 128.0),
    ]
    for color, comp, value in cases:
        body = {
            "standard": {"L": 50.0, "a": 0.0, "b": 0.0},
            "sample": {"L": 50.0, "a": 0.0, "b": 0.0},
        }
        body[color][comp] = value
        res = client.post("/api/delta-e", json=body)
        assert res.status_code == 422, (color, comp, value)
        assert any(e["field"] == f"{color}.{comp}" for e in res.json()["errors"])


def test_inclusive_endpoints_exactly_accepted() -> None:
    for v, comp, ok in [
        (0.0, "L", True), (100.0, "L", True),
        (-128.0, "a", True), (127.0, "a", True),
    ]:
        body = {
            "standard": {"L": 50.0, "a": 0.0, "b": 0.0},
            "sample": {"L": 50.0, "a": 0.0, "b": 0.0},
        }
        body["sample"][comp] = v
        res = client.post("/api/delta-e", json=body)
        assert res.status_code == 200 if ok else 422


def test_wrong_type_is_rejected() -> None:
    res = client.post(
        "/api/delta-e",
        json={
            "standard": {"L": "五十", "a": 0.0, "b": 0.0},
            "sample": {"L": 50.0, "a": 0.0, "b": 0.0},
        },
    )
    assert res.status_code == 422
    assert any(e["field"] == "standard.L" for e in res.json()["errors"])


def test_extra_field_is_rejected() -> None:
    res = client.post(
        "/api/delta-e",
        json={
            "standard": {"L": 50.0, "a": 0.0, "b": 0.0, "x": 1},
            "sample": {"L": 50.0, "a": 0.0, "b": 0.0},
        },
    )
    assert res.status_code == 422


def test_health() -> None:
    assert client.get("/health").json() == {"ok": True}
