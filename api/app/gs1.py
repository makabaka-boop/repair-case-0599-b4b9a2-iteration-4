"""GS1 应用标识符（AI）批次标签解析：扫码原文 → 统一批次信息。

支持两种输入格式：

1. 带括号的可读格式（人工核对/录入）::

    (01)09506000134352(10)INK2407(17)280930

2. 扫码枪原始格式（FNC1 分隔，FNC1 传输为 GS 字符 0x1D）::

    010950600013435210INK2407\\x1d17280930

   定长 AI 按表消费固定字符数；变长 AI 消费到 FNC1 或字符串末尾。
   扫码枪常附加的单个行尾（CRLF / CR / LF）与 GS1 符号标识符前缀（如 ]d2）
   会被容忍；尾随空格、尾随制表符不属于扫描器噪声，绝不删除。

无论哪种格式，都按 AI 的定长/变长规则解析后生成统一批次信息：
商品编码 GTIN（AI 01，校验 GS1 校验位）、批号（AI 10）、
失效日期（AI 17，YYMMDD，校验真实日历日期；按 GS1 规范 DD=00 表示当月最后一天）。

字段值必须**逐字符可编码**到标签：仅允许 GS1 标签可承载的单字节 ASCII 字符
（数字字段另限 0–9）。emoji、NUL、制表符、换行等字符集外内容一律定位到该字符并
拒绝；长度按可编码字符（= 单字节字符）计数，多字节 Unicode 不会被少计而越界放行。

对扫描器环境只做既有约定的两处容忍：**AIM 符号标识符前缀**与**单个行尾序列
（\\r\\n / \\r / \\n）**。尾随空格、尾随制表符属于字段值/字段内容本身，绝不删除，
因此两个仅尾随空格不同的批号不会得到同一批次结果。

解析失败抛出 :class:`Gs1ParseError`，携带首个无法解析的字符位置（相对原始输入，
从 0 计）和机器可读错误代码，供前端在原文中高亮定位。
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date

# FNC1 在扫码枪输出中的传输字符（Group Separator）
GS = "\x1d"

# 扫码枪可能带出的 AIM 符号标识符前缀（GS1 体系）
_SYMBOLOGY_PREFIXES = ("]d2", "]C1", "]e0", "]Q3")

# 扫描器行尾：只容忍一个位于最末尾的行尾序列（CRLF / CR / LF），
# 它是键盘模拟扫描器的按键后缀，不是标签数据。绝不包含空格与制表符。
_SCANNER_EOL = re.compile(r"(?:\r\n|\r|\n)\Z")

# GS1 数字字段只允许 ASCII 数字 0–9。
# str.isdigit()/int() 会接受阿拉伯文数字（٠١٢…）、全角数字（０１２…）等
# Unicode 数字，必须显式限定字符集，否则这类标签会被错误识别。
_ASCII_DIGITS = frozenset("0123456789")

# 标签可编码字符集：可打印 ASCII（0x20–0x7E，含空格），即 Code 128
# 单码位可承载的内容。每个字符恰好占一个标签码位，因此长度按字符计数
# 与按可编码承载量计数一致；字符集外（控制字符、DEL、emoji 等多字节
# Unicode 内容）一律拒绝，而不是按 Unicode 字符数少计后放行。
_PRINTABLE_ASCII = frozenset(chr(c) for c in range(0x20, 0x7F))


# 机器可读错误代码（422 响应同步返回，供自动化验收逐项核对）
CODE_PARSE_ERROR = "parse_error"  # 结构/长度等解析错误
CODE_UNSUPPORTED_CHARACTER = "unsupported_character"  # 标签字符集外字符
CODE_INVALID_CHECKSUM = "invalid_checksum"  # GTIN 校验位错误
CODE_INVALID_DATE = "invalid_date"  # 失效日期不是真实日历日期
CODE_MISSING_FIELD = "missing_field"  # 缺少必需 AI
CODE_DUPLICATE_FIELD = "duplicate_field"  # 同一 AI 重复
CODE_EMPTY_LABEL = "empty_label"  # 标签内容为空


def _describe_character(ch: str) -> str:
    """给出字符的人类可读名称，避免控制字符在错误文本中不可见。"""
    names = {
        "\x00": "NUL",
        "\t": "制表符 TAB",
        "\n": "换行 LF",
        "\r": "回车 CR",
        GS: "FNC1(GS)",
        "\x7f": "DEL",
        " ": "空格",
    }
    if ch in names:
        return names[ch]
    code = ord(ch)
    if code < 0x20:
        return f"控制字符 U+{code:04X}"
    if code >= 0x7F:
        return f"U+{code:04X}（不在 GS1 标签可编码字符集内）"
    return f"{ch!r}"


class Gs1ParseError(ValueError):
    """标签解析失败；position 为首个无法解析的字符在原始输入中的下标（0 起）。"""

    def __init__(
        self, message: str, position: int, code: str = CODE_PARSE_ERROR
    ) -> None:
        super().__init__(message)
        self.message = message
        self.position = position
        self.code = code


@dataclass(frozen=True)
class AiSpec:
    """一个应用标识符的格式规则。fixed 为 None 表示变长。"""

    ai: str
    label: str
    fixed: int | None
    max_len: int
    numeric: bool = False


# 本系统识别的应用标识符表（定长/变长规则见 GS1 通用规范）
_AI_LIST = [
    AiSpec("00", "SSCC 物流单元标识", 18, 18, numeric=True),
    AiSpec("01", "商品编码 GTIN", 14, 14, numeric=True),
    AiSpec("02", "内装物 GTIN", 14, 14, numeric=True),
    AiSpec("10", "批号", None, 20),
    AiSpec("11", "生产日期", 6, 6, numeric=True),
    AiSpec("12", "付款截止日", 6, 6, numeric=True),
    AiSpec("13", "包装日期", 6, 6, numeric=True),
    AiSpec("15", "最佳食用期", 6, 6, numeric=True),
    AiSpec("16", "销售截止日", 6, 6, numeric=True),
    AiSpec("17", "失效日期", 6, 6, numeric=True),
    AiSpec("20", "产品变体", 2, 2, numeric=True),
    AiSpec("21", "序列号", None, 20),
    AiSpec("30", "数量", None, 8, numeric=True),
    AiSpec("37", "内装数量", None, 8, numeric=True),
    AiSpec("90", "双方约定的内部信息", None, 30),
    AiSpec("240", "附加产品标识", None, 30),
    AiSpec("241", "客户零件号", None, 30),
    AiSpec("242", "定制产品变体号", None, 6, numeric=True),
    AiSpec("250", "二级序列号", None, 30),
    AiSpec("251", "源实体参考", None, 30),
    AiSpec("400", "客户订单号", None, 30),
    AiSpec("401", "货物托运代码", None, 30),
    AiSpec("403", "路由代码", None, 30),
    AiSpec("410", "交货地 GLN", 13, 13, numeric=True),
    AiSpec("411", "开票方 GLN", 13, 13, numeric=True),
    AiSpec("412", "供货方 GLN", 13, 13, numeric=True),
    AiSpec("413", "收货方 GLN", 13, 13, numeric=True),
    AiSpec("414", "物理位置 GLN", 13, 13, numeric=True),
    AiSpec("415", "开票方 GLN（单一）", 13, 13, numeric=True),
    AiSpec("416", "生产地 GLN", 13, 13, numeric=True),
    AiSpec("417", "当事方 GLN", 13, 13, numeric=True),
    AiSpec("420", "收货方邮政编码", None, 20),
    # 91–99：企业内部信息，变长
    *[AiSpec(f"9{i}", "企业内部信息", None, 90) for i in range(1, 10)],
]

AI_SPECS: dict[str, AiSpec] = {spec.ai: spec for spec in _AI_LIST}

# 生成统一批次信息所必需的 AI
_REQUIRED = ("01", "10", "17")


@dataclass(frozen=True)
class ParsedField:
    ai: str
    label: str
    value: str
    position: int  # 值在原始输入中的起始下标（0 起）


def _validate_value(spec: AiSpec, value: str, pos: int) -> None:
    """按字符集与定长/变长规则校验一个字段值，pos 为值起始下标。

    先逐字符校验可编码性（数字字段另限 ASCII 0–9，其余字段允许可打印 ASCII），
    再校验长度：字符集检查通过的每个字符恰好占一个标签码位，``len(value)``
    就是真实可承载长度，多字节 Unicode 无法少计长度蒙混过关。
    """
    for k, ch in enumerate(value):
        if spec.numeric:
            if ch not in _ASCII_DIGITS:
                raise Gs1ParseError(
                    f"AI ({spec.ai}) {spec.label}应为纯数字（仅限 0-9），"
                    f"此处出现 {_describe_character(ch)}",
                    pos + k,
                    CODE_UNSUPPORTED_CHARACTER,
                )
        elif ch not in _PRINTABLE_ASCII:
            raise Gs1ParseError(
                f"AI ({spec.ai}) {spec.label}出现标签无法编码的字符："
                f"{_describe_character(ch)}（允许可打印 ASCII 0x20–0x7E，含空格）",
                pos + k,
                CODE_UNSUPPORTED_CHARACTER,
            )

    if spec.fixed is not None:
        if len(value) != spec.fixed:
            raise Gs1ParseError(
                f"AI ({spec.ai}) {spec.label}为定长 {spec.fixed} 位，实际 {len(value)} 位",
                pos,
            )
    else:
        if len(value) == 0:
            raise Gs1ParseError(
                f"AI ({spec.ai}) {spec.label}为变长字段，内容为空",
                pos,
            )
        if len(value) > spec.max_len:
            raise Gs1ParseError(
                f"AI ({spec.ai}) {spec.label}最长 {spec.max_len} 位（按可编码字符计），"
                f"实际 {len(value)} 位",
                pos + spec.max_len,
            )


def _parse_readable(text: str, base: int) -> list[ParsedField]:
    """解析带括号的可读格式：(01)...(10)...(17)..."""
    fields: list[ParsedField] = []
    i, n = 0, len(text)
    while i < n:
        if text[i] != "(":
            raise Gs1ParseError("可读格式中此处应为 '(' 开始新的应用标识符", base + i)
        close = text.find(")", i + 1)
        if close == -1:
            raise Gs1ParseError("缺少与 '(' 配对的 ')'", base + i)
        ai = text[i + 1 : close]
        spec = AI_SPECS.get(ai)
        if not ai.isdigit() or spec is None:
            raise Gs1ParseError(f"未知应用标识符 ({ai})", base + i + 1)
        nxt = text.find("(", close + 1)
        value = text[close + 1 :] if nxt == -1 else text[close + 1 : nxt]
        pos = close + 1
        _validate_value(spec, value, base + pos)
        fields.append(ParsedField(ai, spec.label, value, base + pos))
        i = n if nxt == -1 else nxt
    return fields


def _match_ai(text: str, i: int) -> AiSpec | None:
    """在 i 处按已知 AI 表做最长前缀匹配（AI 为 2–4 位数字）。"""
    for length in (4, 3, 2):
        spec = AI_SPECS.get(text[i : i + length])
        if spec is not None:
            return spec
    return None


def _parse_scan(text: str, base: int) -> list[ParsedField]:
    """解析扫码枪原始格式：定长 AI 按表消费，变长 AI 以 FNC1(GS) 或末尾结束。"""
    fields: list[ParsedField] = []
    i, n = 0, len(text)
    while i < n:
        if text[i] == GS:
            raise Gs1ParseError("此处不应出现 FNC1 分隔符（字段之间多余的 GS）", base + i)
        spec = _match_ai(text, i)
        if spec is None:
            raise Gs1ParseError(
                f"无法识别的应用标识符（此处字符 {text[i:i+4]!r}）", base + i
            )
        i += len(spec.ai)
        if spec.fixed is not None:
            value = text[i : i + spec.fixed]
            if GS in value:
                raise Gs1ParseError(
                    f"AI ({spec.ai}) {spec.label}为定长 {spec.fixed} 位，"
                    "字段内出现 FNC1 分隔符，数据不足",
                    base + i + value.index(GS),
                )
            if len(value) < spec.fixed:
                raise Gs1ParseError(
                    f"AI ({spec.ai}) {spec.label}需要定长 {spec.fixed} 位，"
                    f"数据不足（仅 {len(value)} 位）",
                    base + i,
                )
            pos = i
            i += spec.fixed
        else:
            end = text.find(GS, i)
            if end == -1:
                value, pos, i = text[i:], i, n
            else:
                value, pos, i = text[i:end], i, end + 1
        _validate_value(spec, value, base + pos)
        fields.append(ParsedField(spec.ai, spec.label, value, base + pos))
    return fields


def _check_gtin(value: str, pos: int) -> None:
    """校验 GTIN 的 GS1 校验位（模 10，权重自右向左 3、1 交替）。"""
    digits = [int(c) for c in value]
    n = len(digits)
    total = sum(
        d * (3 if (n - 1 - i) % 2 == 1 else 1) for i, d in enumerate(digits[:-1])
    )
    expected = (10 - total % 10) % 10
    if expected != digits[-1]:
        raise Gs1ParseError(
            f"商品编码校验位错误：按前 {n - 1} 位计算应为 {expected}，实际为 {digits[-1]}",
            pos + n - 1,
            CODE_INVALID_CHECKSUM,
        )


def _resolve_year(yy: int, today: date | None = None) -> int:
    """两位年份按 GS1 滑动窗口还原：落在 [今年-49, 今年+50] 区间内。"""
    today = today or date.today()
    year = today.year // 100 * 100 + yy
    if year > today.year + 50:
        year -= 100
    elif year < today.year - 49:
        year += 100
    return year


def _parse_expiry(value: str, pos: int) -> str:
    """AI (17) YYMMDD → ISO 日期；校验真实日历日期，DD=00 表示当月最后一天。"""
    yy, mm, dd = int(value[0:2]), int(value[2:4]), int(value[4:6])
    year = _resolve_year(yy)
    if not 1 <= mm <= 12:
        raise Gs1ParseError(
            f"失效日期月份 {mm:02d} 不存在（允许 01–12）",
            pos + 2,
            CODE_INVALID_DATE,
        )
    last_day = calendar.monthrange(year, mm)[1]
    if dd == 0:
        day = last_day  # GS1 规范：日字段 00 表示当月最后一天
    elif dd > last_day:
        raise Gs1ParseError(
            f"失效日期 {year}-{mm:02d}-{dd:02d} 不是真实日历日期"
            f"（该月只有 {last_day} 天）",
            pos + 4,
            CODE_INVALID_DATE,
        )
    else:
        day = dd
    return date(year, mm, day).isoformat()


def _build_batch(fields: list[ParsedField], end_pos: int) -> dict[str, str]:
    """从已解析字段生成统一批次信息；缺失/重复/校验失败均拒绝。"""
    by_ai: dict[str, ParsedField] = {}
    for field in fields:
        if field.ai in by_ai:
            raise Gs1ParseError(
                f"应用标识符 ({field.ai}) {field.label}重复出现",
                field.position,
                CODE_DUPLICATE_FIELD,
            )
        by_ai[field.ai] = field

    for ai in _REQUIRED:
        if ai not in by_ai:
            label = AI_SPECS[ai].label
            raise Gs1ParseError(
                f"标签缺少批次核验必需的 AI ({ai}) {label}",
                end_pos,
                CODE_MISSING_FIELD,
            )

    gtin = by_ai["01"]
    _check_gtin(gtin.value, gtin.position)
    expires = _parse_expiry(by_ai["17"].value, by_ai["17"].position)

    return {
        "gtin": gtin.value,
        "lot": by_ai["10"].value,
        "expires": expires,
    }


def parse_gs1_label(raw: str) -> dict[str, object]:
    """解析标签原文，返回统一批次信息；失败抛 Gs1ParseError（含位置）。

    返回::

        {
            "format": "readable" | "scan",
            "fields": [{"ai", "label", "value", "position"}, ...],
            "batch": {"gtin", "lot", "expires"},
        }
    """
    text = raw
    base = 0
    for prefix in _SYMBOLOGY_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix) :]
            base += len(prefix)
            break
    # 只容忍一个扫描器行尾序列（CRLF/CR/LF）；尾随空格、制表符等一律保留，
    # 它们是字段值的一部分，删除会让不同批号（如 "INK2407" 与 "INK2407 "）
    # 得到同一批次结果。位置下标仍与原文对齐。
    text = _SCANNER_EOL.sub("", text, count=1)

    # 纯空白（仅空格/制表符，或空串）没有可解析内容，按空标签拒绝。
    if not text or not text.strip():
        raise Gs1ParseError("标签内容为空", base, CODE_EMPTY_LABEL)

    if text.startswith("("):
        fmt = "readable"
        fields = _parse_readable(text, base)
    else:
        fmt = "scan"
        fields = _parse_scan(text, base)

    batch = _build_batch(fields, base + len(text))
    return {
        "format": fmt,
        "fields": [
            {"ai": f.ai, "label": f.label, "value": f.value, "position": f.position}
            for f in fields
        ],
        "batch": batch,
    }
