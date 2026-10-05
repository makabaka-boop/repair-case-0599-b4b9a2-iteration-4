import type { DeltaEResult } from "./types";

interface ResultPanelProps {
  result: DeltaEResult;
  /** 同一页面嵌入多处时用不同 testid 隔离（默认保持既有 result-panel）。 */
  testId?: string;
}

function fmt2(v: number): string {
  return v.toFixed(2);
}

export function ResultPanel({ result, testId = "result-panel" }: ResultPanelProps) {
  const { passed } = result;
  return (
    <section
      className={`result ${passed ? "pass" : "fail"}`}
      data-testid={testId}
      data-passed={passed ? "true" : "false"}
      aria-live="polite"
    >
      <div className="verdict" data-testid="verdict">
        {passed ? "✅ 放行" : "⛔ 超差"}
      </div>

      <div className="metric" data-testid="metric-delta">
        <span className="metric-name">ΔE00</span>
        <span className="metric-value">{fmt2(result.delta_e00_round)}</span>
      </div>

      <div className="relation" data-testid="metric-relation">
        <span className="formula">
          ΔE00（未舍入 {result.delta_e00.toFixed(6)}）{passed ? "≤" : ">"} 阈值{" "}
          {fmt2(result.threshold)}
        </span>
        <span className="relation-word">
          {passed ? "未超过阈值，可以继续印刷" : "已超过阈值，不得继续印刷"}
        </span>
      </div>

      <div className="metric" data-testid="metric-excess">
        <span className="metric-name">超出量</span>
        <span className="metric-value">
          {passed ? "0.00" : fmt2(result.excess_round)}
        </span>
        {!passed && (
          <small className="excess-note">
            （未舍入超出 {result.excess_raw.toFixed(6)}）
          </small>
        )}
      </div>
    </section>
  );
}
