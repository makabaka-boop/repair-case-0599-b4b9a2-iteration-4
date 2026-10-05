import { expect, test, type Page } from "@playwright/test";

/**
 * 批次放行单（组合流程）端到端：浏览器 → nginx → FastAPI，真实服务无打桩。
 * 覆盖：双项通过生成凭据、超差/标签无效/请求异常三种失败的页面状态区分、
 * 放行单固定后编辑输入只标记不一致、连续提交乱序响应不覆盖较新凭据、
 * 复制凭据，以及既有两个独立入口不受影响。
 */

// Sharma 参考对 #25：ΔE00 = 1.2644（放行）
const PASS_PAIR = {
  standard: [60.2574, -34.0099, 36.2677],
  sample: [60.4626, -34.1751, 39.4387],
};
// Sharma 参考对 #1：ΔE00 = 2.0425（超差）
const FAIL_PAIR = {
  standard: [50.0, 2.6772, -79.7751],
  sample: [50.0, 0.0, -82.7485],
};

const GTIN = "09506000134352";
const LABEL_OK = `(01)${GTIN}(10)INK2407(17)280930`;
const LABEL_ALT = `(01)${GTIN}(10)INK2408(17)280930`;
const LABEL_BAD_CHECK = `(01)${GTIN.slice(0, -1)}3(10)INK2407(17)280930`;

async function fillReleaseLab(
  page: Page,
  pair: { standard: number[]; sample: number[] },
) {
  const [l1, a1, b1] = pair.standard;
  const [l2, a2, b2] = pair.sample;
  await page.getByTestId("release.standard.L").fill(String(l1));
  await page.getByTestId("release.standard.a").fill(String(a1));
  await page.getByTestId("release.standard.b").fill(String(b1));
  await page.getByTestId("release.sample.L").fill(String(l2));
  await page.getByTestId("release.sample.a").fill(String(a2));
  await page.getByTestId("release.sample.b").fill(String(b2));
}

async function submitRelease(page: Page) {
  await page.getByTestId("release-submit").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("双项通过：生成与本次输入固定的放行单，凭据字段逐项可核对且可复制", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await submitRelease(page);

  // 两项核验都呈现
  const colorPanel = page.getByTestId("release-color-result");
  await expect(colorPanel).toHaveAttribute("data-passed", "true");
  await expect(colorPanel.getByTestId("verdict")).toContainText("放行");
  await expect(page.getByTestId("release-label-result")).toBeVisible();
  await expect(page.getByTestId("release-label-gtin")).toHaveText(GTIN);
  await expect(page.getByTestId("release-label-lot")).toHaveText("INK2407");
  await expect(page.getByTestId("release-label-expires")).toHaveText("2028-09-30");

  // 放行单：编号/批次/色差 + 与本次输入一致的快照
  const doc = page.getByTestId("release-document");
  await expect(doc).toBeVisible();
  const docId = await page.getByTestId("release-doc-id").textContent();
  expect(docId).toMatch(/^REL-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  await expect(page.getByTestId("release-doc-gtin")).toHaveText(GTIN);
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2407");
  await expect(page.getByTestId("release-doc-delta")).toHaveText("1.26");

  // 可复制整文内含本次标签原文（不是别的桶）
  const textArea = page.getByTestId("release-document-text");
  await expect(textArea).toContainText(LABEL_OK);
  await expect(textArea).toContainText(String(docId));

  // 复制按钮真的写入剪贴板
  await page.getByTestId("release-copy").click();
  await expect(page.getByTestId("release-copy-hint")).toBeVisible();
  const clipboard = await page.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(clipboard).toContain(`批次放行单 ${docId}`);
  expect(clipboard).toContain(LABEL_OK);

  // 不出现未生成/错误提示
  await expect(page.getByTestId("release-not-issued")).toHaveCount(0);
  await expect(page.getByTestId("release-request-error")).toHaveCount(0);
});

test("色差超差 × 标签有效：展示超差与有效标签，明确不生成放行单", async ({
  page,
}) => {
  await fillReleaseLab(page, FAIL_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await submitRelease(page);

  const colorPanel = page.getByTestId("release-color-result");
  await expect(colorPanel).toHaveAttribute("data-passed", "false");
  await expect(colorPanel.getByTestId("verdict")).toContainText("超差");
  await expect(colorPanel.getByTestId("metric-excess")).toContainText("0.04");
  // 标签核验仍然完成（两项独立，同请求都执行）
  await expect(page.getByTestId("release-label-gtin")).toHaveText(GTIN);
  // 明确不生成凭据
  await expect(page.getByTestId("release-not-issued")).toBeVisible();
  await expect(page.getByTestId("release-document")).toHaveCount(0);
});

test("色差放行 × 标签校验位错误：定位错误位置、无批次信息、无放行单", async ({
  page,
}) => {
  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_BAD_CHECK);
  await submitRelease(page);

  await expect(page.getByTestId("release-color-result")).toHaveAttribute(
    "data-passed",
    "true",
  );
  await expect(page.getByTestId("release-label-error")).toContainText("校验位");
  await expect(page.getByTestId("release-label-error-position")).toContainText(
    "第 18 个字符",
  );
  await expect(page.getByTestId("release-label-error-char")).toHaveText("3");
  await expect(page.getByTestId("release-label-raw-highlight")).toContainText(
    LABEL_BAD_CHECK,
  );
  await expect(page.getByTestId("release-label-result")).toHaveCount(0);
  await expect(page.getByTestId("release-not-issued")).toBeVisible();
  await expect(page.getByTestId("release-document")).toHaveCount(0);
});

test("失败后修正标签重新提交：从无凭据到生成放行单（失败页面可恢复）", async ({
  page,
}) => {
  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_BAD_CHECK);
  await submitRelease(page);
  await expect(page.getByTestId("release-label-error")).toBeVisible();
  await expect(page.getByTestId("release-document")).toHaveCount(0);

  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await submitRelease(page);
  await expect(page.getByTestId("release-document")).toBeVisible();
  await expect(page.getByTestId("release-label-error")).toHaveCount(0);
  await expect(page.getByTestId("release-not-issued")).toHaveCount(0);
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2407");
});

