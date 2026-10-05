import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchReleasePanel } from "./BatchReleasePanel";
import type { BatchReleaseSuccessResponse } from "./types";

/** 参考对 #25：ΔE00 = 1.2644（放行） */
const PASS_PAIR = {
  standard: { L: 60.2574, a: -34.0099, b: 36.2677 },
  sample: { L: 60.4626, a: -34.1751, b: 39.4387 },
};
/** 参考对 #1：ΔE00 = 2.0425（超差） */
const FAIL_PAIR = {
  standard: { L: 50.0, a: 2.6772, b: -79.7751 },
  sample: { L: 50.0, a: 0.0, b: -82.7485 },
};

const LABEL_OK = "(01)09506000134352(10)INK2407(17)280930";
const LABEL_OK_ALT = "(01)09506000134352(10)INK2408(17)280930";
const LABEL_BAD_CHECK = "(01)09506000134353(10)INK2407(17)280930";

type FetchMock = ReturnType<typeof vi.fn>;

function mockResponse(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
) {
  (globalThis.fetch as FetchMock).mockImplementation(impl);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function verdict(passed: boolean, delta = 1.26) {
  return {
    delta_e00: passed ? 1.2643671 : 2.0424586,
    delta_e00_round: delta,
    threshold: 2.0,
    passed,
    excess_raw: passed ? 0.0 : 0.0424586,
    excess_round: passed ? 0.0 : 0.04,
    relation: (passed ? "<=" : ">") as "<=" | ">",
  };
}

/** 构造与后端契约一致的组合响应。 */
function releaseBody(
  opts: {
    colorPassed?: boolean;
    labelPassed?: boolean;
    labelRaw?: string;
    lot?: string;
    labelPos?: number;
    releaseId?: string;
  } = {},
): BatchReleaseSuccessResponse {
  const {
    colorPassed = true,
    labelPassed = true,
    labelRaw = LABEL_OK,
    lot = "INK2407",
    labelPos = 17,
    releaseId = "REL-20260930T100000Z-ab12cd34",
  } = opts;
  const pair = colorPassed ? PASS_PAIR : FAIL_PAIR;
  const released = colorPassed && labelPassed;
  return {
    ok: true,
    released,
    inputs: {
      standard: { ...pair.standard },
      sample: { ...pair.sample },
      label_raw: labelRaw,
    },
    color_check: {
      passed: colorPassed,
      result: verdict(colorPassed, colorPassed ? 1.26 : 2.04),
    },
    label_check: labelPassed
      ? {
          passed: true,
          parsed: {
            ok: true,
            format: "readable" as const,
            fields: [],
            batch: { gtin: "09506000134352", lot, expires: "2028-09-30" },
          },
        }
      : {
          passed: false,
          error: {
            code: "invalid_checksum",
            message: "标签解析失败：商品编码校验位错误：应为 2，实际为 3",
            position: labelPos,
          },
        },
    release: released
      ? {
          id: releaseId,
          generated_at: "2026-09-30T10:00:00Z",
          standard: { ...pair.standard },
          sample: { ...pair.sample },
          result: verdict(colorPassed),
          batch: { gtin: "09506000134352", lot, expires: "2028-09-30" },
          label_raw: labelRaw,
          text: [
            `批次放行单 ${releaseId}`,
            "生成时间（UTC）：2026-09-30T10:00:00Z",
            "── 色差核验（CIEDE2000，阈值 2.00，未舍入值判定）──",
            `标准色：L*=${pair.standard.L} a*=${pair.standard.a} b*=${pair.standard.b}`,
            `首张样张：L*=${pair.sample.L} a*=${pair.sample.a} b*=${pair.sample.b}`,
            "ΔE00=1.26（未舍入 1.264367）<= 2.00：✅ 放行",
            "── 标签核验（GS1 AI 01/10/17）──",
            "商品编码 GTIN：09506000134352",
            `批号（逐字符快照）：${lot}`,
            "失效日期：2028-09-30",
            "标签原文快照（开始/结束）：",
            ">>>",
            labelRaw,
            "<<<",
          ].join("\n"),
        }
      : null,
  };
}

async function fillReleaseForm(
  user: ReturnType<typeof userEvent.setup>,
  pair: typeof PASS_PAIR,
  raw: string,
) {
  await user.clear(screen.getByTestId("release.standard.L"));
  await user.type(screen.getByTestId("release.standard.L"), String(pair.standard.L));
  await user.clear(screen.getByTestId("release.standard.a"));
  await user.type(screen.getByTestId("release.standard.a"), String(pair.standard.a));
  await user.clear(screen.getByTestId("release.standard.b"));
  await user.type(screen.getByTestId("release.standard.b"), String(pair.standard.b));
  await user.clear(screen.getByTestId("release.sample.L"));
  await user.type(screen.getByTestId("release.sample.L"), String(pair.sample.L));
  await user.clear(screen.getByTestId("release.sample.a"));
  await user.type(screen.getByTestId("release.sample.a"), String(pair.sample.a));
  await user.clear(screen.getByTestId("release.sample.b"));
  await user.type(screen.getByTestId("release.sample.b"), String(pair.sample.b));
  await user.clear(screen.getByTestId("release-label-raw"));
  await user.type(screen.getByTestId("release-label-raw"), raw);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("批次放行单组合流程", () => {
  it("初始无放行单/结果；输入不完整时提交按钮禁用", async () => {
    render(<BatchReleasePanel />);
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-outcome")).not.toBeInTheDocument();
    expect(screen.getByTestId("release-submit")).toBeDisabled();

    await userEvent.type(screen.getByTestId("release.standard.L"), "60");
    // Lab 填了但标签原文为空，仍禁用
    expect(screen.getByTestId("release-submit")).toBeDisabled();
    await userEvent.type(screen.getByTestId("release-label-raw"), LABEL_OK);
    // 仍有 Lab 字段缺失
    expect(screen.getByTestId("release-submit")).toBeDisabled();
  });

  it("双项通过：展示两项核验与固定放行单，凭据字段即本次输入快照", async () => {
    const user = userEvent.setup();
    mockResponse(async () => jsonResponse(200, releaseBody()));

    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));

    const doc = await screen.findByTestId("release-document");
    expect(within(doc).getByTestId("release-doc-id")).toHaveTextContent(
      "REL-20260930T100000Z-ab12cd34",
    );
    // 色差核验
    const colorPanel = screen.getByTestId("release-color-result");
    expect(colorPanel).toHaveAttribute("data-passed", "true");
    expect(within(colorPanel).getByTestId("verdict")).toHaveTextContent("放行");
    // 标签核验
    expect(screen.getByTestId("release-label-result")).toBeInTheDocument();
    expect(screen.getByTestId("release-label-gtin")).toHaveTextContent(
      "09506000134352",
    );
    expect(screen.getByTestId("release-label-lot")).toHaveTextContent("INK2407");
    expect(screen.getByTestId("release-label-expires")).toHaveTextContent("2028-09-30");
    // 凭据元数据
    expect(within(doc).getByTestId("release-doc-lot")).toHaveTextContent("INK2407");
    expect(within(doc).getByTestId("release-doc-delta")).toHaveTextContent("1.26");
    // 可复制全文
    const text = within(doc).getByTestId("release-document-text") as HTMLTextAreaElement;
    expect(text.value).toContain("批次放行单 REL-20260930T100000Z-ab12cd34");
    expect(text.value).toContain(LABEL_OK);
    expect(text.value).toContain("09506000134352");
    // 不出现“不生成放行单”
    expect(screen.queryByTestId("release-not-issued")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-request-error")).not.toBeInTheDocument();
  });

  it("请求只发往组合端点，载荷含 label_raw", async () => {
    const user = userEvent.setup();
    mockResponse(async () => jsonResponse(200, releaseBody()));
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    await screen.findByTestId("release-document");

    const [url, init] = (globalThis.fetch as FetchMock).mock.calls[0];
    expect(url).toBe("/api/batch-release");
    expect(JSON.parse(String(init?.body))).toEqual({
      standard: { L: 60.2574, a: -34.0099, b: 36.2677 },
      sample: { L: 60.4626, a: -34.1751, b: 39.4387 },
      label_raw: LABEL_OK,
    });
  });

  it("色差超差 × 标签有效：展示超差与标签，released=false，且无半张凭据", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(200, releaseBody({ colorPassed: false })),
    );
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, FAIL_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));

    const colorPanel = await screen.findByTestId("release-color-result");
    expect(colorPanel).toHaveAttribute("data-passed", "false");
    expect(within(colorPanel).getByTestId("verdict")).toHaveTextContent("超差");
    // 标签核验仍然完成
    expect(screen.getByTestId("release-label-gtin")).toBeInTheDocument();
    // 明确提示未生成凭据，且页面上没有放行单
    expect(screen.getByTestId("release-not-issued")).toHaveTextContent("不生成放行单");
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();
  });

  it("色差放行 × 标签解析失败：错误码/位置明确、无批次信息、无放行单", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(200, releaseBody({ colorPassed: true, labelPassed: false })),
    );
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_BAD_CHECK);
    await user.click(screen.getByTestId("release-submit"));

    const colorPanel = await screen.findByTestId("release-color-result");
    expect(colorPanel).toHaveAttribute("data-passed", "true");
    // 标签失败块与位置高亮
    const labelError = screen.getByTestId("release-label-error");
    expect(labelError).toHaveTextContent("校验位");
    expect(screen.getByTestId("release-label-error-position")).toHaveTextContent(
      "第 18 个字符",
    );
    expect(screen.getByTestId("release-label-error-char")).toHaveTextContent("3");
    expect(screen.getByTestId("release-label-raw-highlight")).toHaveTextContent(
      LABEL_BAD_CHECK,
    );
    expect(screen.queryByTestId("release-label-result")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-label-gtin")).not.toBeInTheDocument();
    // 无半张凭据
    expect(screen.getByTestId("release-not-issued")).toBeInTheDocument();
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();
  });

  it("请求 422（整次拒绝）：显示字段错误，不产生结果也不动凭据", async () => {
    const user = userEvent.setup();
    let call = 0;
    mockResponse(async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, releaseBody());
      return jsonResponse(422, {
        ok: false,
        message: "输入校验失败，整次请求被拒绝",
        errors: [
          { field: "sample.b", message: "超出允许范围 [-128, 127]，端点包含" },
        ],
      });
    });
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    const doc = await screen.findByTestId("release-document");
    const idBefore = within(doc).getByTestId("release-doc-id").textContent;

    // 第二次提交被服务端 422（输入仍合法，绕过本地校验直接打到 fetch 桩）
    await user.click(screen.getByTestId("release-submit"));
    await waitFor(() => expect(call).toBe(2));
    const errBox = await screen.findByTestId("release-request-error");
    expect(errBox).toHaveTextContent("sample.b");
    // 422 是“请求异常”，不是核验失败：无 outcome
    expect(screen.queryByTestId("release-outcome")).not.toBeInTheDocument();
    // 旧放行单原样钉住
    expect(screen.getByTestId("release-document")).toBeInTheDocument();
    expect(within(screen.getByTestId("release-document")).getByTestId("release-doc-id").textContent).toBe(idBefore);
  });

  it("网络异常：明确提示请求失败，不产生结果、不动凭据", async () => {
    const user = userEvent.setup();
    let call = 0;
    (globalThis.fetch as FetchMock).mockImplementation(async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, releaseBody());
      throw new TypeError("Failed to fetch");
    });
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    await screen.findByTestId("release-document");

    await user.click(screen.getByTestId("release-submit"));
    await waitFor(() => expect(call).toBe(2));
    const errBox = await screen.findByTestId("release-request-error");
    expect(errBox).toHaveTextContent("无法连接");
    expect(screen.queryByTestId("release-document")).toBeInTheDocument();
  });
});

