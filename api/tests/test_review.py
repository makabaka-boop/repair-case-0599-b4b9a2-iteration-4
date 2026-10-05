"""复制批次放行单复核入口测试。

覆盖：
* 有效旧单：自洽但无服务端签名，只能得到“内容自洽（未鉴真）”；
* 色差数值/判定字段篡改：按内嵌两组 Lab 原值重新 CIEDE2000 并定位字段；
* 批号与标签尾随空格篡改：逐字符重新 GS1 解析并定位批次字段；
* 正文编号、时间、数值、标签原文等篡改：重建正文并给出行/列；
* 多字段篡改：一次列出所有不一致位置；
* 必要字段与 JSON 类型严格校验：导入失败 422，不返回复核快照；
* 新入口不影响 /api/delta-e、/api/gs1-label、/api/batch-release。
"""

from __future__ import annotations

import copy
from typing import Any

from fastapi.testclient import TestClient

from app.main import app
from app.release import LabSnapshot, evaluate_batch_release

client = TestClient(app)

PASS_STD = {"L": 60.2574, "a": -34.0099, "b": 36.2677}
PASS_SPL = {"L": 60.4626, "a": -34.1751, "b": 39.4387}
FAIL_STD = {"L": 50.0, "a": 2.6772, "b": -79.7751}
FAIL_SPL = {"L": 50.0, "a": 0.0, "b": -82.7485}
GTIN = "09506000134352"
LABEL_OK = f"(01){GTIN}(10)INK2407(17)280930"
LABEL_SPACED = f"(01){GTIN}(10)INK2407 (17)280930"


def valid_document(
    *,
    standard: dict[str, float] = PASS_STD,
    sample: dict[str, float] = PASS_SPL,
    label_raw: str = LABEL_OK,
) -> dict[str, Any]:
    body = evaluate_batch_release(
        LabSnapshot(**standard),
        LabSnapshot(**sample),
        label_raw,
    )
    assert body["release"] is not None
    return copy.deepcopy(body["release"])


def _review(document: Any) -> tuple[int, dict[str, Any]]:
    res = client.post("/api/release-review", json=document)
    return res.status_code, res.json()


def _fields(items: list[dict[str, Any]]) -> set[str]:
    return {item["field"] for item in items}


def test_valid_duplicate_is_content_consistent_but_not_authenticated() -> None:
    status, body = _review(valid_document())
    assert status == 200
    assert body["ok"] is True
    assert body["content_consistent"] is True
    assert body["mismatch_count"] == 0
    assert body["mismatches"] == []
    # 关键边界：自洽不等于服务端已鉴真。旧单没有密码学签名。
    assert body["authenticated"] is False
    assert body["authenticity_status"] == "content_consistent_unsigned"
    assert "未鉴真" in body["authenticity_message"]
    assert "签发来源真实" in body["authenticity_message"]

    rec = body["recalculated"]["release"]
    assert rec["text"] == body["imported_snapshot"]["text"]
    assert rec["batch"] == {"gtin": GTIN, "lot": "INK2407", "expires": "2028-09-30"}


def test_recalculates_color_from_embedded_lab_even_if_claimed_result_tampered() -> None:
    doc = valid_document()
    doc["standard"] = FAIL_STD
    doc["sample"] = FAIL_SPL  # 篡改内嵌 Lab 原值
    doc["result"]["delta_e00_round"] = 1.26
    doc["result"]["passed"] = True

    status, body = _review(doc)
    assert status == 200
    assert body["content_consistent"] is False
    fields = _fields(body["mismatches"])
    assert "result.delta_e00" in fields
    assert "result.delta_e00_round" in fields
    assert "result.passed" in fields
    assert "result.relation" in fields
    assert "result.excess_raw" in fields
    assert "result.excess_round" in fields
    assert "document" in fields

    color = body["recalculated"]["color_check"]
    assert color["passed"] is False
    assert color["result"]["delta_e00_round"] == 2.04
    # 正文不应基于被篡改的放行结论重建；先报告这不是有效放行单。
    assert body["recalculated"]["release"]["text"] is None


