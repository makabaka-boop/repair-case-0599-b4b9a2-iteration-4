# 专色墨首张样张 CIEDE2000 放行比对

包装印刷机更换专色油墨后，调色员必须在继续印刷前比对**标准色**与**首张样张**。
本项目用浏览器（React + TypeScript）录入两组 CIE L\*a\*b\*，由 FastAPI **逐项实现**
CIEDE2000 并返回可复算结果与字段错误，避免手算表因角度换算和中间舍入不同而给出相反结论。

## 判定规则（不可协商）

| 项 | 规则 |
| --- | --- |
| 输入范围 | L\* ∈ [0, 100]，a\*、b\* ∈ [-128, 127]，**端点均包含** |
| 非法输入 | 缺失、非有限（NaN / ±Infinity）、越界 → **整次拒绝**，前端清除旧结论 |
| 公式 | CIEDE2000，参数因子 kL = kC = kH = 1，逐步实现，不用库/查表/固定响应/占位 |
| 舍入 | **只在最终**把 ΔE00 与超出量四舍五入到两位小数（逢五进一） |
| 判定 | **未舍入** ΔE00 ≤ 2.00 → 放行；> 2.00 → 超差，并显示超出量 |

界面同时呈现：两位小数 **ΔE00**、未舍入值与阈值 2.00 的 **阈值关系（≤ / >）**、
明确的 **✅ 放行 / ⛔ 超差** 结论，以及（超差时的）**超出量**。

## 批次标签核验区（GS1）

收料时调色员可在页面下方的独立核验区粘贴扫码枪读出的油墨桶标签原文，
后端按 **GS1 应用标识符（AI）** 规则解析并生成统一批次信息：
**商品编码 GTIN（AI 01，校验 GS1 校验位）**、**批号（AI 10）**、
**失效日期（AI 17，YYMMDD，校验真实日历日期；按 GS1 规范 DD=00 表示当月最后一天）**。

支持两种输入格式：

```text
# 带括号的可读格式
(01)09506000134352(10)INK2407(17)280930

# 含 FNC1 分隔符的扫描格式（FNC1 传输为 GS 字符 0x1D；末尾变长字段可省略 FNC1）
010950600013435210INK2407␝17280930
```

定长 AI 按表消费固定字符数，变长 AI 消费到 FNC1 或字符串末尾。
数字字段仅接受半角数字 0–9：阿拉伯文数字（٠١٢…）、全角数字（０１２…）等
Unicode 数字字符会被**定位到该字符并拒绝**。

**逐字符身份与可编码字符集**：字段值必须可编码到标签（数字字段另限 0–9，
其余字段允许可打印 ASCII `0x20–0x7E`，含空格）。emoji、NUL、制表符、换行、
DEL 等字符集外内容一律**定位到该字符并稳定拒绝**（错误代码
`unsupported_character`），长度按**可编码字符**计数（每个字符即一个标签码位），
多字节 Unicode 无法少计长度而越界放行。空格是字段值的一部分：**尾随空格逐字符
保留**（`INK2407` 与 `INK2407 ` 是两个不同批号），页面以 `␠` 显式展示，不会被
HTML 折叠。对扫描器环境只容忍两件既有约定的事：**AIM 符号标识符前缀**
（如 `]d2`）与**单个末尾行尾序列**（CRLF / CR / LF）；尾随空格、尾随制表符
绝不删除。任何解析失败都**不产生批次信息**（HTTP 422，含机器可读 `code`、
`position`），且与色差作业完全互不影响。

核验区有 **待输入 / 已识别 / 已拒绝** 三种状态：识别失败时**保留原文**并高亮
**首个无法解析的位置**（控制字符以唯一可见字形显示：TAB `␉`、NUL `␀`、
LF `␊`、CR `␍`、FNC1 `␝`、DEL `␡`，杜绝不可见、折行或与普通值混淆）；
识别成功后可一键“扫描下一桶”。
该区域不读写标准色、样张与色差结论；标签解析不可用时也不阻断色差计算。

## 批次放行单（可选组合流程）

放行**一桶新油墨**时，调色员需要把“合格的首张样张”与“刚扫描的桶标签”
对应成**同一张交接凭据**，避免两项独立结果被误配。页面底部的“批次放行单”
区把标准色、样张 L\*a\*b\* 与标签原文放进**一次请求**提交
（`POST /api/batch-release`），后端**复用**既有 `/api/delta-e` 色差判定与
`/api/gs1-label` GS1 解析规则，在同一响应里返回：

