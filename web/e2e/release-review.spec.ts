import { expect, test, type Page } from "@playwright/test";

/**
 * 复制放行单复核端到端：真实 FastAPI 重算 CIEDE2000 / GS1 / 正文。
 * 覆盖自洽但未鉴真、数值/批号/空格/正文/多字段篡改、422 导入失败，
 * 以及复核入口与新批次放行表单、既有两个独立入口的状态隔离。
 */

const PASS_PAIR = {
  standard: { L: 60.2574, a: -34.0099, b: 36.2677 },
  sample: { L: 60.4626, a: -34.1751, b: 39.4387 },
};
const FAIL_SAMPLE = { L: 50.0, a: 0.0, b: -82.7485 };
const GTIN = "09506000134352";
const LABEL_OK = `(01)${GTIN}(10)INK2407(17)280930`;
const LABEL_SPACE = `(01)${GTIN}(10)INK2407 (17)280930`;

async function createRelease(page: Page, labelRaw = LABEL_OK, sample = PASS_PAIR.sample) {
  const response = await page.request.post("/api/batch-release", {
    data: {
      standard: PASS_PAIR.standard,
      sample,
      label_raw: labelRaw,
    },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.released).toBe(true);
  return body.release;
}

async function importReview(page: Page, document: unknown) {
  await page.getByTestId("release-review-input").fill(JSON.stringify(document));
  await page.getByTestId("release-review-import").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("有效复制单：内容自洽但无服务端签名，明确未鉴真并重建相同正文", async ({ page }) => {
  const release = await createRelease(page);
  await importReview(page, release);

  await expect(page.getByTestId("release-review-consistency")).toHaveText(
    "内容自洽（未鉴真）",
  );
  const auth = page.getByTestId("release-review-authenticity");
  await expect(auth).toHaveAttribute("data-authenticated", "false");
  await expect(auth).toContainText("不得据此认定签发来源真实");
  await expect(page.getByTestId("release-review-no-mismatch")).toBeVisible();
  await expect(page.getByTestId("release-review-rebuilt-text")).toHaveValue(release.text);
});

test("色差原值/判定篡改：依据内嵌 Lab 重算并列出判定字段不一致", async ({ page }) => {
  const release = await createRelease(page);
  release.sample = FAIL_SAMPLE;

  await importReview(page, release);

  await expect(page.getByTestId("release-review-consistency")).toHaveText(
    "内容不自洽（未鉴真）",
  );
  const color = page.getByTestId("review-color-result");
  await expect(color).toHaveAttribute("data-passed", "false");
  await expect(color.getByTestId("verdict")).toContainText("超差");
  await expect(page.getByText("result.passed")).toBeVisible();
  await expect(page.getByText("result.relation")).toBeVisible();
  await expect(page.getByTestId("release-review-invalid-release")).toBeVisible();
});

test("批号与标签尾随空格篡改：逐字符重新 GS1 解析并定位", async ({ page }) => {
  const release = await createRelease(page, LABEL_SPACE);
  expect(release.batch.lot).toBe("INK2407 ");
  release.batch.lot = "INK2407";

  await importReview(page, release);
  const item = page.locator('[data-testid^="release-review-mismatch-"]', {
    hasText: "batch.lot",
  });
  await expect(item).toContainText("原单：");
  await expect(item).toContainText("INK2407");
  await expect(item).toContainText("复算：");
  await expect(item).toContainText("INK2407␠");
  await expect(item).toContainText("内嵌批次字段");
});

test("正文篡改：用编号、时间、复算字段和标签快照重建并给出行列", async ({ page }) => {
  const release = await createRelease(page);
  const lines = release.text.split("\n");
  lines[5] = lines[5].replace("ΔE00=1.26", "ΔE00=9.99");
  release.text = lines.join("\n");

  await importReview(page, release);
  const item = page.getByTestId("release-review-mismatch-0");
  await expect(item).toContainText("text.lines[6]");
  await expect(item).toContainText("第 6 行，第 6 列");
});

test("多字段篡改：同一快照内一次列出多个不一致位置", async ({ page }) => {
  const release = await createRelease(page);
  release.standard.L = 61;
  release.batch.gtin = "09506000134353";
  release.text = `${release.text}\n伪造行`;

  await importReview(page, release);
  await expect(page.getByText(/result\./).first()).toBeVisible();
  await expect(page.getByText("batch.gtin")).toBeVisible();
  await expect(page.getByText(/text\.lines/).first()).toBeVisible();
});

test("导入 JSON 结构非法：422 不产生复核结果，也不影响新批次放行表单", async ({ page }) => {
  const release = await createRelease(page);
  delete release.result;

  await page.getByTestId("release.standard.L").fill("12");
  await page.getByTestId("release-label-raw").fill("LABEL-FORM-DRAFT");

  await importReview(page, release);
  const error = page.getByTestId("release-review-request-error");
  await expect(error).toContainText("导入失败");
  await expect(error).toContainText("result");
  await expect(page.getByTestId("release-review-result")).toHaveCount(0);

  // 新批次放行表单没有被 JSON 导入覆盖。
  await expect(page.getByTestId("release.standard.L")).toHaveValue("12");
  await expect(page.getByTestId("release-label-raw")).toHaveValue("LABEL-FORM-DRAFT");
  await expect(page.getByTestId("release-document")).toHaveCount(0);
});

test("复核成功后编辑 JSON：旧复核固定为导入快照，不被继续编辑改写", async ({ page }) => {
  const release = await createRelease(page);
  await importReview(page, release);
  await expect(page.getByTestId("release-review-no-mismatch")).toBeVisible();

  await page.getByTestId("release-review-input").type(" ");
  await expect(page.getByTestId("release-review-stale")).toContainText("未被继续编辑改写");
  await expect(page.getByTestId("release-review-no-mismatch")).toBeVisible();
});

test("复核入口不影响新批次放行流程和既有两个独立入口", async ({ page }) => {
  const release = await createRelease(page);
  await importReview(page, release);
  await expect(page.getByTestId("release-review-consistency")).toBeVisible();

  // 新批次组合表单仍为空，独立色差入口可正常使用。
  await expect(page.getByTestId("release.standard.L")).toHaveValue("");
  await expect(page.getByTestId("release-label-raw")).toHaveValue("");
  await page.getByTestId("standard.L").fill("50");
  await page.getByTestId("standard.a").fill("2.6772");
  await page.getByTestId("standard.b").fill("-79.7751");
  await page.getByTestId("sample.L").fill("50");
  await page.getByTestId("sample.a").fill("0");
  await page.getByTestId("sample.b").fill("-82.7485");
  await page.getByTestId("compare-button").click();
  await expect(page.getByTestId("result-panel")).toHaveAttribute("data-passed", "false");

  // 独立 GS1 入口也不受复核入口影响。
  await page.getByTestId("label-raw").fill(LABEL_OK);
  await page.getByTestId("label-verify").click();
  await expect(page.getByTestId("label-status")).toHaveText("已识别");

  // 复核结论仍是自洽，没有被任何其他入口操作改写。
  await expect(page.getByTestId("release-review-consistency")).toHaveText(
    "内容自洽（未鉴真）",
  );
});
