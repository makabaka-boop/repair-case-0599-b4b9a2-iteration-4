"""放行单复核入口（交接班）测试。

覆盖：
* 真实签发的放行单 → 内容自洽，但**永远**未鉴真（无服务端签名，不冒称鉴真）；
* 数值篡改（未舍入 ΔE00 / 两位小数 / passed / relation / 超出量 / 阈值）逐项定位；
* 批号 / GTIN / 失效日期篡改与尾随空格（INK2407 vs INK2407␠）批次不一致；
* 内嵌标签原文损坏（校验位等）→ 重新解析失败被定位，且触发组合规则与正文不一致；
* 正文篡改定位到首个差异行/列；编号、时间格式与相互一致性；多字段同时篡改；
* 结构非法（缺字段 / 类型错 / bool 被整数顶替 / NaN / 越界 / 空串 / 多余字段）→ 422；
* 复核只读导入快照：不调用签发流程，既有三个入口行为不变。
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app
from app.release import LabSnapshot, evaluate_batch_release

client = TestClient(app)

PASS_STD = LabSnapshot(60.2574, -34.0099, 36.2677)
PASS_SPL = LabSnapshot(60.4626, -34.1751, 39.4387)
GTIN = "09506000134352"
LABEL_OK = f"(01){GTIN}(10)INK2407(17)280930"
LABEL_BAD_CHECK = f"(01){GTIN[:-1]}3(10)INK2407(17)280930"


def _genuine_doc(label_raw: str = LABEL_OK) -> dict:
    body = evaluate_batch_release(PASS_STD, PASS_SPL, label_raw)
    assert body["released"] is True and body["release"] is not None
    return body["release"]


def _review(doc: object) -> tuple[int, dict]:
    res = client.post("/api/release-review", json=doc)
    return res.status_code, res.json()


def _mismatch_fields(body: dict, check: str | None = None) -> list[str]:
    return [
        m["field"]
        for m in body["checks"]["mismatches"]
        if check is None or m["check"] == check
    ]


# ── 真实单据：自洽且明确不鉴真 ──────────────────────────────────────────

def test_genuine_document_is_self_consistent_but_never_authenticated() -> None:
    status, body = _review(_genuine_doc())
    assert status == 200
    assert body["ok"] is True
    assert body["content_self_consistent"] is True
    assert body["checks"]["failed"] == []
    assert body["checks"]["passed"] == [
        "meta", "color", "label", "release_rule", "text"
    ]
    # 关键区分：内容自洽 ≠ 签发来源真实
    assert body["source_authentic"] is False
    assert body["authentication"]["authenticated"] is False
    assert body["authentication"]["signed"] is False
    assert "签名" in body["authentication"]["message"]


def test_scan_format_and_trailing_space_documents_are_self_consistent() -> None:
    scan = f"01{GTIN}10INK2407\x1d17280930"
    assert _review(_genuine_doc(scan))[1]["content_self_consistent"] is True
    spaced = f"(01){GTIN}(10)INK2407 (17)280930"
    body = _review(_genuine_doc(spaced))[1]
    assert body["content_self_consistent"] is True
    # 复算批次保留尾随空格（逐字符身份）
    assert body["recomputed"]["batch"]["lot"] == "INK2407 "


def test_imported_snapshot_is_verbatim_echo_of_the_payload() -> None:
    doc = _genuine_doc()
    body = _review(doc)[1]
    assert body["imported"] == {
        "id": doc["id"],
        "generated_at": doc["generated_at"],
        "standard": doc["standard"],
        "sample": doc["sample"],
        "label_raw": doc["label_raw"],
        "batch": doc["batch"],
        "text": doc["text"],
    }
    # 复算结果与内嵌结果在自洽单据上逐项一致
    for key in (
        "delta_e00", "delta_e00_round", "threshold", "passed",
        "excess_raw", "excess_round", "relation",
    ):
        assert body["recomputed"]["color"][key] == doc["result"][key]
    assert body["recomputed"]["text"] == doc["text"]


# ── 色差数值篡改：复算逐项定位 ──────────────────────────────────────────

def test_delta_e00_numeric_tamper_is_located() -> None:
    doc = _genuine_doc()
    for key, fake in (
        ("delta_e00", 9.99),
        ("delta_e00_round", 9.99),
        ("excess_raw", 1.0),
        ("excess_round", 1.0),
        ("threshold", 3.0),
    ):
        tampered = {**doc, "result": {**doc["result"], key: fake}}
        body = _review(tampered)[1]
        assert body["content_self_consistent"] is False
        assert f"result.{key}" in _mismatch_fields(body, "color"), key
        # 复算值随响应返回，便于接班调色员核对
        mm = next(
            m for m in body["checks"]["mismatches"] if m["field"] == f"result.{key}"
        )
        assert mm["embedded"] == fake
        assert mm["recomputed"] != fake
    # 仍不鉴真
    assert body["source_authentic"] is False


def test_passed_and_relation_tamper_are_located() -> None:
    doc = _genuine_doc()
    tampered = {
        **doc,
        "result": {**doc["result"], "passed": False, "relation": ">"},
    }
    body = _review(tampered)[1]
    assert set(_mismatch_fields(body, "color")) == {
        "result.passed", "result.relation"
    }
    assert "color" in body["checks"]["failed"]
    # 声称超差但 Lab 复算放行：组合放行规则本身仍成立（双项通过），不产生规则不一致
    assert "release_rule" not in body["checks"]["failed"]


def test_lab_values_are_recomputed_not_trusted() -> None:
    """只改 Lab 原值（声称字段不动）：复算 ΔE00 与全部声称字段对不上。"""
    doc = _genuine_doc()
    tampered = {**doc, "sample": {**doc["sample"], "b": 10.0}}
    body = _review(tampered)[1]
    assert body["content_self_consistent"] is False
    fields = _mismatch_fields(body, "color")
    assert "result.delta_e00" in fields
    assert "result.passed" in fields
    # 重建正文同样依赖复算值 → 正文不一致
    assert "text" in body["checks"]["failed"]


# ── 批号 / 标签篡改：重新解析 GS1 并逐字符比对 ───────────────────────────

def test_batch_field_tamper_is_located() -> None:
    doc = _genuine_doc()
    for key, fake in (
        ("gtin", "09506000134353"),
        ("lot", "INK9999"),
        ("expires", "2030-01-01"),
    ):
        body = _review({**doc, "batch": {**doc["batch"], key: fake}})[1]
        assert f"batch.{key}" in _mismatch_fields(body, "label"), key
        assert body["content_self_consistent"] is False
        # 声称批次被原样保留在不一致明细里
        mm = next(
            m for m in body["checks"]["mismatches"] if m["field"] == f"batch.{key}"
        )
        assert mm["embedded"] == fake
        assert mm["recomputed"] != fake


def test_trailing_space_in_label_raw_is_a_distinct_batch() -> None:
    """INK2407 与 INK2407␠ 是两个批号：给无空格单据塞入带空格原文必被定位。"""
    plain = _genuine_doc(LABEL_OK)
    tampered = {**plain, "label_raw": f"(01){GTIN}(10)INK2407 (17)280930"}
    body = _review(tampered)[1]
    assert body["content_self_consistent"] is False
    mm = next(
        m for m in body["checks"]["mismatches"] if m["field"] == "batch.lot"
    )
    assert mm["embedded"] == "INK2407"
    assert mm["recomputed"] == "INK2407 "
    # 正文批号行与标签原文快照也随之不一致
    assert "text" in body["checks"]["failed"]

    # 反向：带空格单据塞入无空格原文同样不自洽
    spaced = _genuine_doc(f"(01){GTIN}(10)INK2407 (17)280930")
    body2 = _review({**spaced, "label_raw": LABEL_OK})[1]
    mm2 = next(
        m for m in body2["checks"]["mismatches"] if m["field"] == "batch.lot"
    )
    assert mm2["embedded"] == "INK2407 "
    assert mm2["recomputed"] == "INK2407"


def test_corrupted_label_raw_fails_reparse_and_release_rule() -> None:
    """内嵌标签原文损坏（校验位错）：单据却声称批次有效并已签发。"""
    doc = _genuine_doc()
    body = _review({**doc, "label_raw": LABEL_BAD_CHECK})[1]
    label_mm = next(m for m in body["checks"]["mismatches"] if m["check"] == "label")
    assert label_mm["field"] == "label_raw"
    assert label_mm["recomputed"] == {"code": "invalid_checksum", "position": 17}
    # 重新解析失败 ⇒ 按组合规则这张单子本不该存在；正文无法在同一批次上重建
    assert "release_rule" in body["checks"]["failed"]
    assert "text" in body["checks"]["failed"]


# ── 正文与元数据篡改 ────────────────────────────────────────────────────

def test_text_tamper_is_located_to_line_and_column() -> None:
    doc = _genuine_doc()
    tampered = {**doc, "text": doc["text"].replace("ΔE00=1.26", "ΔE00=9.99", 1)}
    body = _review(tampered)[1]
    assert body["content_self_consistent"] is False
    mm = next(m for m in body["checks"]["mismatches"] if m["check"] == "text")
    pos = mm["position"]
    # 第 6 行色差结论，首个差异是被改出的 9（内嵌）对复算的 1
    assert pos["line"] == 6
    assert pos["embedded"] == "9"
    assert pos["recomputed"] == "1"
    # 复算正文完整返回，可与原文并排核对
    assert body["recomputed"]["text"] == doc["text"]


def test_meta_tamper_id_and_time_format() -> None:
    doc = _genuine_doc()
    body = _review({**doc, "id": "REL-FAKE-ID"})[1]
    assert "id" in _mismatch_fields(body, "meta")
    # 正文首行仍写着原编号，与（被改的）单据自身编号重建出的首行对不上：
    # 这正是“编号与正文互相矛盾”的逐字符定位，不是元数据格式问题被吞掉
    text_mm = next(m for m in body["checks"]["mismatches"] if m["check"] == "text")
    assert text_mm["position"]["line"] == 1

    # 时间格式坏：正文第二行与批次无关，仍独立报告元数据不一致
    body2 = _review({**doc, "generated_at": "2026/09/30 10:00:00"})[1]
    assert "generated_at" in _mismatch_fields(body2, "meta")
    assert any(m["position"]["line"] == 2 for m in body2["checks"]["mismatches"]
               if m["check"] == "text")

    # 编号与时间各自合法但互相不一致（正文恰好同时使用二者，仍逐字符一致）
    import copy
    coherent = copy.deepcopy(doc)
    coherent["id"] = "REL-20200101T000000Z-00000000"
    coherent["generated_at"] = "2020-01-01T00:00:00Z"
    body3 = _review(coherent)[1]
    assert "id/generated_at" not in _mismatch_fields(body3, "meta")
    # 原始单据时间与编号相互绑定：只改时间不改编号即互相矛盾
    body4 = _review({**doc, "generated_at": "2020-01-01T00:00:00Z"})[1]
    assert "id/generated_at" in _mismatch_fields(body4, "meta")


def test_multifield_tamper_reports_every_location() -> None:
    """色差数值、批号与正文同时被改：每一处都在结论里单独定位。"""
    doc = _genuine_doc()
    tampered = {
        **doc,
        "result": {**doc["result"], "delta_e00_round": 5.55},
        "batch": {**doc["batch"], "lot": "INK7777"},
        "text": doc["text"].replace("INK2407", "INK7777"),
    }
    body = _review(tampered)[1]
    fields = _mismatch_fields(body)
    assert "result.delta_e00_round" in fields
    assert "batch.lot" in fields
    assert "text" in fields
    assert set(body["checks"]["failed"]) >= {"color", "label", "text"}
    assert body["content_self_consistent"] is False


def test_claim_release_on_failing_color_contradicts_rule() -> None:
    """单据内嵌的是超差色对却顶着一张放行单：复算超差 ⇒ 组合规则不一致。

    手工构造一张结构合法但自相矛盾的复制件（真实签发流程永远不会产生它）。
    """
    doc = _genuine_doc()
    tampered = {
        **doc,
        "standard": {"L": 50.0, "a": 2.6772, "b": -79.7751},
        "sample": {"L": 50.0, "a": 0.0, "b": -82.7485},
    }
    body = _review(tampered)[1]
    assert "release_rule" in body["checks"]["failed"]
    rule_mm = next(
        m for m in body["checks"]["mismatches"] if m["check"] == "release_rule"
    )
    assert "超差" in rule_mm["message"]


# ── 结构非法：HTTP 422 整次拒绝，不产生复核结论 ─────────────────────────

def test_missing_required_fields_are_422() -> None:
    for partial, field in (
        ({"id": "REL-x"}, "generated_at"),
        (_without("standard"), "standard"),
        (_without("sample"), "sample"),
        (_without("result"), "result"),
        (_without("batch"), "batch"),
        (_without("label_raw"), "label_raw"),
        (_without("text"), "text"),
    ):
        res = client.post("/api/release-review", json=partial)
        assert res.status_code == 422, field
        assert any(e["field"].split(".")[0] == field for e in res.json()["errors"]), field


def _without(key: str) -> dict:
    doc = _genuine_doc()
    doc.pop(key)
    return doc


def test_wrong_types_are_422() -> None:
    doc = _genuine_doc()
    cases = [
        {**doc, "id": 123},
        {**doc, "standard": {"L": "60.2", "a": -34.0, "b": 36.0}},
        {**doc, "sample": [60.0, -34.0, 39.0]},
        {**doc, "result": {**doc["result"], "passed": 1}},
        {**doc, "result": {**doc["result"], "passed": "yes"}},
        {**doc, "result": {**doc["result"], "delta_e00": "1.26"}},
        {**doc, "batch": {**doc["batch"], "gtin": 9506000134352}},
        {**doc, "batch": {"gtin": GTIN, "lot": "INK2407"}},  # 缺 expires
        ["not", "an", "object"],
    ]
    for bad in cases:
        res = client.post("/api/release-review", json=bad)
        assert res.status_code == 422, bad


def test_non_finite_and_out_of_range_lab_are_422() -> None:
    doc = _genuine_doc()
    raw_body = json.dumps({**doc, "standard": {"L": float("nan"), "a": 0, "b": 0}},
                          allow_nan=True)
    res = client.post(
        "/api/release-review", content=raw_body,
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 422
    assert any(e["field"] == "standard.L" for e in res.json()["errors"])

    for patch in (
        {"standard": {"L": 200, "a": 0, "b": 0}},
        {"sample": {"L": 50, "a": -200, "b": 0}},
        {"standard": {"L": -0.1, "a": 0, "b": 0}},
    ):
        res = client.post("/api/release-review", json={**doc, **patch})
        assert res.status_code == 422, patch


def test_empty_strings_extra_fields_are_422() -> None:
    doc = _genuine_doc()
    for bad in (
        {**doc, "id": ""},
        {**doc, "generated_at": ""},
        {**doc, "label_raw": ""},
        {**doc, "text": ""},
        {**doc, "batch": {**doc["batch"], "lot": ""}},
        {**doc, "signature": "pretend"},
        {**doc, "result": {**doc["result"], "extra": 1}},
    ):
        res = client.post("/api/release-review", json=bad)
        assert res.status_code == 422, bad


def test_422_body_does_not_contain_review_verdict() -> None:
    res = client.post("/api/release-review", json={"id": "x"})
    body = res.json()
    assert body["ok"] is False
    assert "content_self_consistent" not in body
    assert "checks" not in body
    assert body["errors"]  # 字段明细存在


# ── 入口独立性：不签发、不改写，既有入口不变 ─────────────────────────────

def test_review_does_not_issue_or_mutate_release() -> None:
    doc = _genuine_doc()
    before_id = doc["id"]
    # 篡改件照样复核，但响应里不出现任何新编号/新凭据字段
    body = _review({**doc, "batch": {**doc["batch"], "lot": "INK9999"}})[1]
    assert body["imported"]["id"] == before_id
    assert "release" not in body
    # 原 dict 未被复核过程修改
    assert doc["batch"]["lot"] == "INK2407"


def test_existing_endpoints_unchanged() -> None:
    assert client.post(
        "/api/delta-e",
        json={
            "standard": {"L": 60.2574, "a": -34.0099, "b": 36.2677},
            "sample": {"L": 60.4626, "a": -34.1751, "b": 39.4387},
        },
    ).status_code == 200
    assert client.post("/api/gs1-label", json={"raw": LABEL_OK}).status_code == 200
    body = client.post(
        "/api/batch-release",
        json={
            "standard": {"L": 60.2574, "a": -34.0099, "b": 36.2677},
            "sample": {"L": 60.4626, "a": -34.1751, "b": 39.4387},
            "label_raw": LABEL_OK,
        },
    ).json()
    assert body["released"] is True
