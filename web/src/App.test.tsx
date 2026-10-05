import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/** 参考对 #1：ΔE00 = 2.0425（超差，超出量 0.04） */
const FAIL_PAIR = {
  standard: { L: 50.0, a: 2.6772, b: -79.7751 },
  sample: { L: 50.0, a: 0.0, b: -82.7485 },
};

/** 参考对 #25：ΔE00 = 1.2644（放行） */
const PASS_PAIR = {
  standard: { L: 60.2574, a: -34.0099, b: 36.2677 },
  sample: { L: 60.4626, a: -34.1751, b: 39.4387 },
};

type FetchMock = ReturnType<typeof vi.fn>;

function mockResponse(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  (globalThis.fetch as FetchMock).mockImplementation(impl);
}

function fillPair(
  user: ReturnType<typeof userEvent.setup>,
  pair: typeof PASS_PAIR,
) {
  return (async () => {
    await user.clear(screen.getByTestId("standard.L"));
    await user.type(screen.getByTestId("standard.L"), String(pair.standard.L));
    await user.clear(screen.getByTestId("standard.a"));
    await user.type(screen.getByTestId("standard.a"), String(pair.standard.a));
    await user.clear(screen.getByTestId("standard.b"));
    await user.type(screen.getByTestId("standard.b"), String(pair.standard.b));
    await user.clear(screen.getByTestId("sample.L"));
    await user.type(screen.getByTestId("sample.L"), String(pair.sample.L));
    await user.clear(screen.getByTestId("sample.a"));
    await user.type(screen.getByTestId("sample.a"), String(pair.sample.a));
    await user.clear(screen.getByTestId("sample.b"));
    await user.type(screen.getByTestId("sample.b"), String(pair.sample.b));
  })();
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App 联调（fetch 打桩为真实 FastAPI 契约）", () => {
  it("放行用例同时呈现 ΔE00、阈值关系与放行结论", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          ...PASS_PAIR,
          result: {
            delta_e00: 1.2643671,
            delta_e00_round: 1.26,
            threshold: 2.0,
            passed: true,
            excess_raw: 0.0,
            excess_round: 0.0,
            relation: "<=",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<App />);
    await fillPair(user, PASS_PAIR);
    await user.click(screen.getByTestId("compare-button"));

    const panel = await screen.findByTestId("result-panel");
    expect(panel).toHaveAttribute("data-passed", "true");
    expect(within(panel).getByTestId("verdict")).toHaveTextContent("放行");
    expect(within(panel).getByTestId("metric-delta")).toHaveTextContent("1.26");
    expect(within(panel).getByTestId("metric-relation")).toHaveTextContent("≤");
    expect(within(panel).getByTestId("metric-relation")).toHaveTextContent("2.00");
    expect(within(panel).getByTestId("metric-excess")).toHaveTextContent("0.00");
  });

  it("超差用例显示超差结论与超出量 0.04", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          ...FAIL_PAIR,
          result: {
            delta_e00: 2.0424586,
            delta_e00_round: 2.04,
            threshold: 2.0,
            passed: false,
            excess_raw: 0.0424586,
            excess_round: 0.04,
            relation: ">",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<App />);
    await fillPair(user, FAIL_PAIR);
    await user.click(screen.getByTestId("compare-button"));

    const panel = await screen.findByTestId("result-panel");
    expect(panel).toHaveAttribute("data-passed", "false");
    expect(within(panel).getByTestId("verdict")).toHaveTextContent("超差");
    expect(within(panel).getByTestId("metric-delta")).toHaveTextContent("2.04");
    expect(within(panel).getByTestId("metric-relation")).toHaveTextContent(">");
    expect(within(panel).getByTestId("metric-excess")).toHaveTextContent("0.04");
  });

  it("422 字段错误：整次拒绝并清除上一版旧结论", async () => {
    const user = userEvent.setup();
    let call = 0;
    mockResponse(async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            ok: true,
            ...PASS_PAIR,
            result: {
              delta_e00: 1.2643671,
              delta_e00_round: 1.26,
              threshold: 2.0,
              passed: true,
              excess_raw: 0.0,
              excess_round: 0.0,
              relation: "<=",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // 同样合法的输入，服务端这次仍返回 422（模拟后端规则更严/漂移）：
      // 前端必须整次拒绝并清除旧结论，不能继续展示上一版“放行”。
      return new Response(
        JSON.stringify({
          ok: false,
          message: "输入校验失败，整次请求被拒绝",
          errors: [
            { field: "sample.b", message: "超出允许范围 [-128, 127]，端点包含", type: "value_error" },
          ],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    });

    render(<App />);
    await fillPair(user, PASS_PAIR);
    await user.click(screen.getByTestId("compare-button"));
    expect(await screen.findByTestId("result-panel")).toBeInTheDocument();

    // 再次点击比较（输入未变，服务端这次拒绝）
    await user.click(screen.getByTestId("compare-button"));
    await waitFor(() => expect(call).toBe(2));
    await waitFor(() =>
      expect(screen.queryByTestId("result-panel")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("server-errors")).toHaveTextContent("sample.b");
  });

  it("本地输入非法时不发请求并立即清除旧结论", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mockResponse(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          ...PASS_PAIR,
          result: {
            delta_e00: 1.2643671,
            delta_e00_round: 1.26,
            threshold: 2.0,
            passed: true,
            excess_raw: 0.0,
            excess_round: 0.0,
            relation: "<=",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    render(<App />);
    await fillPair(user, PASS_PAIR);
    await user.click(screen.getByTestId("compare-button"));
    expect(await screen.findByTestId("result-panel")).toBeInTheDocument();
    expect(calls).toBe(1);

    // 把 L* 改成越界值：旧结论立即消失，按钮禁用，不再发请求
    await user.clear(screen.getByTestId("standard.L"));
    await user.type(screen.getByTestId("standard.L"), "120");
    expect(screen.queryByTestId("result-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("standard.L-error")).toHaveTextContent("越界");
    expect(screen.getByTestId("compare-button")).toBeDisabled();
    expect(calls).toBe(1);
  });

  it("缺失字段时按钮禁用且出现字段错误", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByTestId("compare-button")).toBeDisabled();
    await user.type(screen.getByTestId("standard.L"), "50");
    await user.click(screen.getByTestId("compare-button"));
    // 仍禁用（有字段错误）
    expect(screen.getByTestId("compare-button")).toBeDisabled();
    expect(screen.getByTestId("standard.a-error")).toBeInTheDocument();
  });

  it("重置按钮清空表单与旧结论", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          ...PASS_PAIR,
          result: {
            delta_e00: 1.2643671,
            delta_e00_round: 1.26,
            threshold: 2.0,
            passed: true,
            excess_raw: 0.0,
            excess_round: 0.0,
            relation: "<=",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<App />);
    await fillPair(user, PASS_PAIR);
    await user.click(screen.getByTestId("compare-button"));
    expect(await screen.findByTestId("result-panel")).toBeInTheDocument();

    await user.click(screen.getByTestId("reset-button"));
    expect(screen.queryByTestId("result-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("standard.L")).toHaveValue("");
    expect(screen.getByTestId("sample.b")).toHaveValue("");
  });

  it("批次标签核验区独立：标签被拒绝不清除色差结论，色差区不读标签状态", async () => {
    const user = userEvent.setup();
    mockResponse(async (url: string) => {
      if (url === "/api/gs1-label") {
        return new Response(
          JSON.stringify({
            ok: false,
            message: "标签解析失败：商品编码校验位错误",
            errors: [{ field: "raw", message: "校验位错误", type: "parse_error" }],
            position: 17,
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          ...PASS_PAIR,
          result: {
            delta_e00: 1.2643671,
            delta_e00_round: 1.26,
            threshold: 2.0,
            passed: true,
            excess_raw: 0.0,
            excess_round: 0.0,
            relation: "<=",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    render(<App />);
    // 先得到色差放行结论
    await fillPair(user, PASS_PAIR);
    await user.click(screen.getByTestId("compare-button"));
    expect(await screen.findByTestId("result-panel")).toBeInTheDocument();

    // 标签核验失败：色差结论与表单必须原样保留
    await user.type(
      screen.getByTestId("label-raw"),
      "(01)09506000134353(10)INK2407(17)280930",
    );
    await user.click(screen.getByTestId("label-verify"));
    expect(await screen.findByTestId("label-error")).toBeInTheDocument();
    expect(screen.getByTestId("label-status")).toHaveTextContent("已拒绝");
    expect(screen.getByTestId("result-panel")).toBeInTheDocument();
    expect(screen.getByTestId("verdict")).toHaveTextContent("放行");
    expect(screen.getByTestId("standard.L")).toHaveValue(String(PASS_PAIR.standard.L));

    // 标签区处于已拒绝状态时，色差比对仍可独立再次完成
    await user.click(screen.getByTestId("compare-button"));
    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
  });

  it("标签核验请求挂起时：不锁 Lab 输入、色差比对与清空重置，色差仍可完成", async () => {
    const user = userEvent.setup();
    const labelPending = deferred<Response>();
    mockResponse(async (url: string) => {
      if (url === "/api/gs1-label") {
        return labelPending.promise; // 标签服务缓慢/挂起
      }
      return new Response(
        JSON.stringify({
          ok: true,
          ...PASS_PAIR,
          result: {
            delta_e00: 1.2643671,
            delta_e00_round: 1.26,
            threshold: 2.0,
            passed: true,
            excess_raw: 0.0,
            excess_round: 0.0,
            relation: "<=",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    render(<App />);
    await fillPair(user, PASS_PAIR);

    // 发起一个挂起的标签核验请求
    await user.type(screen.getByTestId("label-raw"), LABEL_PENDING_RAW);
    await user.click(screen.getByTestId("label-verify"));
    expect(screen.getByTestId("label-verify")).toBeDisabled(); // 仅锁住标签自身防重复提交

    // 色差区完全不受影响：两组 Lab 输入、比对、重置都可用
    expect(screen.getByTestId("standard.L")).toBeEnabled();
    expect(screen.getByTestId("sample.b")).toBeEnabled();
    expect(screen.getByTestId("compare-button")).toBeEnabled();
    expect(screen.getByTestId("reset-button")).toBeEnabled();

    // 标签请求尚未返回，色差比对照常完成
    await user.click(screen.getByTestId("compare-button"));
    const panel = await screen.findByTestId("result-panel");
    expect(panel).toHaveAttribute("data-passed", "true");

    labelPending.resolve(
      new Response(
        JSON.stringify({
          ok: false,
          message: "标签解析失败",
          errors: [{ field: "raw", message: "解析失败", type: "parse_error" }],
          position: null,
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  it("色差请求挂起时：不锁标签输入与核验，标签仍可独立识别", async () => {
    const user = userEvent.setup();
    const deltaPending = deferred<Response>();
    mockResponse(async (url: string) => {
      if (url === "/api/gs1-label") {
        return new Response(
          JSON.stringify({
            ok: true,
            format: "readable",
            fields: [],
            batch: {
              gtin: "09506000134352",
              lot: "INK2407",
              expires: "2028-09-30",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return deltaPending.promise; // 色差服务缓慢/挂起
    });

    render(<App />);
    await fillPair(user, PASS_PAIR);
    await user.click(screen.getByTestId("compare-button"));
    expect(screen.getByTestId("compare-button")).toBeDisabled(); // 仅锁住色差自身防重复提交

    // 标签核验区完全不受影响：输入与核验按钮可用
    expect(screen.getByTestId("label-raw")).toBeEnabled();
    await user.type(screen.getByTestId("label-raw"), LABEL_PENDING_RAW);
    expect(screen.getByTestId("label-verify")).toBeEnabled();
    await user.click(screen.getByTestId("label-verify"));

    expect(await screen.findByTestId("label-result")).toBeInTheDocument();
    expect(screen.getByTestId("label-gtin")).toHaveTextContent("09506000134352");

    deltaPending.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          ...PASS_PAIR,
          result: {
            delta_e00: 1.2643671,
            delta_e00_round: 1.26,
            threshold: 2.0,
            passed: true,
            excess_raw: 0.0,
            excess_round: 0.0,
            relation: "<=",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });
});

const LABEL_PENDING_RAW = "(01)09506000134352(10)INK2407(17)280930";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
