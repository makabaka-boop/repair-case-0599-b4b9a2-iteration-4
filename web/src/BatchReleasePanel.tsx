import { useMemo, useRef, useState } from "react";
import { postBatchRelease } from "./api";
import { BatchFieldsView, HighlightedRaw } from "./label-visuals";
import { ResultPanel } from "./ResultPanel";
import type {
  BatchReleaseSuccessResponse,
  ColorKey,
  ComponentKey,
  DeltaEResult,
  LabForm,
  ReleaseDocument,
} from "./types";
import { COMPONENT_BOUNDS, EMPTY_FORM } from "./types";
import {
  formToPayload,
  validateForm,
  type ClientErrors,
} from "./validation";

/**
 * 批次放行单（可选组合流程）。
 *
 * 一次提交标准色、样张 Lab 值与刚扫描的桶标签原文，后端复用既有色差判定与
 * GS1 解析，在**一次请求**里返回两项核验；只有色差放行且标签有效时才得到
 * 一张与本次请求固定绑定的放行单。
 *
 * 凭据安全（避免两项独立结果被误配）：
 * - 放行单一旦生成就**固定**于这次请求；之后编辑输入只会标记“当前表单与凭据
 *   不一致”，绝不改写凭据本身（凭据内快照不变、id 不变）；
 * - 连续提交时用单调递增的请求序号丢弃迟到响应：旧请求的成功/失败都不得
 *   覆盖更新请求的放行单或失败状态；
 * - 三种失败明确区分：请求异常（网络/422）、色差超差（200 内 color_check）、
 *   标签解析失败（200 内 label_check）；任何失败都不生成半张凭据。
 *
 * 本组件是独立的新入口：不读写上方色差比对与独立标签核验区，二者清理规则不变。
 */

const LAB_ORDER: ComponentKey[] = ["L", "a", "b"];

/** 凭据生成时的提交输入快照（数值化），用于与当前表单逐项比对身份。 */
interface PinnedInputs {
  standard: { L: number; a: number; b: number };
  sample: { L: number; a: number; b: number };
  label_raw: string;
}

function snapshotFromResponse(data: BatchReleaseSuccessResponse): PinnedInputs {
  return {
    standard: { ...data.inputs.standard },
    sample: { ...data.inputs.sample },
    label_raw: data.inputs.label_raw,
  };
}

/** 当前表单（字符串）与凭据快照（数值）逐项比较；非数值按不一致处理。 */
function formMatchesSnapshot(form: LabForm, snap: PinnedInputs): boolean {
  for (const color of ["standard", "sample"] as ColorKey[]) {
    for (const comp of LAB_ORDER) {
      const raw = form[color][comp].trim();
      const num = Number(raw);
      if (!Number.isFinite(num) || num !== snap[color][comp]) {
        return false;
      }
    }
  }
  return true;
}

