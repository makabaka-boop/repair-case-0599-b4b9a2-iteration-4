import { expect, test, type Page } from "@playwright/test";

/**
 * 放行单复核（交接班独立入口）端到端：浏览器 → nginx → FastAPI，真实服务无打桩。
 * 覆盖：真实放行单复制件自洽但不鉴真、数值/批号/尾随空格/正文/多字段篡改逐项
 * 定位、JSON 语法失败与 422 不产生结论、复核固定于导入快照（迟到响应不改写）、
 * 以及与三个既有入口（色差/独立标签/批次放行单填写表单）的状态隔离。
 */

const PASS_PAIR = {
  standard: { L: 60.2574, a: -34.0099, b: 36.2677 },
  sample: { L: 60.4626, a: -34.1751, b: 39.4387 },
};
const GTIN = "09506000134352";
const LABEL_OK = `(01)${GTIN}(10)INK2407(17)280930`;

interface ReleaseDoc {
  id: string;
  generated_at: string;
  standard: { L: number; a: number; b: number };
  sample: { L: number; a: number; b: number };
  result: Record<string, unknown>;
  batch: { gtin: string; lot: string; expires: string };
  label_raw: string;
  text: string;
}

/** 经真实签发端点取得一张放行单（返回其结构化 release JSON）。 */
async function fetchGenuineRelease(page: Page): Promise<ReleaseDoc> {
  const resp = await page.request.post("/api/batch-release", {
    data: { ...PASS_PAIR, label_raw: LABEL_OK },
  });
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.released).toBe(true);
  return body.release as ReleaseDoc;
}