def test_batch_lot_tamper_is_found_from_verbatim_label_raw() -> None:
    doc = valid_document(label_raw=LABEL_OK)
    doc["batch"]["lot"] = "INK2408"

    status, body = _review(doc)
    assert status == 200
    mismatch = next(item for item in body["mismatches"] if item["field"] == "batch.lot")
    assert mismatch["section"] == "label"
    assert mismatch["expected"] == "INK2407"
    assert mismatch["actual"] == "INK2408"
    # 这里只篡改结构化批号字段；正文仍保留标签解析出的原批号，因此正文可自洽，
    # 但结构化 batch.lot 必须被定位为不一致。


def test_trailing_space_is_character_significant_in_review() -> None:
    spaced = valid_document(label_raw=LABEL_SPACED)
    assert spaced["batch"]["lot"] == "INK2407 "
    status, body = _review(spaced)
    assert status == 200
    assert body["content_consistent"] is True

    spaced["batch"]["lot"] = "INK2407"  # 删除一个尾随空格就是两个批号
    status, body = _review(spaced)
    assert status == 200
    mismatch = next(item for item in body["mismatches"] if item["field"] == "batch.lot")
    assert mismatch["expected"] == "INK2407 "
    assert mismatch["actual"] == "INK2407"

    # 反向：无空格单伪称带空格批号也必须定位。
    plain = valid_document(label_raw=LABEL_OK)
    plain["batch"]["lot"] = "INK2407 "
    _, body = _review(plain)
    mismatch = next(item for item in body["mismatches"] if item["field"] == "batch.lot")
    assert mismatch["expected"] == "INK2407"
    assert mismatch["actual"] == "INK2407 "


def test_text_is_rebuilt_from_id_time_recalculated_fields_and_label_snapshot() -> None:
    doc = valid_document()
    original_lines = doc["text"].split("\n")
    doc["text"] = "\n".join(
        line.replace("ΔE00=1.26", "ΔE00=9.99") if line.startswith("ΔE00=") else line
        for line in original_lines
    )

    status, body = _review(doc)
    assert status == 200
    mismatch = next(item for item in body["mismatches"] if item["field"] == "text.lines[6]")
    assert mismatch["line"] == 6
    assert mismatch["column"] == 6
    assert mismatch["expected"].startswith("ΔE00=1.26")
    assert mismatch["actual"].startswith("ΔE00=9.99")


def test_text_label_line_change_reports_exact_line_and_column() -> None:
    doc = valid_document()
    lines = doc["text"].split("\n")
    lines[12] = lines[12].replace("INK2407", "INK2408")
    doc["text"] = "\n".join(lines)

    _, body = _review(doc)
    mismatch = next(item for item in body["mismatches"] if item["field"] == "text.lines[13]")
    assert mismatch["line"] == 13
    # "(01)09506000134352(10)" 共 22 列，批号第 7 个字符开始不同（第 29 列）
    assert mismatch["column"] == 29
    assert mismatch["expected"] == LABEL_OK
    assert mismatch["actual"] == LABEL_OK.replace("INK2407", "INK2408")


def test_metadata_id_and_time_mismatches_are_located() -> None:
    doc = valid_document()
    original_generated = doc["generated_at"]
    current_second = int(original_generated[17:19])
    changed_second = 1 if current_second != 1 else 2
    doc["generated_at"] = original_generated[:17] + f"{changed_second:02d}Z"
    expected_time = original_generated

    _, body = _review(doc)
    fields = _fields(body["mismatches"])
    assert "generated_at" in fields
    mismatch = next(item for item in body["mismatches"] if item["field"] == "generated_at")
    assert mismatch["expected"] == expected_time

    # 使用被改的新时间重建正文，所以正文第二行不一致；编号行仍使用原编号。
    assert "text.lines[2]" in fields
    assert not any(item["field"] == "text.lines[1]" for item in body["mismatches"])