test("请求异常（网络中断）：区别于核验失败，无结果无凭据，稍后可重试成功", async ({
  page,
}) => {
  // 仅中断组合端点；真实后端其余部分照常
  await page.route("**/api/batch-release", (route) => route.abort("failed"));

  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await submitRelease(page);

  const errBox = page.getByTestId("release-request-error");
  await expect(errBox).toBeVisible();
  await expect(errBox).toContainText("无法连接");
  // 请求异常不是核验失败：没有两项核验结果，也没有凭据
  await expect(page.getByTestId("release-outcome")).toHaveCount(0);
  await expect(page.getByTestId("release-document")).toHaveCount(0);

  // 恢复网络后重新提交即可成功
  await page.unroute("**/api/batch-release");
  await submitRelease(page);
  await expect(page.getByTestId("release-document")).toBeVisible();
  await expect(page.getByTestId("release-request-error")).toHaveCount(0);
});

test("请求体 422（直达真实 API）：整次拒绝，与核验失败（200）区分", async ({
  page,
}) => {
  const resp = await page.request.post("/api/batch-release", {
    data: {
      standard: { L: 50, a: 0, b: 0 },
      sample: { L: 50, a: 0, b: 9999 },
      label_raw: LABEL_OK,
    },
  });
  expect(resp.status()).toBe(422);
  const body = await resp.json();
  expect(body.ok).toBe(false);
  expect(body.errors.some((e: { field: string }) => e.field === "sample.b")).toBe(
    true,
  );

  // 标签解析失败是 200 内核验失败，不是 422
  const resp2 = await page.request.post("/api/batch-release", {
    data: {
      standard: { L: PASS_PAIR.standard[0], a: PASS_PAIR.standard[1], b: PASS_PAIR.standard[2] },
      sample: { L: PASS_PAIR.sample[0], a: PASS_PAIR.sample[1], b: PASS_PAIR.sample[2] },
      label_raw: LABEL_BAD_CHECK,
    },
  });
  expect(resp2.status()).toBe(200);
  const body2 = await resp2.json();
  expect(body2.released).toBe(false);
  expect(body2.label_check.passed).toBe(false);
  expect(body2.label_check.error.code).toBe("invalid_checksum");
  expect(body2.release).toBeNull();
});

test("放行单固定：生成后编辑输入只标记不一致，凭据编号与快照不变；再提交才更新", async ({
  page,
}) => {
  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await submitRelease(page);
  const doc = page.getByTestId("release-document");
  await expect(doc).toBeVisible();
  const idBefore = (await page.getByTestId("release-doc-id").textContent()) ?? "";
  expect(idBefore).not.toBe("");
  await expect(page.getByTestId("release-mismatch")).toHaveCount(0);

  // 编辑 Lab（取一个仍满足 ΔE00 ≤ 2 的合法值 40，原 39.4387）：凭据原样保留，
  // 仅出现不一致标记
  await page.getByTestId("release.sample.b").fill("40");
  await expect(page.getByTestId("release-mismatch")).toContainText("未被改写");
  await expect(page.getByTestId("release-outcome-mismatch")).toBeVisible();
  expect(await page.getByTestId("release-doc-id").textContent()).toBe(idBefore);
  const snapshotText = page.getByTestId("release-document-text");
  await expect(snapshotText).toContainText("39.4387");
  // 新输入的 40 绝不出现在固定凭据里（精确成 token，避免与未舍入尾数巧合匹配）
  await expect(snapshotText).not.toContainText("b*=40");

  // 再编辑标签原文：标记仍在，批号快照不变
  await page.getByTestId("release-label-raw").fill(LABEL_ALT);
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2407");

  // 重新提交（新输入双项通过）→ 生成新凭据替换
  await submitRelease(page);
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2408");
  expect(await page.getByTestId("release-doc-id").textContent()).not.toBe(
    idBefore,
  );
  await expect(page.getByTestId("release-mismatch")).toHaveCount(0);
});

