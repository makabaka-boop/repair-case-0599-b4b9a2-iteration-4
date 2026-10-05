import { expect, test } from "@playwright/test";

/**
 * 端到端联调：浏览器 → nginx → FastAPI，全程真实服务，无任何打桩。
 * 数值来自 Sharma (2005) 公开参考色对。
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

async function fillPair(page: import("@playwright/test").Page, pair: {
  standard: [number, number, number];
  sample: [number, number, number];
}) {
  const [l1, a1, b1] = pair.standard;
  const [l2, a2, b2] = pair.sample;
  await page.getByTestId("standard.L").fill(String(l1));
  await page.getByTestId("standard.a").fill(String(a1));
  await page.getByTestId("standard.b").fill(String(b1));
  await page.getByTestId("sample.L").fill(String(l2));
  await page.getByTestId("sample.a").fill(String(a2));
  await page.getByTestId("sample.b").fill(String(b2));
}

test("放行色对：呈现 ΔE00=1.26、<= 阈值与放行结论", async ({ page }) => {
  // Sharma 参考对 #25：ΔE00 = 1.2644
  await fillPair(page, {
    standard: [60.2574, -34.0099, 36.2677],
    sample: [60.4626, -34.1751, 39.4387],
  });
  await page.getByTestId("compare-button").click();

  const panel = page.getByTestId("result-panel");
  await expect(panel).toHaveAttribute("data-passed", "true");
  await expect(panel.getByTestId("verdict")).toContainText("放行");
  await expect(panel.getByTestId("metric-delta")).toContainText("1.26");
  await expect(panel.getByTestId("metric-relation")).toContainText("≤");
  await expect(panel.getByTestId("metric-relation")).toContainText("2.00");
  await expect(panel.getByTestId("metric-excess")).toContainText("0.00");
});

test("超差色对：呈现 ΔE00=2.04、> 阈值、超差与超出量 0.04", async ({ page }) => {
  // Sharma 参考对 #1：ΔE00 = 2.0425
  await fillPair(page, {
    standard: [50.0, 2.6772, -79.7751],
    sample: [50.0, 0.0, -82.7485],
  });
  await page.getByTestId("compare-button").click();

  const panel = page.getByTestId("result-panel");
  await expect(panel).toHaveAttribute("data-passed", "false");
  await expect(panel.getByTestId("verdict")).toContainText("超差");
  await expect(panel.getByTestId("metric-delta")).toContainText("2.04");
  await expect(panel.getByTestId("metric-relation")).toContainText(">");
  await expect(panel.getByTestId("metric-excess")).toContainText("0.04");
});

test("边界值端点可提交：L*=0/100、a*/b*=-128/127", async ({ page }) => {
  await fillPair(page, {
    standard: [0, -128, -128],
    sample: [100, 127, 127],
  });
  await expect(page.getByTestId("compare-button")).toBeEnabled();
  await page.getByTestId("compare-button").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();
});

test("越界输入被整次拒绝：UI 旧结论立即清除且不残留超差/放行", async ({ page }) => {
  // 先得到一个放行结论
  await fillPair(page, {
    standard: [60.2574, -34.0099, 36.2677],
    sample: [60.4626, -34.1751, 39.4387],
  });
  await page.getByTestId("compare-button").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();

  // 在已有放行结论后，把 sample.b 改成越界值：
  // 前端即时校验必须清掉旧结论并显示字段错误，比较按钮禁用
  await page.getByTestId("sample.b").fill("9999");
  await expect(page.getByTestId("sample.b-error")).toContainText("越界");
  await expect(page.getByTestId("result-panel")).toHaveCount(0);
  await expect(page.getByTestId("compare-button")).toBeDisabled();

  // 同一越界请求直达真实 API 也必须 422 整次拒绝
  const resp = await page.request.post("/api/delta-e", {
    data: {
      standard: { L: 50, a: 0, b: 0 },
      sample: { L: 50, a: 0, b: 9999 },
    },
  });
  expect(resp.status()).toBe(422);
  const body = await resp.json();
  expect(body.ok).toBe(false);
  expect(body.errors.some((e: { field: string }) => e.field === "sample.b")).toBe(true);
});

test("改回合法值后可重新得到结论（旧结论清除不锁死界面）", async ({ page }) => {
  await fillPair(page, {
    standard: [50.0, 2.6772, -79.7751],
    sample: [50.0, 0.0, -82.7485],
  });
  await page.getByTestId("compare-button").click();
  await expect(page.getByTestId("result-panel")).toHaveAttribute("data-passed", "false");

  // 清空一个字段 → 旧结论消失
  await page.getByTestId("sample.b").fill("");
  await expect(page.getByTestId("result-panel")).toHaveCount(0);

  // 填回放行色对 → 新结论出现且为放行
  await fillPair(page, {
    standard: [60.2574, -34.0099, 36.2677],
    sample: [60.4626, -34.1751, 39.4387],
  });
  await page.getByTestId("compare-button").click();
  const panel = page.getByTestId("result-panel");
  await expect(panel).toHaveAttribute("data-passed", "true");
  await expect(panel.getByTestId("verdict")).toContainText("放行");
});

test("直接 API 422：缺失字段返回逐字段错误", async ({ page }) => {
  const resp = await page.request.post("/api/delta-e", {
    data: {
      standard: { L: 50, a: 0 },
      sample: { L: 50, a: 0, b: 0 },
    },
  });
  expect(resp.status()).toBe(422);
  const body = await resp.json();
  expect(body.errors.some((e: { field: string }) => e.field === "standard.b")).toBe(true);
});

test("非有限值 NaN 被拒绝", async ({ page }) => {
  const resp = await page.request.post("/api/delta-e", {
    data: {
      standard: { L: 50, a: 0, b: 0 },
      sample: { L: 50, a: 0, b: NaN },
    },
  });
  expect(resp.status()).toBe(422);
  const body = await resp.json();
  expect(body.errors.some((e: { field: string }) => e.field === "sample.b")).toBe(true);
});
