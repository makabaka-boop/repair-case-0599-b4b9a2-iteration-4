"""批次放行单组合流程测试：组合裁决、失败区分与字段身份。

覆盖：
* 色差放行 × 标签有效 → 生成放行单（结构化字段、可复制整文、原始输入快照）；
* 色差放行 × 标签解析失败 / 色差超差 × 标签有效 / 色差超差 × 标签失败 →
  released=False 且 release=None（不生成半张凭据），两项核验仍各自完整返回；
* 组合端点与既有独立端点复用同一规则（同一输入判定一致）；
* 请求体校验失败（缺失/非有限/越界/标签空串/多余字段）→ HTTP 422 整次拒绝，
  与“核验失败（200）”“请求异常”明确区分；
* 字段身份：快照数值即提交数值，标签原文逐字符回显（含 AIM 前缀、行尾、尾随空格）。
"""

from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

# Sharma 参考对 #25：ΔE00 = 1.2644（放行）
PASS_STD = {"L": 60.2574, "a": -34.0099, "b": 36.2677}
PASS_SPL = {"L": 60.4626, "a": -34.1751, "b": 39.4387}

# Sharma 参考对 #1：ΔE00 = 2.0425（超差）
FAIL_STD = {"L": 50.0, "a": 2.6772, "b": -79.7751}
FAIL_SPL = {"L": 50.0, "a": 0.0, "b": -82.7485}

GTIN = "09506000134352"
LABEL_OK = f"(01){GTIN}(10)INK2407(17)280930"
LABEL_BAD_CHECK = f"(01){GTIN[:-1]}3(10)INK2407(17)280930"
LABEL_SCAN = f"01{GTIN}10INK2407\x1d17280930"
LABEL_TRAILING_SPACE = f"(01){GTIN}(10)INK2407 (17)280930"


def _post(body: object) -> tuple[int, dict[str, object]]:
    res = client.post("/api/batch-release", json=body)
    return res.status_code, res.json()


# ── 双项通过：生成放行单 ────────────────────────────────────────────────

def test_both_pass_generates_release_document() -> None:
    status, body = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_OK}
    )
    assert status == 200
    assert body["ok"] is True
    assert body["released"] is True

    color_check = body["color_check"]
    label_check = body["label_check"]
    assert color_check["passed"] is True
    assert abs(color_check["result"]["delta_e00"] - 1.2644) <= 1e-3
    assert color_check["result"]["relation"] == "<="
    assert label_check["passed"] is True
    assert "error" not in label_check
    assert label_check["parsed"]["batch"] == {
        "gtin": GTIN,
        "lot": "INK2407",
        "expires": "2028-09-30",
    }

    release = body["release"]
    assert release is not None
    assert re.fullmatch(r"REL-\d{8}T\d{6}Z-[0-9a-f]{8}", release["id"])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", release["generated_at"])


def test_release_document_is_pinned_to_this_request_snapshot() -> None:
    """凭据内字段必须与本次提交逐字段一致（字段身份），不能是别的请求的结果。"""
    status, body = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_OK}
    )
    assert status == 200
    release = body["release"]

    # 顶层输入快照
    assert body["inputs"] == {
        "standard": PASS_STD,
        "sample": PASS_SPL,
        "label_raw": LABEL_OK,
    }
    # 凭据内嵌的同样快照：Lab 数值与提交值逐字段相等
    assert release["standard"] == PASS_STD
    assert release["sample"] == PASS_SPL
    assert release["label_raw"] == LABEL_OK
    # 批次三字段即本次标签解析结果
    assert release["batch"] == {
        "gtin": GTIN,
        "lot": "INK2407",
        "expires": "2028-09-30",
    }
    assert release["result"]["passed"] is True