test("连续提交乱序：第 1 个响应迟到时不得覆盖第 2 个更新的放行单", async ({
  page,
}) => {
  // 第 1 次请求的真实响应先取到但暂不下发；第 2 次立即下发
  let releaseFirst: (() => void) | null = null;
  const firstGo = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const fireFirst = () => releaseFirst?.();
  let call = 0;
  await page.route("**/api/batch-release", async (route) => {
    call += 1;
    const real = await route.fetch();
    const body = await real.text();
    if (call === 1) {
      await firstGo; // 挂起第 1 个响应，直到第 2 个落地后再放行
      await route.fulfill({
        status: real.status(),
        contentType: "application/json",
        body,
      });
      return;
    }
    await route.fulfill({
      status: real.status(),
      contentType: "application/json",
      body,
    });
  });

  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await submitRelease(page);

  // 第 1 个请求在途时改桶并第 2 次提交（输入不锁）
  await expect(page.getByTestId("release-label-raw")).toBeEnabled();
  await page.getByTestId("release-label-raw").fill(LABEL_ALT);
  await submitRelease(page);

  // 较新响应先落地：凭据属于第 2 次请求
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2408");
  const idNew = await page.getByTestId("release-doc-id").textContent();

  // 第 1 个响应迟到：丢弃，页面仍是第 2 张凭据
  fireFirst();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2408");
  expect(await page.getByTestId("release-doc-id").textContent()).toBe(idNew);
  await expect(page.getByTestId("release-document")).toHaveCount(1);
});

test("清空本流程：凭据、核验结果、输入全部移除", async ({ page }) => {
  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await submitRelease(page);
  await expect(page.getByTestId("release-document")).toBeVisible();

  await page.getByTestId("release-reset").click();
  await expect(page.getByTestId("release-document")).toHaveCount(0);
  await expect(page.getByTestId("release-outcome")).toHaveCount(0);
  await expect(page.getByTestId("release.standard.L")).toHaveValue("");
  await expect(page.getByTestId("release-label-raw")).toHaveValue("");
  await expect(page.getByTestId("release-submit")).toBeDisabled();
});

test("批号尾随空格：放行单批号逐字符显示为 INK2407␠，标签原文快照保留空格", async ({
  page,
}) => {
  const withSpace = `(01)${GTIN}(10)INK2407 (17)280930`;
  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(withSpace);
  await submitRelease(page);

  await expect(page.getByTestId("release-document")).toBeVisible();
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2407␠");
  await expect(page.getByTestId("release-label-lot")).toHaveText("INK2407␠");
  await expect(page.getByTestId("release-document-text")).toContainText(withSpace);
});

test("组合流程不影响既有两个独立入口", async ({ page }) => {
  // 先在组合流程里得到放行单
  await fillReleaseLab(page, PASS_PAIR);
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await submitRelease(page);
  await expect(page.getByTestId("release-document")).toBeVisible();

  // 独立色差入口照常工作（自己的输入与结论，testid 不冲突）
  const mainL = page.getByTestId("standard.L");
  await mainL.fill(String(FAIL_PAIR.standard[0]));
  await page.getByTestId("standard.a").fill(String(FAIL_PAIR.standard[1]));
  await page.getByTestId("standard.b").fill(String(FAIL_PAIR.standard[2]));
  await page.getByTestId("sample.L").fill(String(FAIL_PAIR.sample[0]));
  await page.getByTestId("sample.a").fill(String(FAIL_PAIR.sample[1]));
  await page.getByTestId("sample.b").fill(String(FAIL_PAIR.sample[2]));
  await page.getByTestId("compare-button").click();
  const mainResult = page.getByTestId("result-panel");
  await expect(mainResult).toHaveAttribute("data-passed", "false");
  await expect(mainResult.getByTestId("verdict")).toContainText("超差");

  // 独立标签核验入口也照常（损坏标签被拒绝，定位与组合面板互不干扰）
  await page.getByTestId("label-raw").fill(LABEL_BAD_CHECK);
  await page.getByTestId("label-verify").click();
  await expect(page.getByTestId("label-status")).toHaveText("已拒绝");
  await expect(page.getByTestId("label-error-char")).toHaveText("3");

  // 组合放行单未被两个独立入口的操作改写
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2407");
});
