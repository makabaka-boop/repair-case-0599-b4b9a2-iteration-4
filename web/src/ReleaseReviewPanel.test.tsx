import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseReviewPanel } from "./ReleaseReviewPanel";
import type {
  DeltaEResult,
  ReleaseReviewSuccessResponse,
  ReviewDocument,
  ReviewMismatch,
} from "./types";

const PASS_PAIR = {
  standard: { L: 60.2574, a: -34.0099, b: 36.2677 },
  sample: { L: 60.4626, a: -34.1751, b: 39.4387 },
};
const GTIN = "09506000134352";
const LABEL_OK = `(01)${GTIN}(10)INK2407(17)280930`;
const LABEL_SPACE = `(01)${GTIN}(10)INK2407 (17)280930`;
const ID = "REL-20260930T100000Z-ab12cd34";
const TIME = "2026-09-30T10:00:00Z";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function verdict(overrides: Partial<DeltaEResult> = {}): DeltaEResult {
  return {
    delta_e00: 1.2643671,
    delta_e00_round: 1.26,
    threshold: 2.0,
    passed: true,
    excess_raw: 0.0,
    excess_round: 0.0,
    relation: "<=",
    ...overrides,
  };
}

function buildText(labelRaw = LABEL_OK, lot = "INK2407"): string {
  return [
    `批次放行单 ${ID}`,
    `生成时间（UTC）：${TIME}`,
    "── 色差核验（CIEDE2000，阈值 2.00，未舍入值判定）──",
    "标准色：L*=60.2574 a*=-34.0099 b*=36.2677",
    "首张样张：L*=60.4626 a*=-34.1751 b*=39.4387",
    "ΔE00=1.26（未舍入 1.264367）<= 2.00：✅ 放行",
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

function makeDoc(overrides: Partial<ReviewDocument> = {}): ReviewDocument {
  return {
    id: ID,
    generated_at: TIME,
    standard: { ...PASS_PAIR.standard },
    sample: { ...PASS_PAIR.sample },
    result: verdict(),
    batch: { gtin: GTIN, lot: "INK2407", expires: "2028-09-30" },
    label_raw: LABEL_OK,
    text: buildText(),
    ...overrides,
  };
}

function mismatch(partial: Partial<ReviewMismatch> & Pick<ReviewMismatch, "field" | "message">): ReviewMismatch {
  return {
    section: "color",
    expected: null,
    actual: null,
    line: null,
    column: null,
    position: null,
    ...partial,
  };
}

function makeReview(
  doc: ReviewDocument,
  mismatches: ReviewMismatch[] = [],
): ReleaseReviewSuccessResponse {
  const consistent = mismatches.length === 0;
  return {
    ok: true,
    review_scope: "content_consistency_only",
    authenticated: false,
    authenticity_status: consistent
      ? "content_consistent_unsigned"
      : "inconsistent_unsigned",
    authenticity_message: consistent
      ? "内容自洽，但本单无服务端签名：未鉴真，不得据此认定签发来源真实。"
      : "内容不自洽，且本单无服务端签名：未鉴真。",
    content_consistent: consistent,
    mismatch_count: mismatches.length,
    mismatches,
    recalculated: {
      color_check: { passed: true, result: verdict() },
      label_check: {
        passed: true,
        parsed: {
          ok: true,
          format: "readable",
          fields: [],
          batch: { ...doc.batch },
        },
      },
      release: {
        id: doc.id,
        generated_at: doc.generated_at,
        standard: { ...doc.standard },
        sample: { ...doc.sample },
        result: verdict(),
        batch: { ...doc.batch },
        label_raw: doc.label_raw,
        text: consistent ? doc.text : null,
      },
    },
    imported_snapshot: doc,
  };
}

async function importJson(
  user: ReturnType<typeof userEvent.setup>,
  doc: unknown,
) {
  const input = screen.getByTestId("release-review-input");
  fireEvent.change(input, { target: { value: JSON.stringify(doc) } });
  await user.click(screen.getByTestId("release-review-import"));
}

function mockResponse(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
) {
  (globalThis.fetch as FetchMock).mockImplementation(impl);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("复制放行单复核", () => {
  it("初始为空；没有 JSON 时不能导入", () => {
    render(<ReleaseReviewPanel />);
    expect(screen.queryByTestId("release-review-result")).not.toBeInTheDocument();
    expect(screen.getByTestId("release-review-import")).toBeDisabled();
  });

  it("有效旧单：只给内容自洽结论，明确未鉴真，不复称为来源真实", async () => {
    const doc = makeDoc();
    mockResponse(async () => jsonResponse(200, makeReview(doc)));
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, doc);

    const result = await screen.findByTestId("release-review-result");
    const auth = within(result).getByTestId("release-review-authenticity");
    expect(auth).toHaveAttribute("data-authenticated", "false");
    expect(within(auth).getByTestId("release-review-consistency")).toHaveTextContent(
      "内容自洽（未鉴真）",
    );
    expect(auth).toHaveTextContent("不得据此认定签发来源真实");
    expect(screen.getByTestId("release-review-no-mismatch")).toBeInTheDocument();
    expect(screen.getByTestId("release-review-rebuilt-text")).toHaveValue(doc.text);
    expect(screen.queryByText(/已鉴真|来源真实✅/)).not.toBeInTheDocument();

    const [url, init] = (globalThis.fetch as FetchMock).mock.calls[0];
    expect(url).toBe("/api/release-review");
    expect(JSON.parse(String(init?.body))).toEqual(doc);
  });

  it("色差复算字段被篡改：展示字段路径、原值/复算值和未鉴真结论", async () => {
    const doc = makeDoc({
      result: verdict({
        delta_e00: 9.99,
        delta_e00_round: 9.99,
        passed: false,
        relation: ">",
        excess_raw: 7.99,
        excess_round: 7.99,
      }),
    });
    const items = [
      mismatch({
        section: "color",
        field: "result.delta_e00",
        message: "内嵌色差判定字段与由两组 Lab 原值复算的结果不一致",
        expected: 1.2643671,
        actual: 9.99,
      }),
      mismatch({ field: "result.passed", message: "判定不一致", expected: true, actual: false }),
    ];
    mockResponse(async () => jsonResponse(200, makeReview(doc, items)));
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, doc);

    expect(await screen.findByTestId("release-review-mismatches")).toBeInTheDocument();
    expect(screen.getByTestId("release-review-consistency")).toHaveTextContent(
      "内容不自洽（未鉴真）",
    );
    expect(screen.getByText("result.delta_e00")).toBeInTheDocument();
    expect(screen.getByText("result.passed")).toBeInTheDocument();
    const item = screen.getByTestId("release-review-mismatch-0");
    expect(item).toHaveTextContent("9.99");
    expect(item).toHaveTextContent("1.2643671");
  });

  it("批号尾随空格被删除：逐字符显示空格差异，不把两个批号视为相同", async () => {
    const doc = makeDoc({
      batch: { gtin: GTIN, lot: "INK2407", expires: "2028-09-30" },
      label_raw: LABEL_SPACE,
      text: buildText(LABEL_SPACE, "INK2407"),
    });
    const items = [
      mismatch({
        section: "label",
        field: "batch.lot",
        message: "内嵌批次字段与由标签原文重新解析的结果不一致",
        expected: "INK2407 ",
        actual: "INK2407",
      }),
    ];
    mockResponse(async () => jsonResponse(200, makeReview(doc, items)));
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, doc);

    const item = await screen.findByTestId("release-review-mismatch-0");
    expect(item).toHaveTextContent("INK2407␠");
    expect(within(item).getByText("batch.lot")).toBeInTheDocument();
  });

  it("正文篡改：展示复算正文及不一致的行、列", async () => {
    const tamperedText = docTextWithLine(6, "ΔE00=9.99（未舍入 1.264367）<= 2.00：✅ 放行");
    const doc = makeDoc({ text: tamperedText });
    const items = [
      mismatch({
        section: "text",
        field: "text.lines[6]",
        message: "正文第 6 行与按单据复算重建的内容不一致（首个差异列 6）",
        expected: "ΔE00=1.26（未舍入 1.264367）<= 2.00：✅ 放行",
        actual: "ΔE00=9.99（未舍入 1.264367）<= 2.00：✅ 放行",
        line: 6,
        column: 6,
      }),
    ];
    mockResponse(async () => jsonResponse(200, makeReview(doc, items)));
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, doc);

    const item = await screen.findByTestId("release-review-mismatch-0");
    expect(item).toHaveTextContent("第 6 行，第 6 列");
    expect(item).toHaveTextContent("ΔE00=1.26");
    expect(item).toHaveTextContent("ΔE00=9.99");
  });

  it("多字段篡改：一次列出多个定位项", async () => {
    const doc = makeDoc();
    const items = [
      mismatch({ field: "result.delta_e00", message: "色差不一致" }),
      mismatch({ section: "label", field: "batch.gtin", message: "GTIN 不一致" }),
      mismatch({ section: "text", field: "text.lines[15]", message: "额外正文", line: 15 }),
    ];
    mockResponse(async () => jsonResponse(200, makeReview(doc, items)));
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, doc);

    await screen.findByTestId("release-review-mismatches");
    expect(screen.getByTestId("release-review-mismatch-0")).toBeInTheDocument();
    expect(screen.getByTestId("release-review-mismatch-1")).toBeInTheDocument();
    expect(screen.getByTestId("release-review-mismatch-2")).toHaveTextContent("第 15 行");
  });

  it("JSON 语法错误不发请求，也不产生复核快照", async () => {
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    fireEvent.change(screen.getByTestId("release-review-input"), {
      target: { value: "{not json" },
    });
    await user.click(screen.getByTestId("release-review-import"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const error = await screen.findByTestId("release-review-request-error");
    expect(error).toHaveTextContent("JSON 语法错误");
    expect(screen.queryByTestId("release-review-result")).not.toBeInTheDocument();
  });

  it("服务端 422 导入失败：显示字段错误，旧成功快照固定不改写", async () => {
    const doc = makeDoc();
    let call = 0;
    mockResponse(async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, makeReview(doc));
      return jsonResponse(422, {
        ok: false,
        message: "放行单导入失败：结构化字段或类型不合规",
        errors: [{ field: "result.passed", message: "必须是布尔值" }],
      });
    });
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, doc);
    await screen.findByTestId("release-review-no-mismatch");

    const bad = { ...doc, result: { ...doc.result, passed: "true" } };
    await importJson(user, bad);
    const error = await screen.findByTestId("release-review-request-error");
    expect(error).toHaveTextContent("result.passed");
    // 旧复核仍在，并且明确没有被失败导入改写。
    expect(screen.getByTestId("release-review-result")).toBeInTheDocument();
    expect(screen.getByTestId("release-review-no-mismatch")).toBeInTheDocument();
    expect(error).toHaveTextContent("上一次成功导入的复核快照，未被改写");
  });

  it("导入成功后继续编辑 JSON：只标记旧快照，不改变复核结果", async () => {
    const doc = makeDoc();
    mockResponse(async () => jsonResponse(200, makeReview(doc)));
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, doc);
    await screen.findByTestId("release-review-no-mismatch");

    await user.type(screen.getByTestId("release-review-input"), " ");
    const stale = await screen.findByTestId("release-review-stale");
    expect(stale).toHaveTextContent("固定于上一次成功导入的快照");
    expect(screen.getByTestId("release-review-no-mismatch")).toBeInTheDocument();
  });

  it("迟到的旧复核响应不能覆盖更新的导入快照", async () => {
    const firstDoc = makeDoc();
    const secondDoc = makeDoc({
      batch: { gtin: GTIN, lot: "INK2408", expires: "2028-09-30" },
    });
    const secondReview = makeReview(secondDoc, [
      mismatch({ section: "label", field: "batch.lot", message: "批号不一致", expected: "INK2408", actual: "INK2407" }),
    ]);
    let resolveFirst!: (response: Response) => void;
    const firstPending = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    mockResponse(async () => {
      call += 1;
      if (call === 1) return firstPending;
      return jsonResponse(200, secondReview);
    });

    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, firstDoc);
    await screen.findByTestId("release-review-busy");
    await importJson(user, secondDoc);
    expect(await screen.findByText("batch.lot")).toBeInTheDocument();

    resolveFirst(jsonResponse(200, makeReview(firstDoc)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId("release-review-consistency")).toHaveTextContent(
      "内容不自洽（未鉴真）",
    );
    expect(screen.getByTestId("release-review-mismatches")).toBeInTheDocument();
  });

  it("清空复核入口会移除快照并作废旧响应", async () => {
    const doc = makeDoc();
    let resolveRequest!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    mockResponse(async () => pending);
    const user = userEvent.setup();
    render(<ReleaseReviewPanel />);
    await importJson(user, doc);
    await user.click(screen.getByTestId("release-review-reset"));
    expect(screen.queryByTestId("release-review-result")).not.toBeInTheDocument();
    expect(screen.getByTestId("release-review-input")).toHaveValue("");

    resolveRequest(jsonResponse(200, makeReview(doc)));
    await waitFor(() => expect(screen.queryByTestId("release-review-result")).not.toBeInTheDocument());
  });
});

function docTextWithLine(lineNo: number, line: string): string {
  const lines = buildText().split("\n");
  lines[lineNo - 1] = line;
  return lines.join("\n");
}