- `inputs`：两项核验共同的原始输入快照（Lab 数值即提交数值，标签原文逐字符回显）；
- `color_check`：色差核验 `{passed, result}`（未舍入 ΔE00 ≤ 2.00 才 passed）；
- `label_check`：标签核验，成功为 `{passed:true, parsed}`，失败为
  `{passed:false, error:{code,message,position}}`；
- `release`：**只有色差放行且标签有效**才是放行单（编号、UTC 生成时间、
  两项快照、批次三字段、ΔE00 与可复制整文 `text`）；任何一项失败都是
  `null`，**不存在半张凭据**，`released=false`。

三类失败明确区分：**请求异常/422**（Lab 缺失、非有限、越界，标签原文为空等，
请求体被整次拒绝）、**色差超差**（200 内 `color_check.passed=false`）、
**标签解析失败**（200 内 `label_check.passed=false`，带机器可读 `code` 与
`position`）。

```bash
curl -s -X POST http://localhost:8001/api/batch-release \
  -H 'Content-Type: application/json' \
  -d '{"standard":{"L":60.2574,"a":-34.0099,"b":36.2677},
       "sample":{"L":60.4626,"a":-34.1751,"b":39.4387},
       "label_raw":"(01)09506000134352(10)INK2407(17)280930"}'
# → {"ok":true,"released":true,"inputs":{…},"color_check":{"passed":true,…},
#    "label_check":{"passed":true,…},
#    "release":{"id":"REL-20260930T100000Z-ab12cd34",
#               "label_raw":"(01)09506000134352(10)INK2407(17)280930", …}}
```

**凭据固定与防误配**：页面上的放行单一旦生成就固定于这次请求。之后再编辑
任一输入，只会在凭据上标记“当前表单与这张放行单不一致”，凭据编号与内嵌
快照**绝不被改写**；只有重新提交且双项通过，才生成新凭据替换。连续提交时
前端用单调递增的请求序号丢弃迟到响应——较早请求（无论成功还是失败）的迟到
响应都不会覆盖更新请求的放行单/失败状态。本流程是独立新入口：上方色差比对
与独立标签核验两个入口及其各自清理规则保持不变，三者互不读写。

```bash
# 标签校验位损坏：仍是 200（核验失败），released=false、release=null，
# 色差明细照常返回；与 422 请求体拒绝明确区分
curl -s -X POST http://localhost:8001/api/batch-release \
  -H 'Content-Type: application/json' \
  -d '{"standard":{"L":60.2574,"a":-34.0099,"b":36.2677},
       "sample":{"L":60.4626,"a":-34.1751,"b":39.4387},
       "label_raw":"(01)09506000134353(10)INK2407(17)280930"}'
```


```bash
curl -s -X POST http://localhost:8001/api/gs1-label \
  -H 'Content-Type: application/json' \
  -d '{"raw":"(01)09506000134352(10)INK2407(17)280930"}'
# → {"ok":true,"format":"readable","fields":[...],
#    "batch":{"gtin":"09506000134352","lot":"INK2407","expires":"2028-09-30"}}

# 校验位损坏（末位应为 2）：HTTP 422，position 指向首个无法解析的字符（0 起）
curl -s -X POST http://localhost:8001/api/gs1-label \
  -H 'Content-Type: application/json' \
  -d '{"raw":"(01)09506000134353(10)INK2407(17)280930"}'
# → {"ok":false,"message":"标签解析失败：商品编码校验位错误…","position":17,...}
```

## 目录结构

```
api/                 FastAPI 服务
  app/ciede2000.py   逐项实现的 CIEDE2000（仅用标准库 math）
  app/judge.py       最终舍入与 ≤ 2.00 判定
  app/gs1.py         GS1 应用标识符解析（定长/变长、校验位、日历日期）
  app/release.py     批次放行单组合裁决：同请求复用色差判定+GS1 解析，双项通过才出凭据
  app/main.py        端点 /api/delta-e、/api/gs1-label、/api/batch-release、/health 与逐字段错误（422）
  tests/             pytest（Sharma 2005 公开 34 对参考色对 + 3 个极端对 + GS1 标签解析 + 组合裁决/字段身份）
web/                 React + TypeScript（Vite）
  src/               录入、即时校验、结果面板、批次标签核验区、批次放行单流程
  e2e/               Playwright 真实联调（浏览器 → nginx → FastAPI）
verify/              一次性验收服务（pytest + Vitest + Playwright）
docker-compose.yml   web / api / verify 三个服务
```

