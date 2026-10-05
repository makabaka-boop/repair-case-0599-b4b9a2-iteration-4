/** 与后端一致的字段约束：L* 闭区间 [0,100]，a 与 b 轴闭区间 [-128,127]。 */
export const COMPONENT_BOUNDS = {
  L: { min: 0, max: 100, label: "L*", greek: "L*" },
  a: { min: -128, max: 127, label: "a*", greek: "a*" },
  b: { min: -128, max: 127, label: "b*", greek: "b*" },
} as const;

export type ComponentKey = keyof typeof COMPONENT_BOUNDS;
export type ColorKey = "standard" | "sample";

export interface LabInput {
  L: string;
  a: string;
  b: string;
}

export type LabForm = Record<ColorKey, LabInput>;

export interface FieldError {
  field: string;
  message: string;
}

export interface DeltaEResult {
  delta_e00: number;
  delta_e00_round: number;
  threshold: number;
  passed: boolean;
  excess_raw: number;
  excess_round: number;
  relation: "<=" | ">";
}

export interface DeltaESuccessResponse {
  ok: true;
  standard: { L: number; a: number; b: number };
  sample: { L: number; a: number; b: number };
  result: DeltaEResult;
}

export interface DeltaEErrorResponse {
  ok: false;
  message: string;
  errors: FieldError[];
}

/* ── GS1 批次标签核验 ─────────────────────────────────────────────── */

/** 统一批次信息：商品编码、批号、失效日期（ISO 日历日期）。 */
export interface Gs1BatchInfo {
  gtin: string;
  lot: string;
  expires: string;
}

export interface Gs1ParsedField {
  ai: string;
  label: string;
  value: string;
  position: number;
}

export type Gs1LabelFormat = "readable" | "scan";

export interface Gs1LabelSuccessResponse {
  ok: true;
  format: Gs1LabelFormat;
  fields: Gs1ParsedField[];
  batch: Gs1BatchInfo;
}

export interface Gs1LabelErrorResponse {
  ok: false;
  message: string;
  errors: FieldError[];
  /** 机器可读错误代码：parse_error / unsupported_character / invalid_checksum / invalid_date / missing_field / duplicate_field / empty_label */
  code?: string;
  /** 首个无法解析的字符在原文中的下标（0 起）；无法定位时为 null */
  position: number | null;
}

/* ── 批次放行单（可选组合流程） ─────────────────────────────────────── */

/** 组合流程中标签核验失败明细：与 /api/gs1-label 422 体同源，但内嵌在 200 响应里。 */
export interface BatchLabelError {
  code: string;
  message: string;
  position: number | null;
}

export interface ColorCheck {
  passed: boolean;
  result: DeltaEResult;
}

export interface LabelCheckSuccess {
  passed: true;
  parsed: Gs1LabelSuccessResponse;
}

export interface LabelCheckFailure {
  passed: false;
  error: BatchLabelError;
}

export type LabelCheck = LabelCheckSuccess | LabelCheckFailure;

/** 固定于生成请求的放行单：结构化字段 + 可复制整文 + 原始输入快照。 */
export interface ReleaseDocument {
  id: string;
  generated_at: string;
  standard: { L: number; a: number; b: number };
  sample: { L: number; a: number; b: number };
  result: DeltaEResult;
  batch: Gs1BatchInfo;
  label_raw: string;
  text: string;
}

/** 一次组合请求的原始输入快照（数值即提交数值，标签原文逐字符回显）。 */
export interface BatchReleaseInputs {
  standard: { L: number; a: number; b: number };
  sample: { L: number; a: number; b: number };
  label_raw: string;
}

export interface BatchReleaseSuccessResponse {
  ok: true;
  released: boolean;
  inputs: BatchReleaseInputs;
  color_check: ColorCheck;
  label_check: LabelCheck;
  /** 只有色差放行且标签有效时非空；任何核验失败都为 null（不存在半张凭据） */
  release: ReleaseDocument | null;
}

export interface BatchReleaseRequestError {
  ok: false;
  message: string;
  errors: FieldError[];
}

/* ── 放行单复核（交接班独立入口） ─────────────────────────────────────── */

/** 复核的五个检查项：元数据/色差复算/标签重解析/组合放行规则/正文重建。 */
export type ReviewCheckName =
  | "meta"
  | "color"
  | "label"
  | "release_rule"
  | "text";

/** 一条定位到字段的不一致明细；内嵌值与复算值并排给出。 */
export interface ReviewMismatch {
  check: ReviewCheckName;
  field: string;
  embedded: unknown;
  recomputed: unknown;
  message: string;
  /** 仅正文不一致时存在：首个差异的行/列（均从 1 起，按码点计）。 */
  position?: {
    line: number | null;
    column: number | null;
    kind: string;
    embedded: string | null;
    recomputed: string | null;
  };
}

/** 鉴真结论：本系统不放签名，任何复制件都恒定为“未鉴真”。 */
export interface ReviewAuthentication {
  authenticated: false;
  signed: false;
  message: string;
}

export interface ReleaseReviewResponse {
  ok: true;
  /** 内容自洽：内嵌原值复算与单据自身声称逐项一致（≠ 来源真实）。 */
  content_self_consistent: boolean;
  /** 签发来源真实：无服务端签名，恒为 false。 */
  source_authentic: false;
  authentication: ReviewAuthentication;
  checks: {
    passed: ReviewCheckName[];
    failed: ReviewCheckName[];
    mismatches: ReviewMismatch[];
  };
  recomputed: {
    color: DeltaEResult;
    batch: Gs1BatchInfo | null;
    text: string | null;
  };
  /** 本次导入快照的逐字段回显：复核结论固定于此，之后编辑不改变它。 */
  imported: {
    id: string;
    generated_at: string;
    standard: { L: number; a: number; b: number };
    sample: { L: number; a: number; b: number };
    label_raw: string;
    batch: Gs1BatchInfo;
    text: string;
  };
}

export interface ReleaseReviewRequestError {
  ok: false;
  message: string;
  errors: FieldError[];
}

export const THRESHOLD = 2.0;
export const EMPTY_FORM: LabForm = {
  standard: { L: "", a: "", b: "" },
  sample: { L: "", a: "", b: "" },
};