async function importForReview(page: Page, doc: unknown) {
  await page.getByTestId("review-json").fill(JSON.stringify(doc));
  await page.getByTestId("review-submit").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("真实复制件：内容自洽且五项全过，但明确未鉴真", async ({ page }) => {
  const doc = await fetchGenuineRelease(page);
  await importForReview(page, doc);

  const consistency = page.getByTestId("review-consistency");
  await expect(consistency).toHaveAttribute("data-consistent", "true");
  await expect(consistency).toContainText("内容自洽");

  // 内容自洽绝不等于来源鉴真：无签名复制件恒定“未鉴真”
  const auth = page.getByTestId("review-auth");
  await expect(auth).toHaveAttribute("data-authenticated", "false");
  await expect(auth).toContainText("未鉴真");
  await expect(auth).toContainText("签名");

  for (const name of ["meta", "color", "label", "release_rule", "text"]) {
    await expect(page.getByTestId(`review-check-${name}`)).toHaveAttribute(
      "data-failed",
      "false",
    );
  }
  await expect(page.getByTestId("review-mismatch")).toHaveCount(0);
  // 快照即本次导入单据
  await expect(page.getByTestId("review-snapshot-id")).toHaveText(doc.id);
  await expect(page.getByTestId("review-recomputed-lot")).toHaveText("INK2407");
  // 重建正文与单据正文逐字符相同
  const rebuilt = page.getByTestId("review-rebuilt-text");
  await expect(rebuilt).toHaveValue(doc.text);
});

test("数值篡改：内嵌 ΔE00 被改，复算定位 result 字段且判定仍以复算为准", async ({
  page,
}) => {
  const doc = await fetchGenuineRelease(page);
  const tampered = {
    ...doc,
    result: { ...doc.result, delta_e00: 9.99, delta_e00_round: 9.99 },
  };
  await importForReview(page, tampered);

  await expect(page.getByTestId("review-consistency")).toHaveAttribute(
    "data-consistent",
    "false",
  );
  await expect(page.getByTestId("review-check-color")).toHaveAttribute(
    "data-failed",
    "true",
  );
  const fields = await page
    .getByTestId("review-mismatch-field")
    .allTextContents();
  expect(fields).toContain("result.delta_e00");
  expect(fields).toContain("result.delta_e00_round");
  // 并排展示：单据声称 9.99，复算仍是真实 1.26
  const rows = page.getByTestId("review-mismatch");
  await expect(rows.filter({ hasText: "result.delta_e00_round" })).toContainText(
    "9.99",
  );
  await expect(page.getByTestId("review-recomputed-delta")).toHaveText("1.26");
  await expect(page.getByTestId("review-recomputed-passed")).toContainText("放行");
  // 即使不自洽，仍然不鉴真
  await expect(page.getByTestId("review-auth")).toContainText("未鉴真");
});

test("批号篡改：单据声称批号与标签原文复算批号不一致，逐项定位", async ({
  page,
}) => {
  const doc = await fetchGenuineRelease(page);
  // 只改结构化批次（标签原文没改）：声称 INK9999，原文复算 INK2407
  await importForReview(page, {
    ...doc,
    batch: { ...doc.batch, lot: "INK9999" },
  });

  await expect(page.getByTestId("review-check-label")).toHaveAttribute(
    "data-failed",
    "true",
  );
  await expect(page.getByTestId("review-mismatch-field")).toHaveText("batch.lot");
  await expect(page.getByTestId("review-snapshot-lot")).toHaveText("INK9999");
  await expect(page.getByTestId("review-recomputed-lot")).toHaveText("INK2407");
  // 只改结构化批号：正文重建使用的是**复算批号**（INK2407），与未改动的单据正文
  // 仍一致，因此只有 label 检查失败——不一致被精确限定在声称批次这一处
  await expect(page.getByTestId("review-check-label")).toHaveAttribute(
    "data-failed",
    "true",
  );
  await expect(page.getByTestId("review-check-text")).toHaveAttribute(
    "data-failed",
    "false",
  );
});

test("尾随空格：无空格单据塞入带空格原文，复算批号显示 INK2407␠", async ({
  page,
}) => {
  const doc = await fetchGenuineRelease(page);
  const withSpace = `(01)${GTIN}(10)INK2407 (17)280930`;
  await importForReview(page, { ...doc, label_raw: withSpace });

  await expect(page.getByTestId("review-check-label")).toHaveAttribute(
    "data-failed",
    "true",
  );
  await expect(page.getByTestId("review-recomputed-lot")).toHaveText("INK2407␠");
  await expect(page.getByTestId("review-snapshot-lot")).toHaveText(
    /^INK2407$/,
  );
});

test("正文篡改：定位到首个差异的行/列，并展示按复算字段重建的正文", async ({
  page,
}) => {
  const doc = await fetchGenuineRelease(page);
  const tamperedText = doc.text.replace("ΔE00=1.26", "ΔE00=9.99");
  await importForReview(page, { ...doc, text: tamperedText });

  await expect(page.getByTestId("review-check-text")).toHaveAttribute(
    "data-failed",
    "true",
  );
  const mm = page
    .getByTestId("review-mismatch")
    .filter({ hasText: "可读正文" });
  await expect(mm.getByTestId("review-mismatch-position")).toHaveText(
    "第 6 行第 6 列",
  );
  const rebuilt = page.getByTestId("review-rebuilt-text");
  await expect(rebuilt).toContainText("ΔE00=1.26");
  await expect(rebuilt).not.toContainText("ΔE00=9.99");
});

test("标签原文损坏：重新解析失败，组合规则与正文同时标记不一致", async ({
  page,
}) => {
  const doc = await fetchGenuineRelease(page);
  const bad = `(01)${GTIN.slice(0, -1)}3(10)INK2407(17)280930`;
  await importForReview(page, { ...doc, label_raw: bad });

  for (const name of ["label", "release_rule", "text"]) {
    await expect(page.getByTestId(`review-check-${name}`)).toHaveAttribute(
      "data-failed",
      "true",
    );
  }
  await expect(page.getByTestId("review-recomputed-gtin")).toContainText(
    "无法重新解析",
  );
  await expect(page.getByTestId("review-rebuilt-text")).toHaveValue(
    "（标签无法重新解析，正文不可重建）",
  );
});

test("多字段同时篡改：色差、批号、正文每处都列出", async ({ page }) => {
  const doc = await fetchGenuineRelease(page);
  await importForReview(page, {
    ...doc,
    result: { ...doc.result, delta_e00_round: 5.55 },
    batch: { ...doc.batch, lot: "INK7777" },
    text: doc.text.replace("INK2407", "INK7777"),
  });

  await expect(page.getByTestId("review-consistency")).toHaveAttribute(
    "data-consistent",
    "false",
  );
  const fields = await page
    .getByTestId("review-mismatch-field")
    .allTextContents();
  expect(fields).toContain("result.delta_e00_round");
  expect(fields).toContain("batch.lot");
  expect(fields).toContain("text");
  await expect(page.getByTestId("review-mismatch-title")).toContainText("3 处");
});

test("JSON 语法错误：本地拦截不发请求，页面无复核结论", async ({ page }) => {
  await page.getByTestId("review-json").fill("{not valid json");
  const [request] = await Promise.all([
    page
      .waitForRequest("**/api/release-review", { timeout: 1500 })
      .catch(() => null),
    page.getByTestId("review-submit").click(),
  ]);
  expect(request).toBeNull();
  await expect(page.getByTestId("review-parse-error")).toContainText(
    "JSON 解析失败",
  );
  await expect(page.getByTestId("review-report")).toHaveCount(0);
});

test("结构非法导入直达真实 API：422 整次拒绝，无复核结论", async ({ page }) => {
  const doc = await fetchGenuineRelease(page);
  const malformed = { ...doc };
  delete (malformed as Partial<ReleaseDoc>).result;

  const resp = await page.request.post("/api/release-review", {
    data: malformed,
  });
  expect(resp.status()).toBe(422);
  const body = await resp.json();
  expect(body.ok).toBe(false);
  expect(
    body.errors.some((e: { field: string }) => e.field === "result"),
  ).toBe(true);

  // 页面同样走 422 分支：显示字段错误、不出现结论
  await importForReview(page, malformed);
  await expect(page.getByTestId("review-request-error")).toContainText("result");
  await expect(page.getByTestId("review-report")).toHaveCount(0);
});

test("复核固定于导入快照：复核后继续编辑不改写结论；迟到响应也不改写", async ({
  page,
}) => {
  const doc = await fetchGenuineRelease(page);
  await importForReview(page, doc);
  const report = page.getByTestId("review-report");
  await expect(report).toBeVisible();
  const idBefore = await page.getByTestId("review-snapshot-id").textContent();

  // 复核后编辑 JSON：结论固定，只出现提示，且不产生新请求
  let edited = false;
  page.on("request", (req) => {
    if (req.url().includes("/api/release-review")) edited = true;
  });
  await page.getByTestId("review-json").fill(JSON.stringify(doc) + " ");
  await expect(page.getByTestId("review-draft-dirty")).toContainText(
    "固定于本次导入快照",
  );
  expect(await page.getByTestId("review-snapshot-id").textContent()).toBe(
    idBefore,
  );
  await page.waitForTimeout(300);
  expect(edited).toBe(false);

  // 乱序：第 1 个新导入挂起，第 2 个（篡改）先落地，第 1 个迟到响应不得回滚
  let releaseFirst: (() => void) | null = null;
  const firstGo = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const fireFirst = () => releaseFirst?.();
  let call = 0;
  await page.route("**/api/release-review", async (route) => {
    call += 1;
    const real = await route.fetch();
    const bodyText = await real.text();
    if (call === 1) {
      await firstGo;
      await route.fulfill({
        status: real.status(),
        contentType: "application/json",
        body: bodyText,
      });
      return;
    }
    await route.fulfill({
      status: real.status(),
      contentType: "application/json",
      body: bodyText,
    });
  });

  // 第 1 次导入：自洽件（挂起）
  await importForReview(page, doc);
  // 第 2 次导入：批号篡改件（立即落地）
  await importForReview(page, {
    ...doc,
    batch: { ...doc.batch, lot: "INK9999" },
  });
  await expect(page.getByTestId("review-snapshot-lot")).toHaveText("INK9999");
  await expect(page.getByTestId("review-check-label")).toHaveAttribute(
    "data-failed",
    "true",
  );

  // 第 1 个自洽响应迟到：必须丢弃，页面仍停留在“不自洽”结论
  fireFirst();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("review-snapshot-lot")).toHaveText("INK9999");
  await expect(page.getByTestId("review-check-label")).toHaveAttribute(
    "data-failed",
    "true",
  );
  await expect(page.getByTestId("review-consistency")).toHaveAttribute(
    "data-consistent",
    "false",
  );
});

