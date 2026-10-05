import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseReviewPanel } from "./ReleaseReviewPanel";
import type { ReleaseReviewResponse } from "./types";

/**
 * 放行单复核面板（组件级，fetch 打桩为真实 /api/release-review 契约）。
 * 覆盖：自洽但永不鉴真、数值/批号/标签空格/正文/多字段篡改逐项展示、
 * JSON 语法失败与 422 不产生结论、复核固定于导入快照（编辑/迟到响应不改写）、
 * 以及与放行单填写表单的状态隔离。
 */

const PASS_RESULT = {
  delta_e00: 1.2643671,
  delta_e00_round: 1.26,
  threshold: 2.0,
  passed: true,
  excess_raw: 0.0,
  excess_round: 0.0,
  relation: "<=" as const,
};

const DOC_ID = "REL-20260930T100000Z-ab12cd34";
const GENERATED_AT = "2026-09-30T10:00:00Z";
const LABEL_OK = "(01)09506000134352(10)INK2407(17)280930";
const GTIN = "09506000134352";

function genuineText(lot = "INK2407", labelRaw = LABEL_OK, delta = "1.26") {
  return [
    `批次放行单 ${DOC_ID}`,
    `生成时间（UTC）：${GENERATED_AT}`,
    "── 色差核验（CIEDE2000，阈值 2.00，未舍入值判定）──",
    "标准色：L*=60.2574 a*=-34.0099 b*=36.2677",
    "首张样张：L*=60.4626 a*=-34.1751 b*=39.4387",
    `ΔE00=${delta}（未舍入 1.264367）<= 2.00：✅ 放行`,
    "── 标签核验（GS1 AI 01/10/17）──",
    `商品编码 GTIN：${GTIN}`,
    `批号（逐字符快照）：${lot}`,
    "失效日期：2028-09-30",
    "标签原文快照（开始/结束）：",
    ">>>",
    labelRaw,
    "<<<",
  ].join("\n");
}

interface DocOpts {
  result?: typeof PASS_RESULT;
  batch?: { gtin: string; lot: string; expires: string };
  labelRaw?: string;
  text?: string;
  id?: string;
  generatedAt?: string;
}

function genuineDoc(opts: DocOpts = {}) {
  const {
    result = PASS_RESULT,
    batch = { gtin: GTIN, lot: "INK2407", expires: "2028-09-30" },
    labelRaw = LABEL_OK,
    text = genuineText(batch.lot, labelRaw),
    id = DOC_ID,
    generatedAt = GENERATED_AT,
  } = opts;
  return {
    id,
    generated_at: generatedAt,
    standard: { L: 60.2574, a: -34.0099, b: 36.2677 },
    sample: { L: 60.4626, a: -34.1751, b: 39.4387 },
    result,
    batch,
    label_raw: labelRaw,
    text,
  };
}

function reviewResponse(
  doc: ReturnType<typeof genuineDoc>,
  mismatches: ReleaseReviewResponse["checks"]["mismatches"] = [],
): ReleaseReviewResponse {
  const failed = Array.from(new Set(mismatches.map((m) => m.check)));
  const allChecks = ["meta", "color", "label", "release_rule", "text"] as const;
  const passed = allChecks.filter((c) => !failed.includes(c));
  // 复算批次：若有标签不一致，按测试场景给出复算值
  const labelMismatch = mismatches.find((m) => m.check === "label");
  const recomputedBatch =
    labelMismatch && typeof labelMismatch.recomputed !== "object"
      ? null
      : doc.batch;
  const textMismatch = mismatches.find((m) => m.check === "text");
  return {
    ok: true,
    content_self_consistent: mismatches.length === 0,
    source_authentic: false,
    authentication: {
      authenticated: false,
      signed: false,
      message:
        "未鉴真：本系统放行单不含服务端签名，复制件无法证明签发来源；以下结论仅表示单据内嵌原值与自身声称内容是否自洽。",
    },
    checks: {
      passed: [...passed],
      failed: [...failed],
      mismatches,
    },
    recomputed: {
      color: PASS_RESULT,
      batch: recomputedBatch,
      text: textMismatch ? doc.text : doc.text,
    },
    imported: {
      id: doc.id,
      generated_at: doc.generated_at,
      standard: { ...doc.standard },
      sample: { ...doc.sample },
      label_raw: doc.label_raw,
      batch: { ...doc.batch },
      text: doc.text,
    },
  };
}

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockResponse(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
) {
  (globalThis.fetch as FetchMock).mockImplementation(impl);
}

