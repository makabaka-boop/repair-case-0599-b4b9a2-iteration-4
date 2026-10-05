import { useState } from "react";
import { postGs1Label } from "./api";
import {
  BatchFieldsView,
  HighlightedRaw,
} from "./label-visuals";
import type { Gs1BatchInfo, Gs1LabelFormat } from "./types";

/**
 * 批次标签核验区：粘贴扫码枪读出的 GS1 标签原文，核验商品编码、批号、失效日期。
 *
 * 状态机：待输入(idle) → 已识别(recognized) / 已拒绝(rejected)。
 * 识别失败保留原文并高亮首个无法解析的位置；成功后可直接扫描下一桶。
 * 本区域状态完全独立，不读写标准色、样张与色差结论。
 */

type LabelStatus = "idle" | "recognized" | "rejected";

interface RejectInfo {
  message: string;
  position: number | null;
}

const STATUS_TEXT: Record<LabelStatus, string> = {
  idle: "待输入",
  recognized: "已识别",
  rejected: "已拒绝",
};

const FORMAT_TEXT: Record<Gs1LabelFormat, string> = {
  readable: "带括号可读格式",
  scan: "扫码格式（FNC1 分隔）",
};

export function BatchLabelPanel() {
  const [raw, setRaw] = useState("");
  const [status, setStatus] = useState<LabelStatus>("idle");
  const [batch, setBatch] = useState<Gs1BatchInfo | null>(null);
  const [format, setFormat] = useState<Gs1LabelFormat | null>(null);
  const [reject, setReject] = useState<RejectInfo | null>(null);
  const [loading, setLoading] = useState(false);

  function clearOutcome() {
    setStatus("idle");
    setBatch(null);
    setFormat(null);
    setReject(null);
  }

  function handleChange(value: string) {
    // 原文一经修改，既有结论（已识别/已拒绝）即与框内文本失去对应，
    // 必须立即回到待输入并清除旧批次信息与错误定位，等待重新核验。
    setRaw(value);
    clearOutcome();
  }

  async function handleVerify() {
    setLoading(true);
    const outcome = await postGs1Label(raw);
    setLoading(false);
    if (outcome.ok) {
      setStatus("recognized");
      setBatch(outcome.data.batch);
      setFormat(outcome.data.format);
      setReject(null);
    } else {
      // 识别失败：原文不清空，展示错误与首个无法解析的位置
      setStatus("rejected");
      setBatch(null);
      setFormat(null);
      const err = outcome.error;
      setReject({
        message: err?.message ?? `请求失败（HTTP ${outcome.status}）`,
        position: err?.position ?? null,
      });
    }  }

  function handleNextBucket() {
    // 继续扫描下一桶：清空输入和当前核验结论。
    setRaw("");
    clearOutcome();
  }

  return (
    <section className="label-panel" data-testid="label-panel">
      <h2>批次标签核验（GS1）</h2>
      <p className="hint-block">
        收料时粘贴扫码枪读出的油墨桶标签原文，支持带括号可读格式
        <code>(01)…(10)…(17)…</code> 与含 FNC1 分隔符的扫描格式。
        本区域只核验标签，不影响上方色差比对。
      </p>

      <div className="label-status-row">
        <span
          className={`label-status status-${status}`}
          data-testid="label-status"
          data-status={status}
        >
          {STATUS_TEXT[status]}
        </span>
        {format && status === "recognized" && (
          <span className="label-format" data-testid="label-format">
            {FORMAT_TEXT[format]}
          </span>
        )}
      </div>

      <label className="field label-input" htmlFor="label-raw">
        <span className="field-label">标签原文</span>
        <textarea
          id="label-raw"
          data-testid="label-raw"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          placeholder="例如 (01)09506000134352(10)INK2407(17)280930"
          value={raw}
          disabled={loading}
          onChange={(e) => handleChange(e.target.value)}
        />
      </label>

      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="label-verify"
          onClick={handleVerify}
          disabled={loading || raw.trim() === ""}
        >
          {loading ? "核验中…" : "核验标签"}
        </button>
        {status === "recognized" && (
          <button
            type="button"
            data-testid="label-next"
            onClick={handleNextBucket}
            disabled={loading}
          >
            扫描下一桶
          </button>
        )}
      </div>

      {status === "rejected" && reject && (
        <div className="server-errors" data-testid="label-error" role="alert">
          <strong>{reject.message}</strong>
          {/* position 可能为 0（首字符即无法解析），必须显式判空，不能用真值判断 */}
          {reject.position !== null && reject.position !== undefined && (
            <div className="error-position" data-testid="label-error-position">
              首个无法解析的位置：第 {reject.position + 1} 个字符
            </div>
          )}
          {reject.position !== null && reject.position !== undefined && (
            <HighlightedRaw raw={raw} position={reject.position} />
          )}
        </div>
      )}

      {status === "recognized" && batch && (
        <div className="label-result" data-testid="label-result" aria-live="polite">
          <BatchFieldsView batch={batch} testIdPrefix="label" />
        </div>
      )}
    </section>
  );
}