def test_release_document_text_is_copyable_and_self_describing() -> None:
    status, body = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_OK}
    )
    text = body["release"]["text"]
    assert body["release"]["id"] in text
    # 色差核验结论与数值快照
    assert "ΔE00=1.26" in text
    assert "放行" in text
    assert f"L*={PASS_STD['L']:g}" in text
    # 标签核验批次字段
    assert GTIN in text
    assert "INK2407" in text
    assert "2028-09-30" in text
    # 标签原文逐字符夹在 >>> / <<< 之间
    between = text.split(">>>", 1)[1].split("<<<", 1)[0].strip("\n")
    assert between == LABEL_OK


def test_consecutive_requests_get_distinct_release_documents() -> None:
    """连续两次放行的凭据 id 互不相同，后一张不会被前一张身份覆盖。"""
    _, first = _post({"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_OK})
    _, second = _post(
        {
            "standard": PASS_STD,
            "sample": PASS_SPL,
            "label_raw": f"(01){GTIN}(10)INK2408(17)280930",
        }
    )
    assert first["release"]["id"] != second["release"]["id"]
    assert second["release"]["batch"]["lot"] == "INK2408"
    # 前一张凭据自身快照不变
    assert first["release"]["batch"]["lot"] == "INK2407"


def test_scan_format_label_also_generates_release() -> None:
    status, body = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_SCAN}
    )
    assert status == 200
    assert body["released"] is True
    assert body["label_check"]["parsed"]["format"] == "scan"
    # 凭据保留扫描格式原文（含 FNC1 0x1d），不是归一后的可读格式
    assert body["release"]["label_raw"] == LABEL_SCAN
    assert "\x1d" in body["release"]["text"]


def test_label_raw_snapshot_is_verbatim_including_prefix_eol_and_spaces() -> None:
    """AIM 前缀、末尾行尾、批号尾随空格都必须逐字符出现在快照中。"""
    raw = f"]d2{LABEL_SCAN}\n"
    status, body = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": raw}
    )
    assert status == 200
    assert body["released"] is True
    assert body["inputs"]["label_raw"] == raw
    assert body["release"]["label_raw"] == raw
    assert raw in body["release"]["text"]

    # 尾随空格：解析出的批号带空格，且与无空格批号是两张不同凭据
    _, spaced = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_TRAILING_SPACE}
    )
    assert spaced["release"]["batch"]["lot"] == "INK2407 "
    _, plain = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_OK}
    )
    assert plain["release"]["batch"]["lot"] == "INK2407"
    assert spaced["release"]["label_raw"] != plain["release"]["label_raw"]


def test_combines_same_rules_as_independent_endpoints() -> None:
    """组合端点复用既有判定/解析：与 /api/delta-e、/api/gs1-label 结果一致。"""
    de = client.post(
        "/api/delta-e", json={"standard": PASS_STD, "sample": PASS_SPL}
    ).json()["result"]
    gs1 = client.post("/api/gs1-label", json={"raw": LABEL_OK}).json()

    _, body = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_OK}
    )
    assert body["color_check"]["result"] == de
    # 独立端点响应外层多一个 ok 标记；解析载荷（format/fields/batch）必须完全一致
    assert body["label_check"]["parsed"] == {
        "format": gs1["format"],
        "fields": gs1["fields"],
        "batch": gs1["batch"],
    }


# ── 组合裁决：四种真值组合，失败绝不生成半张凭据 ─────────────────────────

def test_color_pass_label_invalid_no_half_document() -> None:
    status, body = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_BAD_CHECK}
    )
    assert status == 200
    assert body["ok"] is True  # 请求本身合法
    assert body["released"] is False
    assert body["release"] is None
    assert body["color_check"]["passed"] is True
    assert body["color_check"]["result"]["passed"] is True
    label_check = body["label_check"]
    assert label_check["passed"] is False
    assert "parsed" not in label_check
    assert label_check["error"]["code"] == "invalid_checksum"
    assert label_check["error"]["position"] == 17
    assert "校验位" in label_check["error"]["message"]