## 快速开始（Docker Compose）

```bash
# 默认宿主端口：web 8080，api 8001
docker compose up -d --build
# 打开 http://localhost:8080

# 用环境变量覆盖宿主端口
WEB_PORT=9090 API_PORT=9001 docker compose up -d --build
```

- 浏览器访问 web（nginx 托管静态资源并把 `/api`、`/health` 反代到 api）。
- 直接调用 api：

```bash
curl -s http://localhost:8001/health
curl -s -X POST http://localhost:8001/api/delta-e \
  -H 'Content-Type: application/json' \
  -d '{"standard":{"L":50,"a":2.6772,"b":-79.7751},
       "sample":{"L":50,"a":0,"b":-82.7485}}'
# → ΔE00 未舍入 2.0424596…，显示 2.04，> 2.00，超差，超出量 0.04
```

非法请求整次拒绝并返回字段错误（HTTP 422）：

```bash
curl -i -X POST http://localhost:8001/api/delta-e \
  -H 'Content-Type: application/json' \
  -d '{"standard":{"L":50,"a":0},"sample":{"L":50,"a":0,"b":200}}'
```

## 一次性验收

```bash
# 启动 api、web 后，运行一次性验收服务（结束自动退出，不长期驻留）
docker compose run --rm verify
```

验收依次执行：

1. **pytest**：37 对公开 CIEDE2000 参考色对（Sharma, Wu, Dalal 2005 论文表 1 的全部 34 对，
   加同一公开测试文件附带的 3 个极端对），每对误差 **≤ 0.0001**；端点校验与判定测试；
   GS1 标签解析（两种格式、定长/变长规则、校验位、真实日历日期、错误定位，以及尾随空格
   逐字符保留、中部/末尾控制符与多字节字符的字符集拒绝、可编码长度计数、稳定错误代码）；
   批次放行单组合裁决（四种通过/失败组合、无半张凭据、422 与核验失败区分、字段身份快照、
   凭据唯一编号）。
2. **Vitest**：前端输入校验（缺失/非有限/越界/端点）与旧结论清除；
   标签核验区状态机（待输入/已识别/已拒绝）、错误定位、尾随空格可见化与控制字符字形；
   批次放行单（输入修改后只标记不一致不改写凭据、乱序迟到响应被丢弃、422/网络异常后的页面状态）。
3. **Playwright**：真实浏览器经 nginx 访问 FastAPI，覆盖放行、超差、端点值、
   422 字段错误、NaN 拒绝、旧结论清除与恢复；标签核验区一次有效扫描、
   一次损坏标签重试、尾随空格两种格式、中部/末尾 TAB/NUL/LF/emoji 拒绝与页面可见文本、
   序列号与 90–99 内部字段字符集、AIM+FNC1+行尾兼容，以及色差主流程在标签核验失败时
   仍可独立完成；批次放行单双项通过出凭据、超差/标签失败/请求异常三态区分、
   凭据固定与复制、输入修改后的不一致标记、连续提交乱序响应不覆盖新凭据、
   尾随空格快照，以及两个既有独立入口不受影响。

## 本地开发（不用 Docker）

```bash
# API（Python 3.11）
cd api
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
python -m pytest

# Web（Node 20）
cd web
npm install
npm test                     # Vitest
API_PORT=8001 npm run dev    # Vite 把 /api 代理到本机 8001
npx playwright install chromium
WEB_BASE_URL=http://localhost:5173 npx playwright test
```

## 参考数据出处

- Sharma, G., Wu, W., Dalal, E. N. (2005),
  “The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test
  Data, and Mathematical Observations”, *Color Research & Application*, 30(1), 21–30.
  论文公开的 34 对补充测试色对保存于 `api/tests/data/ciede2000_reference.csv`
  （含同一公开测试文件附带的相同色/黑/白 3 个极端对，共 37 行）。