async function importDoc(
  user: ReturnType<typeof userEvent.setup>,
  doc: unknown,
) {
  // JSON 内含 {} 等字符，userEvent.type 会把它们当成组合键描述符；
  // 用 fireEvent.change 直接改受控 textarea 的 value，等效于粘贴整段 JSON。
  const textarea = screen.getByTestId("review-json") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: JSON.stringify(doc) } });
  await user.click(screen.getByTestId("review-submit"));
}

/** 直接写入复核 JSON 框（不提交），用于测试本地语法拦截。 */
function writeReviewJson(text: string) {
  fireEvent.change(screen.getByTestId("review-json"), { target: { value: text } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("放行单复核：自洽与鉴真", () => {
  it("初始无结论；空输入禁用提交按钮", () => {
    render(<ReleaseReviewPanel />);
    expect(screen.queryByTestId("review-report")).not.toBeInTheDocument();
    expect(screen.getByTestId("review-submit")).toBeDisabled();
  });

  it("真实复制件：内容自洽，五个检查全过，但恒定未鉴真", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc();
    mockResponse(async () => jsonResponse(200, reviewResponse(doc)));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);

    const report = await screen.findByTestId("review-report");
    const consistency = within(report).getByTestId("review-consistency");
    expect(consistency).toHaveAttribute("data-consistent", "true");
    expect(consistency).toHaveTextContent("内容自洽");
    // 鉴真独立、恒定为否，不冒称已鉴真
    const auth = within(report).getByTestId("review-auth");
    expect(auth).toHaveAttribute("data-authenticated", "false");
    expect(auth).toHaveTextContent("未鉴真");
    expect(auth).toHaveTextContent("签名");
    expect(screen.getByTestId("review-check-meta")).toHaveAttribute(
      "data-failed",
      "false",
    );
    expect(screen.getByTestId("review-check-text")).toHaveAttribute(
      "data-failed",
      "false",
    );
    expect(screen.queryByTestId("review-mismatch")).not.toBeInTheDocument();
    // 请求只发往复核端点
    const [url] = (globalThis.fetch as FetchMock).mock.calls[0];
    expect(url).toBe("/api/release-review");
  });
});

describe("放行单复核：逐项指出不一致", () => {
  it("数值篡改（ΔE00）：定位 result.delta_e00，并排展示声称值与复算值", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc();
    const resp = reviewResponse(doc, [
      {
        check: "color",
        field: "result.delta_e00",
        embedded: 9.99,
        recomputed: 1.2643671,
        message: "内嵌 Lab 复算的未舍入 ΔE00与单据声称不一致",
      },
      {
        check: "color",
        field: "result.passed",
        embedded: false,
        recomputed: true,
        message: "内嵌 Lab 复算的放行判定与单据声称不一致",
      },
    ]);
    mockResponse(async () => jsonResponse(200, resp));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);

    const report = await screen.findByTestId("review-report");
    expect(
      within(report).getByTestId("review-consistency"),
    ).toHaveAttribute("data-consistent", "false");
    expect(screen.getByTestId("review-check-color")).toHaveAttribute(
      "data-failed",
      "true",
    );
    expect(screen.getByTestId("review-check-text")).toHaveAttribute(
      "data-failed",
      "false",
    );
    const fields = screen
      .getAllByTestId("review-mismatch-field")
      .map((n) => n.textContent);
    expect(fields).toContain("result.delta_e00");
    expect(fields).toContain("result.passed");
    // 仍然未鉴真
    expect(within(report).getByTestId("review-auth")).toHaveTextContent("未鉴真");
  });

  it("批号篡改：定位 batch.lot，单据声称批号与复算批号并排", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc({
      batch: { gtin: GTIN, lot: "INK9999", expires: "2028-09-30" },
      text: genuineText("INK9999"),
    });
    const resp = reviewResponse(doc, [
      {
        check: "label",
        field: "batch.lot",
        embedded: "INK9999",
        recomputed: "INK2407",
        message: "内嵌标签原文重新解析出的lot与单据声称批次不一致",
      },
    ]);
    resp.recomputed.batch = { gtin: GTIN, lot: "INK2407", expires: "2028-09-30" };
    mockResponse(async () => jsonResponse(200, resp));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);

    await screen.findByTestId("review-report");
    expect(screen.getByTestId("review-check-label")).toHaveAttribute(
      "data-failed",
      "true",
    );
    expect(screen.getByTestId("review-mismatch-field")).toHaveTextContent(
      "batch.lot",
    );
    // 快照声称批号（带篡改值）与复算批号同时可见
    expect(screen.getByTestId("review-snapshot-lot")).toHaveTextContent("INK9999");
    expect(screen.getByTestId("review-recomputed-lot")).toHaveTextContent("INK2407");
  });

  it("尾随空格：INK2407 与 INK2407␠ 是两个批号，空格显式展示", async () => {
    const user = userEvent.setup();
    const withSpace = "(01)09506000134352(10)INK2407 (17)280930";
    // 单据声称无空格，但内嵌原文实际带空格 → 复算批号带尾随空格
    const doc = genuineDoc({ labelRaw: withSpace, text: genuineText("INK2407", withSpace) });
    const resp = reviewResponse(doc, [
      {
        check: "label",
        field: "batch.lot",
        embedded: "INK2407",
        recomputed: "INK2407 ",
        message: "内嵌标签原文重新解析出的lot与单据声称批次不一致",
      },
    ]);
    resp.recomputed.batch = { gtin: GTIN, lot: "INK2407 ", expires: "2028-09-30" };
    mockResponse(async () => jsonResponse(200, resp));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);

    await screen.findByTestId("review-report");
    expect(screen.getByTestId("review-recomputed-lot")).toHaveTextContent("INK2407␠");
  });

  it("正文篡改：显示行/列定位与重建正文", async () => {
    const user = userEvent.setup();
    const tamperedText = genuineText().replace("ΔE00=1.26", "ΔE00=9.99");
    const doc = genuineDoc({ text: tamperedText });
    const resp = reviewResponse(doc, [
      {
        check: "text",
        field: "text",
        embedded: tamperedText,
        recomputed: genuineText(),
        message:
          "可读正文与按单据编号/时间/复算字段重建的正文不一致：首个差异在第 6 行第 6 列（character）",
        position: {
          line: 6,
          column: 6,
          kind: "character",
          embedded: "9",
          recomputed: "1",
        },
      },
    ]);
    resp.recomputed.text = genuineText();
    mockResponse(async () => jsonResponse(200, resp));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);

    await screen.findByTestId("review-report");
    expect(screen.getByTestId("review-check-text")).toHaveAttribute(
      "data-failed",
      "true",
    );
    expect(screen.getByTestId("review-mismatch-position")).toHaveTextContent(
      "第 6 行第 6 列",
    );
    const rebuilt = screen.getByTestId("review-rebuilt-text") as HTMLTextAreaElement;
    expect(rebuilt.value).toContain("ΔE00=1.26");
    expect(rebuilt.value).not.toContain("ΔE00=9.99");
  });

  it("标签原文损坏：重新解析失败、组合规则不一致、正文不可重建", async () => {
    const user = userEvent.setup();
    const bad = "(01)09506000134353(10)INK2407(17)280930";
    const doc = genuineDoc({ labelRaw: bad });
    const resp = reviewResponse(doc, [
      {
        check: "label",
        field: "label_raw",
        embedded: bad,
        recomputed: { code: "invalid_checksum", position: 17 },
        message: "内嵌标签原文重新解析失败（invalid_checksum，位置 17）",
      },
      {
        check: "release_rule",
        field: "release",
        embedded: "存在放行单",
        recomputed: "不应签发",
        message: "组合放行规则不一致：标签原文无法重新解析，单据不应作为放行单存在",
      },
      {
        check: "text",
        field: "text",
        embedded: null,
        recomputed: null,
        message: "标签原文无法重新解析，无法在同一批次基础上重建正文",
      },
    ]);
    resp.recomputed.batch = null;
    resp.recomputed.text = null;
    mockResponse(async () => jsonResponse(200, resp));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);

    const report = await screen.findByTestId("review-report");
    for (const name of ["label", "release_rule", "text"]) {
      expect(
        within(report).getByTestId(`review-check-${name}`),
      ).toHaveAttribute("data-failed", "true");
    }
    expect(screen.getByTestId("review-recomputed-gtin")).toHaveTextContent(
      "无法重新解析",
    );
    expect(
      screen.getByTestId("review-rebuilt-text") as HTMLTextAreaElement,
    ).toHaveValue("（标签无法重新解析，正文不可重建）");
  });

  it("多字段篡改：每处不一致分别列出", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc({
      batch: { gtin: GTIN, lot: "INK7777", expires: "2028-09-30" },
      text: genuineText("INK7777"),
    });
    const resp = reviewResponse(doc, [
      {
        check: "color",
        field: "result.delta_e00_round",
        embedded: 5.55,
        recomputed: 1.26,
        message: "内嵌 Lab 复算的两位小数 ΔE00与单据声称不一致",
      },
      {
        check: "label",
        field: "batch.lot",
        embedded: "INK7777",
        recomputed: "INK2407",
        message: "内嵌标签原文重新解析出的lot与单据声称批次不一致",
      },
      {
        check: "text",
        field: "text",
        embedded: doc.text,
        recomputed: genuineText(),
        message: "可读正文重建不一致",
        position: { line: 9, column: 19, kind: "character", embedded: "7", recomputed: "0" },
      },
    ]);
    resp.recomputed.batch = { gtin: GTIN, lot: "INK2407", expires: "2028-09-30" };
    resp.recomputed.text = genuineText();
    mockResponse(async () => jsonResponse(200, resp));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);

    await screen.findByTestId("review-report");
    expect(screen.getAllByTestId("review-mismatch")).toHaveLength(3);
    expect(screen.getByTestId("review-mismatch-title")).toHaveTextContent("3 处");
  });
});