def test_color_fail_label_valid_no_half_document() -> None:
    status, body = _post(
        {"standard": FAIL_STD, "sample": FAIL_SPL, "label_raw": LABEL_OK}
    )
    assert status == 200
    assert body["released"] is False
    assert body["release"] is None
    result = body["color_check"]["result"]
    assert body["color_check"]["passed"] is False
    assert result["passed"] is False
    assert result["relation"] == ">"
    assert result["delta_e00_round"] == 2.04
    assert result["excess_round"] == 0.04
    # 标签核验照常完成，不能因色差失败而省略
    assert body["label_check"]["passed"] is True
    assert body["label_check"]["parsed"]["batch"]["gtin"] == GTIN


def test_both_fail_reports_both_checks_no_document() -> None:
    status, body = _post(
        {"standard": FAIL_STD, "sample": FAIL_SPL, "label_raw": LABEL_BAD_CHECK}
    )
    assert status == 200
    assert body["released"] is False
    assert body["release"] is None
    assert body["color_check"]["passed"] is False
    assert body["label_check"]["passed"] is False
    assert body["label_check"]["error"]["code"] == "invalid_checksum"


def test_parse_error_codes_are_distinguished() -> None:
    """解析失败的机器可读代码逐项透传（unsupported_character / invalid_date /
    missing_field / parse_error），与色差超差、请求异常明确区分。"""
    cases = [
        ("(05)XYZ", "parse_error"),
        (f"(01){GTIN}(10)INK2407(17)281301", "invalid_date"),
        (f"(10)INK2407(17)280930", "missing_field"),  # 缺 01
        (f"(01){GTIN}(17)280930(10)AB\t", "unsupported_character"),
    ]
    for raw, code in cases:
        status, body = _post(
            {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": raw}
        )
        assert status == 200, (raw, status)
        assert body["label_check"]["passed"] is False, raw
        assert body["label_check"]["error"]["code"] == code, raw
        assert body["release"] is None


# ── 请求体校验失败：HTTP 422，整次拒绝（区别于核验失败 200） ─────────────

def test_missing_lab_component_is_422() -> None:
    res = client.post(
        "/api/batch-release",
        json={"standard": {"L": 50, "a": 0}, "sample": FAIL_SPL, "label_raw": LABEL_OK},
    )
    assert res.status_code == 422
    body = res.json()
    assert body["ok"] is False
    assert any(e["field"] == "standard.b" for e in body["errors"])


def test_non_finite_and_out_of_range_are_422() -> None:
    for bad_sample in (
        {"L": 50, "a": 0, "b": "NaN"},
        {"L": 50, "a": 0, "b": 200},
        {"L": -1, "a": 0, "b": 0},
    ):
        res = client.post(
            "/api/batch-release",
            json={"standard": PASS_STD, "sample": bad_sample, "label_raw": LABEL_OK},
        )
        assert res.status_code == 422, bad_sample


def test_missing_or_empty_label_raw_is_422() -> None:
    for body in (
        {"standard": PASS_STD, "sample": PASS_SPL},
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": ""},
    ):
        res = client.post("/api/batch-release", json=body)
        assert res.status_code == 422
        assert any(e["field"] == "label_raw" for e in res.json()["errors"])


def test_extra_field_is_422() -> None:
    res = client.post(
        "/api/batch-release",
        json={
            "standard": PASS_STD,
            "sample": PASS_SPL,
            "label_raw": LABEL_OK,
            "unexpected": 1,
        },
    )
    assert res.status_code == 422


def test_label_parse_failure_is_200_not_422() -> None:
    """关键区分：标签解析失败是“核验失败”（200 + label_check.error），
    只有请求体本身不合法才是 422。"""
    status, body = _post(
        {"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_BAD_CHECK}
    )
    assert status == 200
    assert "errors" not in body
    assert body["label_check"]["error"] is not None


def test_independent_endpoints_still_work_unchanged() -> None:
    """新增组合流程不改变既有两个独立入口的行为。"""
    assert client.post(
        "/api/delta-e", json={"standard": PASS_STD, "sample": PASS_SPL}
    ).status_code == 200
    assert client.post("/api/gs1-label", json={"raw": LABEL_BAD_CHECK}).status_code == 422
