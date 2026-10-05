import { useRef, useState } from "react";
import { postReleaseReview } from "./api";
import { VisibleValue } from "./label-visuals";
import type {
  ReleaseReviewResponse,
  ReviewCheckName,
  ReviewMismatch,
} from "./types";

/**
 * 放行单复核（交接班独立入口）。
 *
 * 接班调色员粘贴一张**复制出来的结构化放行单 JSON**，后端用单据内嵌的两组
 * Lab 原值与逐字符标签原文，重新走现有 CIEDE2000 判定、GS1 解析与组合放行
 * 规则，再用单据自身编号、时间与复算字段重建正文，逐项定位不一致。
 *
 * 两条不可逾越的边界：
 * - **内容自洽 ≠ 签发来源真实**：没有服务端签名的旧单最多得到“内容自洽”，
 *   页面恒定展示“未鉴真”，不冒称已验证来源；
 * - **复核固定于本次导入快照**：复核只读取粘贴内容；导入失败（JSON 语法错/
 *   422/网络异常）不出结论，继续编辑 JSON 或迟到响应都**不能改写**已呈现的
 *   复核结果，更不会触碰上方正在填写的新批次表单与既有放行单。
 *
 * 本组件是独立入口：不读写色差比对、独立标签核验与批次放行单三个流程。
 */

const CHECK_LABELS: Record<ReviewCheckName, string> = {
  meta: "编号/时间一致性",
  color: "色差复算（CIEDE2000）",
  label: "标签重新解析（GS1）",
  release_rule: "组合放行规则",
  text: "可读正文重建",
};

const CHECK_ORDER: ReviewCheckName[] = [
  "meta",
  "color",
  "label",
  "release_rule",
  "text",
];