describe("放行单复核：导入失败不产生结论", () => {
  it("JSON 语法错误：本地拦截、不发请求、无结论", async () => {
    const user = userEvent.setup();
    mockResponse(async () => jsonResponse(200, {}));
    render(<ReleaseReviewPanel />);
    writeReviewJson("{not json");
    await user.click(screen.getByTestId("review-submit"));

    expect(await screen.findByTestId("review-parse-error")).toHaveTextContent(
      "JSON 解析失败",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("review-report")).not.toBeInTheDocument();
  });

  it("顶层是数组：本地拦截不发请求", async () => {
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    writeReviewJson("[1,2,3]");
    await user.click(screen.getByTestId("review-submit"));
    expect(await screen.findByTestId("review-parse-error")).toHaveTextContent(
      "JSON 对象",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("422 结构非法：显示字段错误，不产生复核结论", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc();
    mockResponse(async () =>
      jsonResponse(422, {
        ok: false,
        message: "输入校验失败，整次请求被拒绝（未进行复核）",
        errors: [
          { field: "result.passed", message: "必须是布尔值 true/false" },
        ],
      }),
    );
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);

    const err = await screen.findByTestId("review-request-error");
    expect(err).toHaveTextContent("result.passed");
    expect(screen.queryByTestId("review-report")).not.toBeInTheDocument();
  });

  it("网络异常：明确提示且无结论，稍后重试可成功", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc();
    let call = 0;
    (globalThis.fetch as FetchMock).mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new TypeError("Failed to fetch");
      return jsonResponse(200, reviewResponse(doc));
    });
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);
    const err = await screen.findByTestId("review-request-error");
    expect(err).toHaveTextContent("无法连接");
    expect(screen.queryByTestId("review-report")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("review-submit"));
    expect(await screen.findByTestId("review-report")).toBeInTheDocument();
    expect(screen.queryByTestId("review-request-error")).not.toBeInTheDocument();
  });
});