def test_multi_field_tamper_reports_all_positions_in_one_snapshot() -> None:
    doc = valid_document()
    doc["standard"]["L"] = 61
    doc["batch"]["gtin"] = "09506000134353"
    doc["text"] = doc["text"] + "\n额外一行"

    _, body = _review(doc)
    fields = _fields(body["mismatches"])
    # Lab 原值改动造成多个判定字段变化
    assert any(field.startswith("result.") for field in fields)
    # 标签未改，GTIN 伪称无法从原文解析得到
    assert "batch.gtin" in fields
    # 正文多出一行
    assert "text.lines[15]" in fields
    assert body["mismatch_count"] == len(body["mismatches"]) > 3


def test_invalid_label_in_duplicate_cannot_be_self_consistent() -> None:
    doc = valid_document()
    doc["label_raw"] = f"(01){GTIN[:-1]}3(10)INK2407(17)280930"

    _, body = _review(doc)
    assert body["content_consistent"] is False
    assert body["recalculated"]["label_check"]["error"]["code"] == "invalid_checksum"
    mismatch = next(item for item in body["mismatches"] if item["field"] == "label_raw")
    assert mismatch["position"] == 17
    assert any(item["field"] == "document" for item in body["mismatches"])


def test_import_failure_requires_exact_fields_and_types() -> None:
    valid = valid_document()

    cases: list[tuple[str, Any, str]] = [
        ("missing result", {k: v for k, v in valid.items() if k != "result"}, "result"),
        ("extra signature", {**valid, "signature": "abc"}, "signature"),
        ("id number", {**valid, "id": 123}, "id"),
        ("lab string", {**valid, "standard": {**valid["standard"], "L": "60.2"}}, "standard.L"),
        ("lab bool", {**valid, "sample": {**valid["sample"], "b": True}}, "sample.b"),
        ("passed string", {**valid, "result": {**valid["result"], "passed": "true"}}, "result.passed"),
        ("empty label", {**valid, "label_raw": ""}, "label_raw"),
    ]
    for name, payload, field in cases:
        status, body = _review(payload)
        assert status == 422, name
        assert body["ok"] is False
        assert "导入失败" in body["message"]
        assert any(err["field"] == field for err in body["errors"]), (name, body["errors"])
        assert "recalculated" not in body
        assert "imported_snapshot" not in body


def test_non_object_and_non_finite_json_are_import_errors() -> None:
    for payload in ([], "x", 123, None):
        status, body = _review(payload)
        assert status == 422, payload
        assert any(err["field"] == "body" for err in body["errors"])

    doc = valid_document()
    doc["result"]["delta_e00"] = "Infinity"  # 字符串类型错误；真正 1e999 由 JSON 拒绝
    status, body = _review(doc)
    assert status == 422
    assert any(err["field"] == "result.delta_e00" for err in body["errors"])


def test_review_does_not_change_existing_release_or_independent_endpoints() -> None:
    release = client.post(
        "/api/batch-release",
        json={"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_OK},
    ).json()["release"]

    tampered = copy.deepcopy(release)
    tampered["batch"]["lot"] = "OTHER"
    review_status, review_body = _review(tampered)
    assert review_status == 200
    assert review_body["content_consistent"] is False

    # 复核是只读入口：再次获取同一服务端新签发响应（重新 POST 仅用于规则对照），
    # 既有独立端点契约与状态码均不变。
    assert client.post(
        "/api/delta-e", json={"standard": PASS_STD, "sample": PASS_SPL}
    ).status_code == 200
    assert client.post("/api/gs1-label", json={"raw": LABEL_OK}).status_code == 200
    fresh = client.post(
        "/api/batch-release",
        json={"standard": PASS_STD, "sample": PASS_SPL, "label_raw": LABEL_OK},
    ).json()["release"]
    assert fresh["batch"]["lot"] == "INK2407"
