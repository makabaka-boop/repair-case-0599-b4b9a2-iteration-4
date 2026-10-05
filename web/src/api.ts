import type {
  BatchReleaseRequestError,
  BatchReleaseSuccessResponse,
  DeltaEErrorResponse,
  DeltaESuccessResponse,
  Gs1LabelErrorResponse,
  Gs1LabelSuccessResponse,
  ReleaseReviewRequestError,
  ReleaseReviewSuccessResponse,
} from "./types";

export type ApiOutcome =
  | { ok: true; data: DeltaESuccessResponse }
  | { ok: false; status: number; error: DeltaEErrorResponse | null };

/** 调用 /api/delta-e；网络层错误同样按“整次拒绝”处理。 */
export async function postDeltaE(payload: unknown): Promise<ApiOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/delta-e", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        ok: false,
        message: "无法连接计算服务，请确认 API 已启动",
        errors: [{ field: "network", message: "网络请求失败" }],
      },
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok && body && typeof body === "object" && (body as DeltaESuccessResponse).ok === true) {
    return { ok: true, data: body as DeltaESuccessResponse };
  }
  return {
    ok: false,
    status: res.status,
    error: body as DeltaEErrorResponse | null,
  };
}

export type Gs1LabelOutcome =
  | { ok: true; data: Gs1LabelSuccessResponse }
  | { ok: false; status: number; error: Gs1LabelErrorResponse | null };

/** 调用 /api/gs1-label；网络层错误同样按“识别失败”处理，不影响色差比对。 */
export async function postGs1Label(raw: string): Promise<Gs1LabelOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/gs1-label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        ok: false,
        message: "无法连接标签解析服务，请确认 API 已启动（色差比对不受影响）",
        errors: [{ field: "network", message: "网络请求失败" }],
        position: null,
      },
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok && body && typeof body === "object" && (body as Gs1LabelSuccessResponse).ok === true) {
    return { ok: true, data: body as Gs1LabelSuccessResponse };
  }
  return {
    ok: false,
    status: res.status,
    error: body as Gs1LabelErrorResponse | null,
  };
}

export type BatchReleaseOutcome =
  | { ok: true; data: BatchReleaseSuccessResponse }
  | { ok: false; status: number; error: BatchReleaseRequestError | null };

/**
 * 调用 /api/batch-release（可选组合流程）：一次请求返回色差与标签两项核验。
 *
 * 三种失败在此明确区分：
 * - 200 + released=false：核验失败（超差/标签无效），两项明细在 data 内；
 * - 422：请求体被整次拒绝（字段缺失/非有限/越界/标签空串），error 内有字段明细；
 * - status=0：网络层异常（无法连接服务）。
 */
export async function postBatchRelease(payload: {
  standard: { L: number; a: number; b: number };
  sample: { L: number; a: number; b: number };
  label_raw: string;
}): Promise<BatchReleaseOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/batch-release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        ok: false,
        message: "无法连接放行服务，请确认 API 已启动",
        errors: [{ field: "network", message: "网络请求失败" }],
      },
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (
    res.ok &&
    body &&
    typeof body === "object" &&
    (body as BatchReleaseSuccessResponse).ok === true
  ) {
    return { ok: true, data: body as BatchReleaseSuccessResponse };
  }
  return {
    ok: false,
    status: res.status,
    error: body as BatchReleaseRequestError | null,
  };
}

export type ReleaseReviewOutcome =
  | { ok: true; data: ReleaseReviewSuccessResponse }
  | { ok: false; status: number; error: ReleaseReviewRequestError | null };

/**
 * 调用 /api/release-review：导入一张已存在的结构化放行单并复核内容自洽性。
 * 该入口只读取入的 JSON 快照，不签发、不鉴真、不影响新批次放行表单。
 */
export async function postReleaseReview(
  document: unknown,
): Promise<ReleaseReviewOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/release-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(document),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        ok: false,
        message: "无法连接放行单复核服务，请确认 API 已启动",
        errors: [{ field: "network", message: "网络请求失败" }],
      },
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (
    res.ok &&
    body &&
    typeof body === "object" &&
    (body as ReleaseReviewSuccessResponse).ok === true
  ) {
    return { ok: true, data: body as ReleaseReviewSuccessResponse };
  }
  return {
    ok: false,
    status: res.status,
    error: body as ReleaseReviewRequestError | null,
  };
}
