import { useMemo, useState } from "react";
import { postDeltaE } from "./api";
import { BatchLabelPanel } from "./BatchLabelPanel";
import { BatchReleasePanel } from "./BatchReleasePanel";
import { ColorFieldSet } from "./ColorFieldSet";
import { ResultPanel } from "./ResultPanel";
import type {
  ColorKey,
  ComponentKey,
  DeltaEResult,
  FieldError,
  LabForm,
} from "./types";
import { EMPTY_FORM } from "./types";
import { formToPayload, validateForm, type ClientErrors } from "./validation";

export default function App() {
  const [form, setForm] = useState<LabForm>(EMPTY_FORM);
  const [result, setResult] = useState<DeltaEResult | null>(null);
  const [clientErrors, setClientErrors] = useState<ClientErrors>({});
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [fatalMessage, setFatalMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comparedInputs, setComparedInputs] = useState<LabForm | null>(null);

  // 按钮可用性始终由当前表单实时推导：有任何字段不合法（含初始为空）就禁用
  const hasAnyError = useMemo(
    () => Object.keys(validateForm(form)).length > 0,
    [form],
  );

  function handleChange(color: ColorKey, comp: ComponentKey, value: string) {
    setForm((prev) => ({
      ...prev,
      [color]: { ...prev[color], [comp]: value },
    }));
    // 任何编辑后先即时校验；本地校验失败立即清除上一张样张的旧结论
    const next = {
      ...form,
      [color]: { ...form[color], [comp]: value },
    };
    const errors = validateForm(next);
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) {
      setResult(null);
      setServerErrors([]);
      setFatalMessage(null);
    }
  }

  async function handleCompare() {
    const errors = validateForm(form);
    setClientErrors(errors);
    // 缺失 / 非有限 / 越界：整次拒绝并清除旧结果
    if (Object.keys(errors).length > 0) {
      setResult(null);
      setServerErrors([]);
      setFatalMessage(null);
      setComparedInputs(null);
      return;
    }

    setBusy(true);
    setServerErrors([]);
    setFatalMessage(null);
    const outcome = await postDeltaE(formToPayload(form));
    setBusy(false);

    if (outcome.ok) {
      // 只有服务端接受并计算成功时才呈现结论
      setResult(outcome.data.result);
      setComparedInputs(form);
    } else {
      // 422 或网络错误：整次拒绝，旧结论必须清除
      setResult(null);
      setComparedInputs(null);
      if (outcome.error) {
        setServerErrors(outcome.error.errors ?? []);
        setFatalMessage(outcome.error.message ?? "请求被拒绝");
      } else {
        setFatalMessage(`请求失败（HTTP ${outcome.status}）`);
      }
    }
  }

  function handleReset() {
    setForm(EMPTY_FORM);
    setResult(null);
    setClientErrors({});
    setServerErrors([]);
    setFatalMessage(null);
    setComparedInputs(null);
  }

  return (
    <main className="page">
      <header>
        <h1>专色墨首张样张 CIEDE2000 放行比对</h1>
        <p className="subhead">
          换墨后，比较标准色与首张样张：未舍入 ΔE00 ≤ 2.00 放行，否则超差。
          ΔE00 仅在最终展示时四舍五入到两位小数。
        </p>
      </header>

      <div className="cards">
        <ColorFieldSet
          colorKey="standard"
          title="标准色"
          hint="客户/工艺标准 L*a*b*"
          values={form.standard}
          errors={clientErrors}
          disabled={busy}
          onChange={handleChange}
        />
        <ColorFieldSet
          colorKey="sample"
          title="首张样张"
          hint="本次开机第一张印样"
          values={form.sample}
          errors={clientErrors}
          disabled={busy}
          onChange={handleChange}
        />
      </div>

      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="compare-button"
          onClick={handleCompare}
          disabled={busy || hasAnyError}
        >
          {busy ? "比对中…" : "比较标准色与首张样张"}
        </button>
        <button
          type="button"
          data-testid="reset-button"
          onClick={handleReset}
          disabled={busy}
        >
          清空重置
        </button>
      </div>

      {serverErrors.length > 0 && (
        <div className="server-errors" data-testid="server-errors" role="alert">
          <strong>{fatalMessage ?? "输入被整次拒绝"}</strong>
          <ul>
            {serverErrors.map((err, i) => (
              <li key={`${err.field}-${i}`}>
                <code>{err.field}</code>：{err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {fatalMessage && serverErrors.length === 0 && (
        <div className="server-errors" data-testid="server-errors" role="alert">
          {fatalMessage}
        </div>
      )}

      {result && comparedInputs && (
        <ResultPanel result={result} />
      )}
      {!result && (
        <p className="placeholder" data-testid="no-result">
          尚无结论：请输入两组完整且合法的 L*a*b* 后点击“比较”。
        </p>
      )}

      <hr className="divider" />

      {/* 标签核验与色差比对各自独立忙碌，互不锁定：标签请求不锁 Lab 输入/比对/重置，
          色差请求也不锁标签输入/核验；标签服务异常不阻断色差作业。 */}
      <BatchLabelPanel />

      <hr className="divider" />

      {/* 可选组合流程：自己的输入与凭据状态完全独立，不读写上方两个入口。 */}
      <BatchReleasePanel />
    </main>
  );
}
