import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchLabelPanel } from "./BatchLabelPanel";

/** 合法标签（可读格式）：GTIN 校验位 2、失效日期 2028-09-30 */
const LABEL_OK = "(01)09506000134352(10)INK2407(17)280930";
/** 校验位损坏的标签：末位 3 应为 2，校验位在下标 17 */
const LABEL_BAD_CHECK = "(01)09506000134353(10)INK2407(17)280930";

const BATCH_OK = {
  gtin: "09506000134352",
  lot: "INK2407",
  expires: "2028-09-30",
};

type FetchMock = ReturnType<typeof vi.fn>;

function mockResponse(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  (globalThis.fetch as FetchMock).mockImplementation(impl);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("批次标签核验区状态机", () => {
  it("初始为待输入，空输入时核验按钮禁用", async () => {
    const user = userEvent.setup();
    render(<BatchLabelPanel />);

    expect(screen.getByTestId("label-status")).toHaveTextContent("待输入");
    expect(screen.getByTestId("label-status")).toHaveAttribute(
      "data-status",
      "idle",
    );
    expect(screen.getByTestId("label-verify")).toBeDisabled();

    await user.type(screen.getByTestId("label-raw"), LABEL_OK);
    expect(screen.getByTestId("label-verify")).toBeEnabled();
  });

  it("识别成功：待输入 → 已识别，展示商品编码、批号、失效日期", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(200, {
        ok: true,
        format: "readable",
        fields: [],
        batch: BATCH_OK,
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("label-verify"));

    expect(await screen.findByTestId("label-result")).toBeInTheDocument();
    expect(screen.getByTestId("label-status")).toHaveTextContent("已识别");
    expect(screen.getByTestId("label-status")).toHaveAttribute(
      "data-status",
      "recognized",
    );
    expect(screen.getByTestId("label-gtin")).toHaveTextContent("09506000134352");
    expect(screen.getByTestId("label-lot")).toHaveTextContent("INK2407");
    expect(screen.getByTestId("label-expires")).toHaveTextContent("2028-09-30");
    expect(screen.getByTestId("label-format")).toHaveTextContent("可读格式");

    // 请求按既有客户端契约发出
    const [url, init] = (globalThis.fetch as FetchMock).mock.calls[0];
    expect(url).toBe("/api/gs1-label");
    expect(JSON.parse(String(init?.body))).toEqual({ raw: LABEL_OK });
  });

  it("已识别 → 扫描下一桶 → 回到待输入并可继续", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(200, {
        ok: true,
        format: "readable",
        fields: [],
        batch: BATCH_OK,
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("label-verify"));
    expect(await screen.findByTestId("label-result")).toBeInTheDocument();

    await user.click(screen.getByTestId("label-next"));
    expect(screen.getByTestId("label-status")).toHaveTextContent("待输入");
    expect(screen.getByTestId("label-raw")).toHaveValue("");
    expect(screen.queryByTestId("label-result")).not.toBeInTheDocument();
  });

  it("已识别后修改原文（替换/追加字符）→ 立即回到待输入并清除旧批次信息，防止修改文本与旧批次错误对应", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(200, {
        ok: true,
        format: "readable",
        fields: [],
        batch: BATCH_OK,
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("label-verify"));
    expect(await screen.findByTestId("label-result")).toBeInTheDocument();
    expect(screen.getByTestId("label-status")).toHaveTextContent("已识别");

    // 追加一个字符（尚未再次核验）：不得继续展示上一桶的商品编码/批号/失效日期
    await user.type(screen.getByTestId("label-raw"), "X");
    expect(screen.getByTestId("label-status")).toHaveTextContent("待输入");
    expect(screen.queryByTestId("label-result")).not.toBeInTheDocument();
    expect(screen.queryByTestId("label-gtin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("label-format")).not.toBeInTheDocument();

    // 原文保留，核验按钮重新可用
    expect(screen.getByTestId("label-raw")).toHaveValue(`${LABEL_OK}X`);
    expect(screen.getByTestId("label-verify")).toBeEnabled();
  });

  it("首字符即无法解析（position 0）：显示“第 1 个字符”提示并高亮首字符", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(422, {
        ok: false,
        message: "标签解析失败：无法识别的应用标识符（此处字符 '05XY'）",
        errors: [
          { field: "raw", message: "无法识别的应用标识符", type: "parse_error" },
        ],
        position: 0,
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), "05XYZ");
    await user.click(screen.getByTestId("label-verify"));

    expect(await screen.findByTestId("label-error")).toBeInTheDocument();
    expect(screen.getByTestId("label-status")).toHaveTextContent("已拒绝");
    // position 为 0 时也必须展示定位（不能被真值判断吞掉）
    expect(screen.getByTestId("label-error-position")).toHaveTextContent(
      "第 1 个字符",
    );
    expect(screen.getByTestId("label-error-char")).toHaveTextContent("0");
    expect(screen.getByTestId("label-raw-highlight")).toHaveTextContent("05XYZ");
  });

  it("识别失败：待输入 → 已拒绝，保留原文并定位首个无法解析的字符", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(422, {
        ok: false,
        message: "标签解析失败：商品编码校验位错误：按前 13 位计算应为 2，实际为 3",
        errors: [
          {
            field: "raw",
            message: "商品编码校验位错误：按前 13 位计算应为 2，实际为 3",
            type: "parse_error",
          },
        ],
        position: 17,
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), LABEL_BAD_CHECK);
    await user.click(screen.getByTestId("label-verify"));

    expect(await screen.findByTestId("label-error")).toBeInTheDocument();
    expect(screen.getByTestId("label-status")).toHaveTextContent("已拒绝");
    expect(screen.getByTestId("label-status")).toHaveAttribute(
      "data-status",
      "rejected",
    );
    // 原文保留在输入框中
    expect(screen.getByTestId("label-raw")).toHaveValue(LABEL_BAD_CHECK);
    // 指出首个无法解析的位置（0 起下标 17 → 第 18 个字符）
    expect(screen.getByTestId("label-error-position")).toHaveTextContent(
      "第 18 个字符",
    );
    // 原文高亮块中标记的正是校验位字符
    expect(screen.getByTestId("label-error-char")).toHaveTextContent("3");
    expect(screen.getByTestId("label-raw-highlight")).toHaveTextContent(
      LABEL_BAD_CHECK,
    );
  });

  it("识别失败后编辑原文 → 回到待输入并清除错误", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(422, {
        ok: false,
        message: "标签解析失败：未知应用标识符 (05)",
        errors: [{ field: "raw", message: "未知应用标识符 (05)", type: "parse_error" }],
        position: 1,
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), "(05)123456");
    await user.click(screen.getByTestId("label-verify"));
    expect(await screen.findByTestId("label-error")).toBeInTheDocument();

    await user.type(screen.getByTestId("label-raw"), "0");
    expect(screen.getByTestId("label-status")).toHaveTextContent("待输入");
    expect(screen.queryByTestId("label-error")).not.toBeInTheDocument();
  });

  it("已拒绝 → 修正后重新核验 → 已识别（损坏标签重试）", async () => {
    const user = userEvent.setup();
    let call = 0;
    mockResponse(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(422, {
          ok: false,
          message: "标签解析失败：商品编码校验位错误：按前 13 位计算应为 2，实际为 3",
          errors: [{ field: "raw", message: "校验位错误", type: "parse_error" }],
          position: 17,
        });
      }
      return jsonResponse(200, {
        ok: true,
        format: "readable",
        fields: [],
        batch: BATCH_OK,
      });
    });

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), LABEL_BAD_CHECK);
    await user.click(screen.getByTestId("label-verify"));
    expect(await screen.findByTestId("label-error")).toBeInTheDocument();

    // 修正校验位后重新核验
    await user.clear(screen.getByTestId("label-raw"));
    await user.type(screen.getByTestId("label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("label-verify"));

    expect(await screen.findByTestId("label-result")).toBeInTheDocument();
    expect(screen.getByTestId("label-status")).toHaveTextContent("已识别");
    expect(screen.queryByTestId("label-error")).not.toBeInTheDocument();
    expect(call).toBe(2);
  });

  it("标签解析服务不可用：已拒绝并提示，但不抛出异常", async () => {
    const user = userEvent.setup();
    (globalThis.fetch as FetchMock).mockRejectedValue(new TypeError("fetch failed"));

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), LABEL_OK);
    await user.click(screen.getByTestId("label-verify"));

    expect(await screen.findByTestId("label-error")).toHaveTextContent(
      "无法连接标签解析服务",
    );
    expect(screen.getByTestId("label-status")).toHaveTextContent("已拒绝");
    // 网络层错误无法定位字符：不显示定位块
    expect(screen.queryByTestId("label-error-position")).not.toBeInTheDocument();
    expect(screen.queryByTestId("label-raw-highlight")).not.toBeInTheDocument();
  });

  it("缺失必需字段时位置指向末尾，显示末尾标记", async () => {
    const user = userEvent.setup();
    const noGtin = "(10)INK2407(17)280930";
    mockResponse(async () =>
      jsonResponse(422, {
        ok: false,
        message: "标签解析失败：标签缺少批次核验必需的 AI (01) 商品编码 GTIN",
        errors: [{ field: "raw", message: "缺少 AI (01)", type: "parse_error" }],
        position: noGtin.length,
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), noGtin);
    await user.click(screen.getByTestId("label-verify"));

    expect(await screen.findByTestId("label-error")).toBeInTheDocument();
    expect(screen.getByTestId("label-error-char")).toHaveTextContent("末尾");
  });

  it("批号含尾随空格：逐字符展示空格为 ␠，与无尾随空格的批号可区分", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(200, {
        ok: true,
        format: "scan",
        fields: [],
        batch: { gtin: "09506000134352", lot: "INK2407 ", expires: "2028-09-30" },
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), "01095060001343521728093010INK2407 ");
    await user.click(screen.getByTestId("label-verify"));

    const lot = await screen.findByTestId("label-lot");
    // 尾随空格被显式渲染为 ␠，不会被 HTML 折叠而与 "INK2407" 显示相同
    expect(lot).toHaveTextContent("INK2407␠");
    expect(lot.textContent).toBe("INK2407␠");
    expect(lot.textContent).not.toBe("INK2407");
    // white-space: pre-wrap 防止空格折叠
    expect(lot.className).toContain("verbatim-value");
  });

  it("批号含中部与尾随空格：每个空格都可见", async () => {
    const user = userEvent.setup();
    mockResponse(async () =>
      jsonResponse(200, {
        ok: true,
        format: "readable",
        fields: [],
        batch: { gtin: "09506000134352", lot: "A B  ", expires: "2028-09-30" },
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), "(01)09506000134352(17)280930(10)A B  ");
    await user.click(screen.getByTestId("label-verify"));

    expect(await screen.findByTestId("label-lot")).toHaveTextContent("A␠B␠␠");
  });

  it("末尾制表符被拒绝：错误码 unsupported_character，制表符在原文中可见且被高亮", async () => {
    const user = userEvent.setup();
    const raw = "(01)09506000134352(17)280930(10)INK2407\t";
    mockResponse(async () =>
      jsonResponse(422, {
        ok: false,
        code: "unsupported_character",
        message: "标签解析失败：AI (10) 批号出现标签无法编码的字符：制表符 TAB",
        errors: [
          { field: "raw", message: "无法编码的字符", type: "unsupported_character" },
        ],
        position: raw.length - 1,
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), raw);
    await user.click(screen.getByTestId("label-verify"));

    await screen.findByTestId("label-error");
    expect(screen.getByTestId("label-status")).toHaveTextContent("已拒绝");
    // 制表符以可见字形 ␉ 出现，并恰好是被高亮的字符（不是不可见/被吞掉）
    expect(screen.getByTestId("label-error-char")).toHaveTextContent("␉");
    expect(screen.getByTestId("label-raw-highlight")).toHaveTextContent(
      "(01)09506000134352(17)280930(10)INK2407␉",
    );
  });

  it("NUL / 换行 / GS 等控制字符在错误原文中均有唯一可见字形，不折行混淆", async () => {
    const user = userEvent.setup();
    // 注：textarea 的值规范化会把孤立 \r 归一成 \n（浏览器行为一致），扫描器的
    // 末尾 \r 后缀由后端容忍，故此处覆盖能进入输入框的 NUL / LF / GS。
    const cases: Array<{ ch: string; glyph: string }> = [
      { ch: "\x00", glyph: "␀" },
      { ch: "\n", glyph: "␊" },
      { ch: "\x1d", glyph: "␝" },
    ];
    for (const { ch, glyph } of cases) {
      const raw = `(01)09506000134352(17)280930(10)AB${ch}CD`;
      mockResponse(async () =>
        jsonResponse(422, {
          ok: false,
          code: "unsupported_character",
          message: "标签解析失败：出现标签无法编码的字符",
          errors: [
            { field: "raw", message: "x", type: "unsupported_character" },
          ],
          position: raw.indexOf(ch),
        }),
      );

      const { unmount } = render(<BatchLabelPanel />);
      // 直接以 change 事件写入扫码枪原文（可含 \r / NUL；键盘录入会被浏览器归一化）
      fireEvent.change(screen.getByTestId("label-raw"), { target: { value: raw } });
      await user.click(screen.getByTestId("label-verify"));
      await screen.findByTestId("label-error");

      expect(screen.getByTestId("label-error-char")).toHaveTextContent(glyph);
      expect(screen.getByTestId("label-raw-highlight")).toHaveTextContent(
        `(01)09506000134352(17)280930(10)AB${glyph}CD`,
      );
      unmount();
    }
  });

  it("emoji 等星平面字符：按码点定位，高亮块恰好覆盖该 emoji（不错位）", async () => {
    const user = userEvent.setup();
    const raw = "(01)09506000134352(17)280930(10)L😀X";
    mockResponse(async () =>
      jsonResponse(422, {
        ok: false,
        code: "unsupported_character",
        message: "标签解析失败：出现标签无法编码的字符：U+1F600",
        errors: [
          { field: "raw", message: "x", type: "unsupported_character" },
        ],
        position: Array.from(raw).indexOf("😀"),
      }),
    );

    render(<BatchLabelPanel />);
    await user.type(screen.getByTestId("label-raw"), raw);
    await user.click(screen.getByTestId("label-verify"));
    await screen.findByTestId("label-error");

    expect(screen.getByTestId("label-error-char")).toHaveTextContent("😀");
    expect(screen.getByTestId("label-raw-highlight")).toHaveTextContent(
      "(01)09506000134352(17)280930(10)L😀X",
    );
  });
});
