/**
 * 前端本地校验，规则与 FastAPI 完全一致（缺失、非有限、越界整次拒绝）。
 * 本地校验只是即时反馈；最终结论始终以后端为准。
 */
import { COMPONENT_BOUNDS, type ColorKey, type ComponentKey, type LabForm } from "./types";

export type ClientErrors = Partial<
  Record<`${ColorKey}.${ComponentKey}`, string>
>;

/** 解析单个字段：空串、NaN、±Infinity、非数字、越界均报错。 */
export function validateComponent(
  _color: ColorKey,
  comp: ComponentKey,
  raw: string,
): string | null {
  const { min, max, greek } = COMPONENT_BOUNDS[comp];
  const trimmed = raw.trim();
  if (trimmed === "") {
    return `${greek} 缺失，必须填写有限数值`;
  }
  // 明确拦截 NaN / Infinity（Number 会接受它们）
  if (/^[+-]?(infinity|inf|nan)$/i.test(trimmed)) {
    return `${greek} 必须是有限数值（拒绝 NaN 与 ±Infinity）`;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return `${greek} 必须是有限数值`;
  }
  if (value < min || value > max) {
    return `${greek} 越界：允许闭区间 [${min}, ${max}]，端点包含`;
  }
  return null;
}

/** 校验整张表单；任意字段非法即整次拒绝。 */
export function validateForm(form: LabForm): ClientErrors {
  const errors: ClientErrors = {};
  (Object.keys(form) as ColorKey[]).forEach((color) => {
    (["L", "a", "b"] as ComponentKey[]).forEach((comp) => {
      const msg = validateComponent(color, comp, form[color][comp]);
      if (msg) errors[`${color}.${comp}`] = msg;
    });
  });
  return errors;
}

/** 表单转数值请求体（仅在校验通过后调用）。 */
export function formToPayload(form: LabForm) {
  return {
    standard: {
      L: Number(form.standard.L),
      a: Number(form.standard.a),
      b: Number(form.standard.b),
    },
    sample: {
      L: Number(form.sample.L),
      a: Number(form.sample.a),
      b: Number(form.sample.b),
    },
  };
}