function MismatchRow({ mismatch }: { mismatch: ReviewMismatch }) {
  return (
    <li className="review-mismatch" data-testid="review-mismatch">
      <div className="review-mismatch-head">
        <code data-testid="review-mismatch-field">{mismatch.field}</code>
        {mismatch.position &&
          mismatch.position.line !== null &&
          mismatch.position.column !== null && (
            <span
              className="review-mismatch-pos"
              data-testid="review-mismatch-position"
            >
              第 {mismatch.position.line} 行第 {mismatch.position.column} 列
            </span>
          )}
      </div>
      <div data-testid="review-mismatch-message">{mismatch.message}</div>
      <div className="review-compare">
        <span>
          单据声称：
          <code data-testid="review-mismatch-embedded">
            {formatValue(mismatch.embedded)}
          </code>
        </span>
        <span>
          复算结果：
          <code data-testid="review-mismatch-recomputed">
            {formatValue(mismatch.recomputed)}
          </code>
        </span>
      </div>
    </li>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null) return "（无）";
  if (v === undefined) return "（无）";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function ReleaseReviewPanel() {
  const [draft, setDraft] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 已落地的复核结论：钉死于产生它的那次导入，编辑草稿不改写它
  const [report, setReport] = useState<ReleaseReviewResponse | null>(null);
  // 该结论对应的导入快照（逐字符），用于检测草稿事后是否又被改动
  const [pinnedJson, setPinnedJson] = useState<string | null>(null);
  // 导入失败（422 字段错误 / 网络异常）：区别于“复核出不自洽”（200）
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestFields, setRequestFields] = useState<
    { field: string; message: string }[]
  >([]);

  // 单调递增请求序号：迟到响应一律丢弃
  const seqRef = useRef(0);

  const draftDirty = pinnedJson !== null && draft !== pinnedJson;

  function handleDraftChange(value: string) {
    setDraft(value);
    setParseError(null);
    // 只清本地语法提示；已落地结论固定于导入快照，绝不清空/改写
  }

  async function handleReview() {
    if (draft.trim() === "") return;

    // 本地先做 JSON 语法检查：语法坏不发请求，也不产生/改写任何复核结论
    let document: unknown;
    try {
      document = JSON.parse(draft);
    } catch (e) {
      setParseError(`JSON 解析失败：${(e as Error).message}（未发送导入请求）`);
      return;
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      setParseError("导入内容必须是一个放行单 JSON 对象（不能是数组或其他类型），未发送导入请求");
      return;
    }

    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setBusy(true);
    setRequestError(null);
    setRequestFields([]);
    setParseError(null);

    const outcome = await postReleaseReview(document);

    // 迟到响应：已有更新的导入发出，本响应（成功或失败）一律丢弃
    if (seq !== seqRef.current) return;
    setBusy(false);

    if (outcome.ok) {
      // 固定于本次导入快照
      setReport(outcome.data);
      setPinnedJson(draft);
      return;
    }

    // 导入失败：不产生复核结论，也绝不动上一份已落地结论
    setRequestError(
      outcome.error?.message ??
        `导入失败（HTTP ${outcome.status}），未生成复核结论`,
    );
    setRequestFields(outcome.error?.errors ?? []);
  }

  function handleReset() {
    seqRef.current += 1; // 作废所有在途响应
    setDraft("");
    setParseError(null);
    setBusy(false);
    setReport(null);
    setPinnedJson(null);
    setRequestError(null);
    setRequestFields([]);
  }

  const mismatchesByCheck = new Map<ReviewCheckName, ReviewMismatch[]>();
  if (report) {
    for (const m of report.checks.mismatches) {
      const list = mismatchesByCheck.get(m.check) ?? [];
      list.push(m);
      mismatchesByCheck.set(m.check, list);
    }
  }

  return (
    <section className="review-panel" data-testid="review-panel">
      <h2>放行单复核（交接班，独立入口）</h2>
      <p className="hint-block">
        接班时粘贴一张<strong>复制出来的结构化放行单 JSON</strong>：
        系统用单据内嵌的两组 Lab 原值与逐字符标签原文，重新走色差判定、GS1
        解析与组合放行规则，并用单据自身编号、时间和复算字段重建正文，逐项
        指出不一致。本入口<strong>只判内容自洽，不验证签发来源</strong>；
        复核结果固定于本次导入快照，不会改写上方正在填写的新批次表单或既有放行单。
      </p>

      <label className="field label-input" htmlFor="review-json">
        <span className="field-label">放行单 JSON（复制件）</span>
        <textarea
          id="review-json"
          data-testid="review-json"
          rows={8}
          autoComplete="off"
          spellCheck={false}
          placeholder='{"id":"REL-…","generated_at":"…","standard":{…},…}'
          value={draft}
          onChange={(e) => handleDraftChange(e.target.value)}
        />
      </label>

      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="review-submit"
          onClick={handleReview}
          /* 忙碌时不禁用：允许连续导入，迟到响应由请求序号丢弃而非靠锁按钮 */
          disabled={draft.trim() === ""}
        >
          {busy ? "复核中…" : "导入并复核"}
        </button>
        <button
          type="button"
          data-testid="review-reset"
          onClick={handleReset}
        >
          清空复核
        </button>
        <span className="review-busy-hint" data-testid="review-busy" aria-live="polite">
          {busy ? "正在等待本次复核响应…" : ""}
        </span>
      </div>

      {/* 本地 JSON 语法错：不发请求、无结论 */}
      {parseError && (
        <div className="server-errors" data-testid="review-parse-error" role="alert">
          <strong>{parseError}</strong>
        </div>
      )}

      {/* 导入失败（422 结构非法 / 网络异常）：无复核结论，且不动旧结论 */}
      {requestError && (
        <div
          className="server-errors"
          data-testid="review-request-error"
          role="alert"
        >
          <strong>{requestError}</strong>
          {requestFields.length > 0 && (
            <ul>
              {requestFields.map((err, i) => (
                <li key={`${err.field}-${i}`}>
                  <code>{err.field}</code>：{err.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 复核结论：固定于产生它的导入快照 */}
      {report && (
        <div className="review-report" data-testid="review-report">
          {draftDirty && (
            <div
              className="review-pinned-note"
              data-testid="review-draft-dirty"
              role="status"
            >
              输入框已在复核后被改动：以下结论<strong>固定于本次导入快照</strong>，
              未被改写；需重新点击“导入并复核”才会产生新结论。
            </div>
          )}

          {/* 自洽结论与鉴真结论分两行，明确不可互相替代 */}
          <div
            className={`review-verdict ${report.content_self_consistent ? "pass" : "fail"}`}
            data-testid="review-consistency"
            data-consistent={report.content_self_consistent ? "true" : "false"}
          >
            {report.content_self_consistent
              ? "✅ 内容自洽：单据内嵌原值与自身声称的判定、批次、正文逐项一致"
              : "⛔ 内容不自洽：下列位置的原判定、解析批次或正文与复算结果不一致"}
          </div>
          <div
            className="review-auth"
            data-testid="review-auth"
            data-authenticated="false"
            role="note"
          >
            🔏 签发来源：<strong>未鉴真</strong>
            <div className="review-auth-message">{report.authentication.message}</div>
          </div>

          {/* 五个检查项逐项状态 */}
          <ul className="review-checks" data-testid="review-checks">
            {CHECK_ORDER.map((name) => {
              const failed = report.checks.failed.includes(name);
              return (
                <li
                  key={name}
                  className={`review-check ${failed ? "fail" : "pass"}`}
                  data-testid={`review-check-${name}`}
                  data-failed={failed ? "true" : "false"}
                >
                  {failed ? "⛔" : "✅"} {CHECK_LABELS[name]}
                </li>
              );
            })}
          </ul>

          {report.checks.mismatches.length > 0 && (
            <div className="review-mismatches">
              <h3 data-testid="review-mismatch-title">
                不一致位置（{report.checks.mismatches.length} 处）
              </h3>
              <ul>
                {report.checks.mismatches.map((m, i) => (
                  <MismatchRow key={`${m.check}-${m.field}-${i}`} mismatch={m} />
                ))}
              </ul>
            </div>
          )}

          {/* 复算出的色差结论与批次（自洽时与单据声称相同，不自洽时供核对） */}
          <div className="review-recomputed" data-testid="review-recomputed">
            <h3>本次复算结果</h3>
            <dl>
              <div>
                <dt>复算 ΔE00（两位小数）</dt>
                <dd data-testid="review-recomputed-delta">
                  {report.recomputed.color.delta_e00_round.toFixed(2)}
                </dd>
              </div>
              <div>
                <dt>复算判定</dt>
                <dd data-testid="review-recomputed-passed">
                  {report.recomputed.color.passed ? "✅ 放行" : "⛔ 超差"}
                </dd>
              </div>
              <div>
                <dt>复算商品编码 GTIN</dt>
                <dd data-testid="review-recomputed-gtin">
                  {report.recomputed.batch?.gtin ?? "（标签无法重新解析）"}
                </dd>
              </div>
              <div>
                <dt>复算批号（空格显式为 ␠）</dt>
                {report.recomputed.batch ? (
                  <VisibleValue
                    text={report.recomputed.batch.lot}
                    testId="review-recomputed-lot"
                  />
                ) : (
                  <dd data-testid="review-recomputed-lot">（标签无法重新解析）</dd>
                )}
              </div>
              <div>
                <dt>复算失效日期</dt>
                <dd data-testid="review-recomputed-expires">
                  {report.recomputed.batch?.expires ?? "（标签无法重新解析）"}
                </dd>
              </div>
            </dl>
          </div>

          {/* 导入快照回显：证明结论固定于这次导入 */}
          <div className="review-snapshot" data-testid="review-snapshot">
            <h3>本次导入快照（结论固定于此）</h3>
            <dl>
              <div>
                <dt>单据编号</dt>
                <dd data-testid="review-snapshot-id">{report.imported.id}</dd>
              </div>
              <div>
                <dt>生成时间 (UTC)</dt>
                <dd data-testid="review-snapshot-time">
                  {report.imported.generated_at}
                </dd>
              </div>
              <div>
                <dt>单据声称批号</dt>
                <VisibleValue
                  text={report.imported.batch.lot}
                  testId="review-snapshot-lot"
                />
              </div>
            </dl>
            <div>
              <div className="review-text-label">按编号/时间/复算字段重建的正文：</div>
              <textarea
                data-testid="review-rebuilt-text"
                className="review-rebuilt-text"
                readOnly
                rows={14}
                value={report.recomputed.text ?? "（标签无法重新解析，正文不可重建）"}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