describe("复核固定于本次导入快照：编辑与迟到响应不能改写", () => {
  it("复核后编辑 JSON：结论保留并出现固定提示，不重新请求也不改写", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc();
    mockResponse(async () => jsonResponse(200, reviewResponse(doc)));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);
    const report = await screen.findByTestId("review-report");
    const idBefore = within(report).getByTestId("review-snapshot-id").textContent;
    expect(screen.queryByTestId("review-draft-dirty")).not.toBeInTheDocument();

    const callsBefore = (globalThis.fetch as FetchMock).mock.calls.length;
    await user.type(screen.getByTestId("review-json"), "{Backspace}");
    const dirty = await screen.findByTestId("review-draft-dirty");
    expect(dirty).toHaveTextContent("固定于本次导入快照");
    // 结论未被改写
    expect(within(report).getByTestId("review-snapshot-id").textContent).toBe(
      idBefore,
    );
    // 编辑本身不触发请求
    expect((globalThis.fetch as FetchMock).mock.calls.length).toBe(callsBefore);
  });

  it("迟到的旧响应不得覆盖更新一次导入的复核结论", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc();
    const tamperedDoc = genuineDoc({
      batch: { gtin: GTIN, lot: "INK9999", expires: "2028-09-30" },
      text: genuineText("INK9999"),
    });
    const tamperedResp = reviewResponse(tamperedDoc, [
      {
        check: "label",
        field: "batch.lot",
        embedded: "INK9999",
        recomputed: "INK2407",
        message: "批号不一致",
      },
    ]);
    tamperedResp.recomputed.batch = {
      gtin: GTIN,
      lot: "INK2407",
      expires: "2028-09-30",
    };

    const firstReq = deferred<Response>();
    let call = 0;
    mockResponse(async (_url, init) => {
      call += 1;
      const body = JSON.parse(String(init?.body)) as { batch: { lot: string } };
      if (call === 1) return firstReq.promise;
      expect(body.batch.lot).toBe("INK9999");
      return jsonResponse(200, tamperedResp);
    });

    render(<ReleaseReviewPanel />);
    await importDoc(user, doc); // 第 1 次导入挂起
    await importDoc(user, tamperedDoc); // 第 2 次导入立即落地

    await screen.findByText("批号不一致");
    expect(screen.getAllByTestId("review-mismatch")).toHaveLength(1);
    expect(screen.getByTestId("review-snapshot-lot")).toHaveTextContent("INK9999");

    // 第 1 次（自洽）响应迟到：必须丢弃，不能把“不自洽”结论改回自洽
    firstReq.resolve(jsonResponse(200, reviewResponse(doc)));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getAllByTestId("review-mismatch")).toHaveLength(1);
    expect(screen.getByTestId("review-snapshot-lot")).toHaveTextContent("INK9999");
    expect(screen.getByTestId("review-check-label")).toHaveAttribute(
      "data-failed",
      "true",
    );
  });

  it("清空复核：结论、错误、输入全部移除", async () => {
    const user = userEvent.setup();
    const doc = genuineDoc();
    mockResponse(async () => jsonResponse(200, reviewResponse(doc)));
    render(<ReleaseReviewPanel />);
    await importDoc(user, doc);
    await screen.findByTestId("review-report");

    await user.click(screen.getByTestId("review-reset"));
    expect(screen.queryByTestId("review-report")).not.toBeInTheDocument();
    expect(screen.getByTestId("review-json")).toHaveValue("");
    expect(screen.getByTestId("review-submit")).toBeDisabled();
  });
});

