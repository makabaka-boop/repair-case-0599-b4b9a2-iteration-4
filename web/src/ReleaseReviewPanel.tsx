import { useRef, useState } from "react";
import { postReleaseReview } from "./api";
import { BatchFieldsView, HighlightedRaw } from "./label-visuals";
import { ResultPanel } from "./ResultPanel";
import type {
  ReleaseReviewSuccessResponse,
  ReviewMismatch,
} from "./types";

/**
 * 复制放行单复核入口。
 *
 * 它接收“已经生成过的结构化放行单 JSON”，不会把任何导入内容写入上方新批次
 * 放行表单。成功复核只把结论钉在本次 parsed JSON 快照上；继续编辑 JSON、导入
 * 失败或旧请求迟到，都不能改写已经展示的复核结论。
 *
 * 注意两个结论严格分离：内容自洽只说明单据内部字段互相算得通；无服务端签名时
 * 绝不展示“已鉴真/来源真实”，只能展示“内容自洽（未鉴真）”。
 */

function visibleValue(value: unknown): string {
  if (typeof value === "string") return value.replace(/ /g, "␠");
  if (value === null) return "null";
  if (value === undefined) return "不存在";
  return JSON.stringify(value);
}

function MismatchList({ items }: { items: ReviewMismatch[] }) {
  return (
    <div className="review-mismatches" data-testid="release-review-mismatches">
      <h3>不一致位置（{items.length}）</h3>
      <ol>
        {items.map((item, index) => (
          <li
            key={`${item.field}-${index}`}
            className="review-mismatch-item"
            data-testid={`release-review-mismatch-${index}`}
          >
            <div className="review-mismatch-head">
              <code>{item.field}</code>
              {item.line !== null && item.line !== undefined && (
                <span>
                  第 {item.line} 行
                  {item.column !== null && item.column !== undefined
                    ? `，第 ${item.column} 列`
                    : ""}
                </span>
              )}
              {item.position !== null && item.position !== undefined && (
                <span>标签字符 {item.position + 1}</span>
              )}
            </div>
            <p>{item.message}</p>
            <div className="review-compare">
              <span>原单：</span>
              <code className="verbatim-value">{visibleValue(item.actual)}</code>
            </div>
            <div className="review-compare">
              <span>复算：</span>
              <code className="verbatim-value">{visibleValue(item.expected)}</code>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ReleaseReviewPanel() {
  const [jsonText, setJsonText] = useState("");
  const [review, setReview] = useState<ReleaseReviewSuccessResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [submittedText, setSubmittedText] = useState("");
  const seqRef = useRef(0);

  const isStale = review !== null && jsonText !== submittedText;
  const labelCheck = review?.recalculated.label_check;
  const recalculatedRelease = review?.recalculated.release;

  function handleChange(value: string) {
    // 编辑的是复核入口自己的 JSON；不触碰新批次放行表单。旧复核结论保留，
    // 仅提示它已固定于上一次导入快照。
    setJsonText(value);
  }

  async function handleImport() {
    let document: unknown;
    try {
      document = JSON.parse(jsonText);
    } catch (error) {
      const message = error instanceof Error ? error.message : "JSON 无法解析";
      // 客户端先发现格式错误：不发请求，也绝不清空/改写既有复核快照。
      setRequestError(`导入失败：JSON 语法错误（${message}）`);
      setFieldErrors([]);
      return;
    }

    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setBusy(true);
    setRequestError(null);
    setFieldErrors([]);

    const outcome = await postReleaseReview(document);

    // 较新的导入/重置已经发生：迟到响应（成功或失败）必须丢弃。
    if (seq !== seqRef.current) return;
    setBusy(false);

    if (outcome.ok) {
      setReview(outcome.data);
      setSubmittedText(jsonText);
      return;
    }

    // 导入失败只显示错误；旧复核结果固定不变。
    setRequestError(
      outcome.error?.message ??
        `请求失败（HTTP ${outcome.status}），未导入复核快照`,
    );
    setFieldErrors(outcome.error?.errors ?? []);
  }

  function handleReset() {
    seqRef.current += 1;
    setJsonText("");
    setReview(null);
    setRequestError(null);
    setFieldErrors([]);
    setSubmittedText("");
    setBusy(false);
  }

  return (
    <section className="review-panel" data-testid="release-review-panel">
      <h2>复制放行单复核（独立入口）</h2>
      <p className="hint-block">
        交接班时粘贴已复制出来的<strong>结构化放行单 JSON</strong>，系统将只依据单据
        内嵌的两组 Lab 原值与逐字符标签原文，重新执行 CIEDE2000、GS1 解析及组合放行规则，
        并用编号、时间和复算字段重建正文。该入口<strong>不会填写或覆盖上方新批次表单</strong>。
      </p>

      <label className="field label-input" htmlFor="release-review-input">
        <span className="field-label">结构化放行单 JSON</span>
        <textarea
          id="release-review-input"
          data-testid="release-review-input"
          rows={8}
          autoComplete="off"
          spellCheck={false}
          placeholder='粘贴完整 release 对象：{"id":...,"standard":...,"label_raw":...,"text":...}'
          value={jsonText}
          onChange={(event) => handleChange(event.target.value)}
        />
      </label>

      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="release-review-import"
          onClick={handleImport}
          disabled={jsonText.trim() === ""}
        >
          {busy ? "复核中…" : "导入并复核"}
        </button>
        <button
          type="button"
          data-testid="release-review-reset"
          onClick={handleReset}
        >
          清空复核入口
        </button>
        <span className="release-busy-hint" data-testid="release-review-busy" aria-live="polite">
          {busy ? "正在等待本次复核响应…" : ""}
        </span>
      </div>

      {requestError && (
        <div className="server-errors" data-testid="release-review-request-error" role="alert">
          <strong>{requestError}</strong>
          {fieldErrors.length > 0 && (
            <ul>
              {fieldErrors.map((err, index) => (
                <li key={`${err.field}-${index}`}>
                  <code>{err.field}</code>：{err.message}
                </li>
              ))}
            </ul>
          )}
          {review && (
            <p className="review-old-snapshot-note">
              本次导入失败；以下仍是上一次成功导入的复核快照，未被改写。
            </p>
          )}
        </div>
      )}

      {review && (
        <div className="review-result" data-testid="release-review-result">
          {isStale && (
            <div className="release-mismatch" data-testid="release-review-stale" role="status">
              JSON 输入已在上次导入后变动；当前复核结论固定于上一次成功导入的快照，
              未被继续编辑改写。请重新导入才会复核新内容。
            </div>
          )}

          <div
            className={`review-auth ${review.content_consistent ? "pass" : "fail"}`}
            data-testid="release-review-authenticity"
            data-authenticated="false"
            role="status"
          >
            <strong data-testid="release-review-consistency">
              {review.content_consistent ? "内容自洽（未鉴真）" : "内容不自洽（未鉴真）"}
            </strong>
            <p>{review.authenticity_message}</p>
          </div>

          <ResultPanel
            result={review.recalculated.color_check.result}
            testId="review-color-result"
          />

          {labelCheck?.passed ? (
            <div className="label-result" data-testid="review-label-result">
              <div className="check-line pass">
                标签原文复算解析：✅ 有效（
                {labelCheck.parsed.format === "readable"
                  ? "带括号可读格式"
                  : "扫码格式（FNC1 分隔）"}
                ）
              </div>
              <BatchFieldsView
                batch={labelCheck.parsed.batch}
                testIdPrefix="review-label"
              />
            </div>
          ) : (
            <div className="server-errors" data-testid="review-label-error" role="alert">
              <strong>标签原文复算解析：⛔ {labelCheck?.error.message}</strong>
              {labelCheck?.error.position !== null &&
                labelCheck?.error.position !== undefined && (
                  <>
                    <div className="error-position">
                      首个无法解析的位置：第 {labelCheck.error.position + 1} 个字符
                    </div>
                    <HighlightedRaw
                      raw={review.imported_snapshot.label_raw}
                      position={labelCheck.error.position}
                      testId="review-label-raw-highlight"
                    />
                  </>
                )}
            </div>
          )}

          {review.mismatches.length > 0 ? (
            <MismatchList items={review.mismatches} />
          ) : (
            <div className="review-ok" data-testid="release-review-no-mismatch">
              未发现色差判定、GS1 批次字段或正文不一致。该结论仅限内容自洽，不构成签发来源鉴真。
            </div>
          )}

          {recalculatedRelease && (
            <div className="review-rebuilt" data-testid="release-review-rebuilt">
              <h3>按本次导入快照复算重建</h3>
              <dl className="release-doc-meta">
                <div>
                  <dt>放行单编号</dt>
                  <dd>{recalculatedRelease.id}</dd>
                </div>
                <div>
                  <dt>生成时间 (UTC)</dt>
                  <dd>{recalculatedRelease.generated_at}</dd>
                </div>
                <div>
                  <dt>批号</dt>
                  <dd className="verbatim-value">
                    {recalculatedRelease.batch?.lot.replace(/ /g, "␠") ?? "无有效批次"}
                  </dd>
                </div>
              </dl>
              {recalculatedRelease.text ? (
                <textarea
                  className="release-document-text"
                  data-testid="release-review-rebuilt-text"
                  readOnly
                  rows={14}
                  value={recalculatedRelease.text}
                />
              ) : (
                <p className="release-not-issued" data-testid="release-review-invalid-release">
                  内嵌原值复算后不满足“色差放行且标签有效”，因此不能重建有效放行单正文。
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
