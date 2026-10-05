/**
 * 标签原文/字段值的逐字符可视化：批次标签核验区与批次放行单流程共用。
 *
 * 控制字符用 Unicode 控制图形（每字符恰好一个码点，保持与原文 1:1 的下标
 * 映射）；空格显式显示为 ␠ 并配合 white-space: pre-wrap，避免尾随空格被
 * HTML 折叠而让两个不同批号显示相同。
 */

/**
 * 把一个码点可视化为稳定可见的字形。
 * 成功响应里字段值只可能含可打印 ASCII；这里同时服务于被拒绝原文的错误高亮，
 * 因此 NUL / TAB / LF / CR / GS / DEL 等都必须有唯一可见字形。
 */
export function visibleCodePoint(ch: string): string {
  switch (ch) {
    case "\x00":
      return "␀";
    case "\t":
      return "␉";
    case "\n":
      return "␊";
    case "\r":
      return "␍";
    case "\x1d":
      return "␝";
    case "\x7f":
      return "␡";
    default: {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) {
        // 其余 C0 控制字符统一显示为 U+2400 起始的控制图形
        return String.fromCodePoint(0x2400 + code);
      }
      return ch;
    }
  }
}

/** 按码点（而非 UTF-16 代码单元）拆分，emoji 等星平面字符也只占一个位置，
 *  保证后端给出的 position（Python 码点下标）与前端切片完全对齐。 */
export function toCodePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * 识别成功后的字段值展示：后端逐字符保留合法值（含尾随空格）。
 * 空格（含尾随空格）显式显示为 ␠，配合 white-space: pre-wrap 避免 HTML
 * 折叠空格，让收料员能确认数据库值与标签逐字符一致。
 */
export function VisibleValue({ text, testId }: { text: string; testId: string }) {
  const shown = text.replace(/ /g, "␠");
  return (
    <dd data-testid={testId} className="verbatim-value">
      {shown}
    </dd>
  );
}

/** 在原文中高亮首个无法解析的位置；位置越出末尾时给出末尾标记。 */
export function HighlightedRaw({
  raw,
  position,
  testId = "label-raw-highlight",
  charTestId = "label-error-char",
}: {
  raw: string;
  position: number;
  testId?: string;
  charTestId?: string;
}) {
  const points = toCodePoints(raw);
  const shown = points.map(visibleCodePoint);
  if (position >= shown.length) {
    return (
      <pre className="raw-highlight" data-testid={testId}>
        {shown.join("")}
        <mark data-testid={charTestId}>⇤末尾</mark>
      </pre>
    );
  }
  return (
    <pre className="raw-highlight" data-testid={testId}>
      {shown.slice(0, position).join("")}
      <mark data-testid={charTestId}>{shown[position]}</mark>
      {shown.slice(position + 1).join("")}
    </pre>
  );
}

/** 批次三字段（GTIN/批号/失效日期）的只读展示，尾随空格可见。 */
export function BatchFieldsView({
  batch,
  testIdPrefix,
}: {
  batch: { gtin: string; lot: string; expires: string };
  testIdPrefix: string;
}) {
  return (
    <dl>
      <div>
        <dt>商品编码 (GTIN)</dt>
        <VisibleValue text={batch.gtin} testId={`${testIdPrefix}-gtin`} />
      </div>
      <div>
        <dt>批号</dt>
        <VisibleValue text={batch.lot} testId={`${testIdPrefix}-lot`} />
      </div>
      <div>
        <dt>失效日期</dt>
        <VisibleValue text={batch.expires} testId={`${testIdPrefix}-expires`} />
      </div>
    </dl>
  );
}