export function BatchReleasePanel() {
  const [form, setForm] = useState<LabForm>(EMPTY_FORM);
  const [labelRaw, setLabelRaw] = useState("");
  const [clientErrors, setClientErrors] = useState<ClientErrors>({});
  const [busy, setBusy] = useState(false);

  // 最近一次请求的核验结果（200：可能放行，也可能一项/两项核验失败）
  const [outcome, setOutcome] = useState<BatchReleaseSuccessResponse | null>(null);
  // 已生成的放行单：独立钉住，后续失败或编辑都不改写它
  const [release, setRelease] = useState<ReleaseDocument | null>(null);
  // 放行单固定时的输入快照与“当前表单是否已偏离”标记
  const [pinnedInputs, setPinnedInputs] = useState<PinnedInputs | null>(null);
  // 请求异常（网络层 / 422 整次拒绝）：与“核验失败”明确区分
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestFields, setRequestFields] = useState<
    { field: string; message: string }[]
  >([]);
  const [copied, setCopied] = useState(false);

  // 单调递增请求序号：迟到响应（无论成功失败）一律丢弃
  const seqRef = useRef(0);

  const hasAnyError = useMemo(
    () => Object.keys(validateForm(form)).length > 0 || labelRaw.trim() === "",
    [form, labelRaw],
  );

  // 放行单与当前表单的一致性：输入快照逐字段一致且标签原文未改
  const releaseMismatch = useMemo(() => {
    if (!release || !pinnedInputs) return false;
    return (
      !formMatchesSnapshot(form, pinnedInputs) ||
      labelRaw !== pinnedInputs.label_raw
    );
  }, [release, pinnedInputs, form, labelRaw]);

  // 最近一次结果与当前表单不一致（结果已不能对应现在框内内容）
  const outcomeMismatch = useMemo(() => {
    if (!outcome) return false;
    const snap = snapshotFromResponse(outcome);
    return (
      !formMatchesSnapshot(form, snap) || labelRaw !== snap.label_raw
    );
  }, [outcome, form, labelRaw]);

  function handleLabChange(color: ColorKey, comp: ComponentKey, value: string) {
    const next = { ...form, [color]: { ...form[color], [comp]: value } };
    setForm(next);
    setCopied(false);
    // 即时本地校验只影响提交按钮与错误提示；不清空、不改写已生成的放行单
    setClientErrors(validateForm(next));
  }

  function handleLabelChange(value: string) {
    setLabelRaw(value);
    setCopied(false);
  }

  async function handleSubmit() {
    const errors = validateForm(form);
    setClientErrors(errors);
    if (Object.keys(errors).length > 0 || labelRaw.trim() === "") {
      // 本地输入不完整：不发请求；不改动既有放行单，仅由不一致标记提示
      return;
    }

    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setBusy(true);
    setRequestError(null);
    setRequestFields([]);
    setCopied(false);

    const result = await postBatchRelease({
      ...formToPayload(form),
      label_raw: labelRaw,
    });

    // 迟到响应：已有更新的请求发出，本响应（成功或失败）一律丢弃
    if (seq !== seqRef.current) return;
    setBusy(false);

    if (result.ok) {
      setOutcome(result.data);
      if (result.data.released && result.data.release) {
        // 只有双项通过才以新凭据替换旧凭据
        setRelease(result.data.release);
        setPinnedInputs(snapshotFromResponse(result.data));
      }
      return;
    }

    // 请求异常（网络层 status=0）或 422 整次拒绝：不产生结果，也绝不动旧凭据
    setOutcome(null);
    setRequestError(
      result.error?.message ??
        `请求失败（HTTP ${result.status}），未生成任何核验结果与放行单`,
    );
    setRequestFields(result.error?.errors ?? []);
  }

  function handleReset() {
    // 作废所有在途响应
    seqRef.current += 1;
    setForm(EMPTY_FORM);
    setLabelRaw("");
    setClientErrors({});
    setOutcome(null);
    setRelease(null);
    setPinnedInputs(null);
    setRequestError(null);
    setRequestFields([]);
    setCopied(false);
    setBusy(false);
  }

  async function handleCopy() {
    if (!release) return;
    try {
      await navigator.clipboard.writeText(release.text);
      setCopied(true);
    } catch {
      // 非安全上下文 / 权限拒绝：回退到选中可复制文本，凭据本身不变
      const node = document.getElementById("release-document-text");
      const ta = node as HTMLTextAreaElement | null;
      if (ta) {
        ta.focus();
        ta.select();
      }
    }
  }

  const labelError =
    outcome && !outcome.label_check.passed ? outcome.label_check.error : null;
  const colorResult: DeltaEResult | null = outcome
    ? outcome.color_check.result
    : null;

  return (
    <section className="release-panel" data-testid="release-panel">
      <h2>批次放行单（可选）</h2>
      <p className="hint-block">
        放行新油墨桶时，在<strong>同一次提交</strong>里给出标准色、首张样张
        L*a*b* 与刚扫描的桶标签原文：后端复用既有色差判定与 GS1 解析，
        <strong>色差放行且标签有效</strong>才生成一张与本次输入固定绑定、可复制的
        放行单。放行单生成后再改输入，只会标记不一致，不会改写凭据。
      </p>

      <div className="cards">
        {(["standard", "sample"] as ColorKey[]).map((color) => (
          <fieldset
            key={color}
            className="color-card"
            data-testid={`release-fieldset-${color}`}
          >
            <legend>
              <strong>{color === "standard" ? "标准色" : "首张样张"}</strong>
            </legend>
            <div className="fields">
              {LAB_ORDER.map((comp) => {
                const bound = COMPONENT_BOUNDS[comp];
                const fieldId = `release.${color}.${comp}`;
                const msg = clientErrors[`${color}.${comp}`];
                return (
                  <label key={comp} className="field" htmlFor={fieldId}>
                    <span className="field-label">
                      {bound.greek}
                      <small>
                        [{bound.min}, {bound.max}]
                      </small>
                    </span>
                    <input
                      id={fieldId}
                      data-testid={fieldId}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={Boolean(msg)}
                      aria-describedby={msg ? `${fieldId}-error` : undefined}
                      value={form[color][comp]}
                      onChange={(e) =>
                        handleLabChange(color, comp, e.target.value)
                      }
                    />
                    {msg && (
                      <span
                        id={`${fieldId}-error`}
                        className="field-error"
                        data-testid={`${fieldId}-error`}
                        role="alert"
                      >
                        {msg}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <label className="field label-input" htmlFor="release-label-raw">
        <span className="field-label">标签原文（与样张同一桶）</span>
        <textarea
          id="release-label-raw"
          data-testid="release-label-raw"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          placeholder="例如 (01)09506000134352(10)INK2407(17)280930"
          value={labelRaw}
          onChange={(e) => handleLabelChange(e.target.value)}
        />
      </label>

      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="release-submit"
          onClick={handleSubmit}
          /* 忙碌时不禁用：允许连续提交，迟到响应由请求序号丢弃而非靠锁按钮 */
          disabled={hasAnyError}
        >
          提交批次放行核验
        </button>
        <button
          type="button"
          data-testid="release-reset"
          onClick={handleReset}
          disabled={busy}
        >
          清空本流程
        </button>
        <span className="release-busy-hint" data-testid="release-busy" aria-live="polite">
          {busy ? "正在等待本次核验响应…" : ""}
        </span>
      </div>

      {/* 失败一：请求异常（无法连接 / 422 整次拒绝）——明确区别于核验失败 */}
      {requestError && (
        <div
          className="server-errors"
          data-testid="release-request-error"
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

      {/* 最近一次请求的核验结果（200；放行时含凭据，失败时无半张凭据） */}
      {outcome && !requestError && (
        <div className="release-outcome" data-testid="release-outcome">
          {outcomeMismatch && (
            <div
              className="release-mismatch"
              data-testid="release-outcome-mismatch"
              role="status"
            >
              当前表单已与本次提交的输入不一致：以下核验结果固定于上次请求，
              未被改写；重新提交后才会更新。
            </div>
          )}

          {colorResult && (
            <ResultPanel
              result={colorResult}
              testId="release-color-result"
            />
          )}

          {outcome.label_check.passed ? (
            <div
              className="label-result"
              data-testid="release-label-result"
              aria-live="polite"
            >
              <div className="check-line pass">
                标签核验：✅ 有效（
                {outcome.label_check.parsed.format === "readable"
                  ? "带括号可读格式"
                  : "扫码格式（FNC1 分隔）"}
                ）
              </div>
              <BatchFieldsView
                batch={outcome.label_check.parsed.batch}
                testIdPrefix="release-label"
              />
            </div>
          ) : (
            <div
              className="server-errors"
              data-testid="release-label-error"
              role="alert"
            >
              <strong>标签核验：⛔ {labelError?.message}</strong>
              {labelError &&
                labelError.position !== null &&
                labelError.position !== undefined && (
                  <>
                    <div className="error-position" data-testid="release-label-error-position">
                      首个无法解析的位置：第 {labelError.position + 1} 个字符
                    </div>
                    <HighlightedRaw
                      raw={labelRaw}
                      position={labelError.position}
                      testId="release-label-raw-highlight"
                      charTestId="release-label-error-char"
                    />
                  </>
                )}
            </div>
          )}

          {!outcome.released && (
            <p
              className="release-not-issued"
              data-testid="release-not-issued"
            >
              ⛔ 色差放行与标签有效未同时满足，<strong>不生成放行单</strong>
              （不存在半张凭据）。
            </p>
          )}
        </div>
      )}

      {/* 放行单：钉死于生成它的那次请求；编辑输入只标记不一致 */}
      {release && (
        <div className="release-document-wrap" data-testid="release-document">
          <div className="release-doc-head">
            <span className="release-doc-title">批次放行单（已固定于本次请求）</span>
            <button
              type="button"
              data-testid="release-copy"
              onClick={handleCopy}
            >
              {copied ? "已复制 ✓" : "复 制"}
            </button>
          </div>
          {copied && (
            <span className="release-copy-hint" data-testid="release-copy-hint">
              放行单全文已复制到剪贴板
            </span>
          )}
          {releaseMismatch && (
            <div
              className="release-mismatch"
              data-testid="release-mismatch"
              role="status"
            >
              当前表单与这张放行单的输入快照不一致：凭据<strong>未被改写</strong>
              （编号与快照保持不变）；只有重新提交且双项通过，才会生成新的放行单。
            </div>
          )}
          <dl className="release-doc-meta">
            <div>
              <dt>放行单编号</dt>
              <dd data-testid="release-doc-id">{release.id}</dd>
            </div>
            <div>
              <dt>生成时间 (UTC)</dt>
              <dd data-testid="release-doc-time">{release.generated_at}</dd>
            </div>
            <div>
              <dt>商品编码 GTIN</dt>
              <dd data-testid="release-doc-gtin">{release.batch.gtin}</dd>
            </div>
            <div>
              <dt>批号</dt>
              <dd className="verbatim-value" data-testid="release-doc-lot">
                {release.batch.lot.replace(/ /g, "␠")}
              </dd>
            </div>
            <div>
              <dt>失效日期</dt>
              <dd data-testid="release-doc-expires">{release.batch.expires}</dd>
            </div>
            <div>
              <dt>ΔE00</dt>
              <dd data-testid="release-doc-delta">
                {release.result.delta_e00_round.toFixed(2)}
              </dd>
            </div>
          </dl>
          <textarea
            id="release-document-text"
            data-testid="release-document-text"
            className="release-document-text"
            readOnly
            rows={14}
            value={release.text}
          />
        </div>
      )}
    </section>
  );
}