test("页面状态隔离：复核不触碰新批次填写表单与既有放行单，也不影响两个独立入口", async ({
  page,
}) => {
  // 1) 先在批次放行单流程里生成一张放行单、保留表单内容
  await page.getByTestId("release.standard.L").fill(String(PASS_PAIR.standard.L));
  await page.getByTestId("release.standard.a").fill(String(PASS_PAIR.standard.a));
  await page.getByTestId("release.standard.b").fill(String(PASS_PAIR.standard.b));
  await page.getByTestId("release.sample.L").fill(String(PASS_PAIR.sample.L));
  await page.getByTestId("release.sample.a").fill(String(PASS_PAIR.sample.a));
  await page.getByTestId("release.sample.b").fill(String(PASS_PAIR.sample.b));
  await page.getByTestId("release-label-raw").fill(LABEL_OK);
  await page.getByTestId("release-submit").click();
  await expect(page.getByTestId("release-document")).toBeVisible();
  const releaseIdBefore = await page.getByTestId("release-doc-id").textContent();
  expect(releaseIdBefore).toBeTruthy();

  // 2) 在独立复核入口导入一张批号不同的复制件
  const doc = await fetchGenuineRelease(page);
  await importForReview(page, {
    ...doc,
    batch: { ...doc.batch, lot: "INK9999" },
  });
  await expect(page.getByTestId("review-consistency")).toHaveAttribute(
    "data-consistent",
    "false",
  );

  // 3) 新批次表单输入与既有放行单原样保留，不被复核导入覆盖
  await expect(page.getByTestId("release.standard.L")).toHaveValue(
    String(PASS_PAIR.standard.L),
  );
  await expect(page.getByTestId("release-label-raw")).toHaveValue(LABEL_OK);
  expect(await page.getByTestId("release-doc-id").textContent()).toBe(
    releaseIdBefore,
  );
  await expect(page.getByTestId("release-doc-lot")).toHaveText("INK2407");

  // 4) 顶部色差独立入口仍可工作，且不读复核状态
  await page.getByTestId("standard.L").fill("50");
  await page.getByTestId("standard.a").fill("2.6772");
  await page.getByTestId("standard.b").fill("-79.7751");
  await page.getByTestId("sample.L").fill("50");
  await page.getByTestId("sample.a").fill("0");
  await page.getByTestId("sample.b").fill("-82.7485");
  await page.getByTestId("compare-button").click();
  await expect(page.getByTestId("result-panel")).toHaveAttribute(
    "data-passed",
    "false",
  );

  // 5) 独立标签核验入口也不受影响
  await page.getByTestId("label-raw").fill(LABEL_OK);
  await page.getByTestId("label-verify").click();
  await expect(page.getByTestId("label-status")).toHaveText("已识别");
  await expect(page.getByTestId("label-lot")).toHaveText("INK2407");

  // 6) 复核结论与放行单凭据都还在，各自独立
  await expect(page.getByTestId("review-snapshot-lot")).toHaveText("INK9999");
  expect(await page.getByTestId("release-doc-id").textContent()).toBe(
    releaseIdBefore,
  );
});

test("清空复核只清空复核区，不影响其它流程", async ({ page }) => {
  const doc = await fetchGenuineRelease(page);
  await importForReview(page, doc);
  await expect(page.getByTestId("review-report")).toBeVisible();

  await page.getByTestId("review-reset").click();
  await expect(page.getByTestId("review-report")).toHaveCount(0);
  await expect(page.getByTestId("review-json")).toHaveValue("");
  expect(await page.getByTestId("review-submit").isDisabled()).toBe(true);

  // 顶部色差入口仍可用（未被清空）
  await expect(page.getByTestId("compare-button")).toBeVisible();
});