describe("复核入口状态隔离", () => {
  it("复核操作不读写新批次放行单表单：生成放行单后再复核，凭据与表单不变", async () => {
    const { BatchReleasePanel } = await import("./BatchReleasePanel");
    const user = userEvent.setup();
    const doc = genuineDoc();
    mockResponse(async (url) => {
      if (url === "/api/release-review") {
        return jsonResponse(200, reviewResponse(doc));
      }
      if (url === "/api/batch-release") {
        // 放行单流程返回自己的契约（这里不展开，仅保证不被复核调用）
        throw new Error("不应在复核测试中调用 batch-release");
      }
      throw new Error(`unexpected ${url}`);
    });
    render(
      <div>
        <BatchReleasePanel />
        <ReleaseReviewPanel />
      </div>,
    );

    // 放行单表单保持初始空值
    expect(screen.getByTestId("release.standard.L")).toHaveValue("");
    // 复核面板独立工作
    await importDoc(user, doc);
    await screen.findByTestId("review-report");
    // 放行单区域无任何凭据/结果产生，表单仍为空
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-outcome")).not.toBeInTheDocument();
    expect(screen.getByTestId("release.standard.L")).toHaveValue("");
    expect(screen.getByTestId("release-label-raw")).toHaveValue("");
    expect(screen.getByTestId("release-submit")).toBeDisabled();
    // 复核请求只打向复核端点
    for (const [url] of (globalThis.fetch as FetchMock).mock.calls) {
      expect(url).toBe("/api/release-review");
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