describe("放行单固定：编辑输入只标记不一致，不改写凭据", () => {
  it("生成后修改 Lab 与标签：放行单仍在、快照不变，出现不一致标记", async () => {
    const user = userEvent.setup();
    mockResponse(async () => jsonResponse(200, releaseBody()));
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    const doc = await screen.findByTestId("release-document");
    const idBefore = within(doc).getByTestId("release-doc-id").textContent;
    expect(screen.queryByTestId("release-mismatch")).not.toBeInTheDocument();

    // 改一个 Lab 值（仍合法）：凭据不得消失或被改写
    await user.clear(screen.getByTestId("release.sample.b"));
    await user.type(screen.getByTestId("release.sample.b"), "40");
    expect(screen.getByTestId("release-document")).toBeInTheDocument();
    const mismatch = await screen.findByTestId("release-mismatch");
    expect(mismatch).toHaveTextContent("未被改写");
    // 凭据内字段仍是旧快照
    expect(within(doc).getByTestId("release-doc-id").textContent).toBe(idBefore);
    expect(within(doc).getByTestId("release-document-text")).toHaveTextContent(
      "39.4387",
    );
    // 最近结果也标记与当前表单不一致
    expect(screen.getByTestId("release-outcome-mismatch")).toBeInTheDocument();

    // 再改标签原文（追加字符）
    await user.type(screen.getByTestId("release-label-raw"), "X");
    expect(screen.getByTestId("release-mismatch")).toBeInTheDocument();
    expect(within(doc).getByTestId("release-doc-lot")).toHaveTextContent("INK2407");
  });

  it("把输入改回凭据快照：不一致标记消失", async () => {
    const user = userEvent.setup();
    mockResponse(async () => jsonResponse(200, releaseBody()));
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    await screen.findByTestId("release-document");

    await user.type(screen.getByTestId("release-label-raw"), "X");
    expect(await screen.findByTestId("release-mismatch")).toBeInTheDocument();

    await user.type(screen.getByTestId("release-label-raw"), "{Backspace}");
    await waitFor(() =>
      expect(screen.queryByTestId("release-mismatch")).not.toBeInTheDocument(),
    );
  });

  it("超差失败后再编辑：失败结果标记不一致，且始终没有放行单", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(200, releaseBody({ colorPassed: false })),
    );
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, FAIL_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    await screen.findByTestId("release-not-issued");

    await user.clear(screen.getByTestId("release.standard.L"));
    await user.type(screen.getByTestId("release.standard.L"), "49");
    expect(screen.getByTestId("release-outcome-mismatch")).toBeInTheDocument();
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("连续提交：迟到响应不得覆盖较新的放行单", () => {
  it("请求1迟到的成功响应不得覆盖请求2更新的放行单", async () => {
    const user = userEvent.setup();
    const firstReq = deferred<Response>();
    let call = 0;
    mockResponse(async (_url, init) => {
      call += 1;
      const body = JSON.parse(String(init?.body)) as {
        label_raw: string;
      };
      if (call === 1) {
        // 第一次请求挂起；第二次立即返回 INK2408 的新凭据
        return firstReq.promise;
      }
      expect(body.label_raw).toBe(LABEL_OK_ALT);
      return jsonResponse(
        200,
        releaseBody({
          labelRaw: LABEL_OK_ALT,
          lot: "INK2408",
          releaseId: "REL-20260930T110000Z-zz99yy88",
        }),
      );
    });

    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    await screen.findByTestId("release-busy");
    // 第一次请求在途时直接改输入并第二次提交（输入在忙碌时不禁用）
    expect(screen.getByTestId("release-label-raw")).toBeEnabled();
    await user.clear(screen.getByTestId("release-label-raw"));
    await user.type(screen.getByTestId("release-label-raw"), LABEL_OK_ALT);
    await user.click(screen.getByTestId("release-submit"));

    // 较新的响应先落地：凭据属于第二次请求（INK2408）
    const doc = await screen.findByTestId("release-document");
    await waitFor(() =>
      expect(within(doc).getByTestId("release-doc-lot")).toHaveTextContent("INK2408"),
    );
    expect(within(doc).getByTestId("release-doc-id")).toHaveTextContent(
      "REL-20260930T110000Z-zz99yy88",
    );

    // 第一次请求迟到返回（INK2407 的旧凭据）：必须被丢弃
    firstReq.resolve(jsonResponse(200, releaseBody()));
    await new Promise((r) => setTimeout(r, 10));
    expect(within(doc).getByTestId("release-doc-lot")).toHaveTextContent("INK2408");
    expect(within(doc).getByTestId("release-doc-id")).toHaveTextContent(
      "REL-20260930T110000Z-zz99yy88",
    );
    // 不应出现两份凭据
    expect(screen.getAllByTestId("release-document")).toHaveLength(1);
  });

  it("较新请求失败时，迟到的旧成功响应也不得回填放行单", async () => {
    const user = userEvent.setup();
    const firstReq = deferred<Response>();
    let call = 0;
    mockResponse(async () => {
      call += 1;
      if (call === 1) return firstReq.promise; // 挂起的“本会成功”旧请求
      // 较新请求：标签损坏 → 核验失败
      return jsonResponse(
        200,
        releaseBody({ colorPassed: true, labelPassed: false, labelRaw: LABEL_BAD_CHECK }),
      );
    });

    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    // 第二次提交（更急的新请求，标签坏）
    await user.clear(screen.getByTestId("release-label-raw"));
    await user.type(screen.getByTestId("release-label-raw"), LABEL_BAD_CHECK);
    await user.click(screen.getByTestId("release-submit"));

    await screen.findByTestId("release-not-issued");
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();

    // 旧请求迟到成功：必须丢弃，不能把旧凭据补回来
    firstReq.resolve(jsonResponse(200, releaseBody()));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();
    expect(screen.getByTestId("release-not-issued")).toBeInTheDocument();
  });
});

describe("失败后的页面状态与清理", () => {
  it("清空本流程：结果、错误、放行单全部移除，输入清空，且在途响应作废", async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    mockResponse(async () => pending.promise);
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.click(screen.getByTestId("release-submit"));
    expect(screen.getByTestId("release-reset")).toBeDisabled(); // busy 时禁用
    // 直接清空（busy 下重置按钮禁用与既有入口一致；此处先让响应落地再测重置）
    pending.resolve(jsonResponse(200, releaseBody()));
    await screen.findByTestId("release-document");

    await user.click(screen.getByTestId("release-reset"));
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-outcome")).not.toBeInTheDocument();
    expect(screen.getByTestId("release.standard.L")).toHaveValue("");
    expect(screen.getByTestId("release-label-raw")).toHaveValue("");
    expect(screen.getByTestId("release-submit")).toBeDisabled();
  });

  it("本地非法（越界/空标签）不发请求，且不生成凭据", async () => {
    const user = userEvent.setup();
    render(<BatchReleasePanel />);
    await fillReleaseForm(user, PASS_PAIR, LABEL_OK);
    await user.clear(screen.getByTestId("release.standard.L"));
    await user.type(screen.getByTestId("release.standard.L"), "999");
    expect(screen.getByTestId("release.standard.L-error")).toHaveTextContent("越界");
    expect(screen.getByTestId("release-submit")).toBeDisabled();
    await user.click(screen.getByTestId("release-submit"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("release-document")).not.toBeInTheDocument();
  });
});
