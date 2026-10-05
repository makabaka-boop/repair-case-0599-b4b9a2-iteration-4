#!/usr/bin/env bash
# 一次性验收：
#   1) pytest：37 对公开参考色对（含 Sharma 2005 全部 34 对），误差 <= 0.0001；
#      色差端点校验；GS1 批次标签解析（两种格式、定长/变长、校验位、日历日期、
#      尾随空格逐字符身份、中部/末尾控制符与多字节字符字符集拒绝、可编码长度、错误码）；
#      批次放行单组合裁决（四种通过/失败组合、无半张凭据、422/核验失败区分、字段身份）
#   2) Vitest：前端输入校验与旧结论清除；标签核验状态机、错误定位、
#      尾随空格可见化与控制字符字形（组件级，fetch 打桩）；
#      批次放行单凭据固定（输入修改只标记不一致）与乱序响应丢弃
#   3) Playwright：浏览器 → nginx → FastAPI 真实联调 E2E（色差主流程 + 标签核验区 +
#      批次放行单三态失败/凭据固定/乱序/复制，含尾随空格两种格式、
#      TAB/NUL/LF/emoji 拒绝的状态/批次值/错误码/页面可见文本）
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://api:8000}"
WEB_BASE_URL="${WEB_BASE_URL:-http://web:80}"
WEB_RUN_DIR="${WEB_RUN_DIR:-/tmp/web-run}"

echo "──────────────────── 1/3  pytest（CIEDE2000 参考色对 + 端点 + GS1 标签解析） ────────────────────"
(
  cd /workspace/api
  # api 目录只读挂载：禁用 pytest 缓存写入；镜像内只有 python3
  python3 -m pytest -p no:cacheprovider
)

echo "──────────────────── 2/3  Vitest（输入校验、旧结论清除、标签核验状态机） ────────────────────"
(
  cd "$WEB_RUN_DIR"
  npm test -- --run
)

echo "──────────────────── 3/3  Playwright（web ↔ api 真实联调） ────────────────────"
# compose healthcheck 已保证服务就绪，这里再做一次显式检查
python3 - <<'PY'
import os, sys, time, urllib.request
api = os.environ["API_BASE_URL"]
web = os.environ["WEB_BASE_URL"]
for name, url in (("api", api + "/health"), ("web", web + "/")):
    for _ in range(30):
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    print(f"{name} ready: {url}")
                    break
        except OSError:
            time.sleep(1)
    else:
        print(f"{name} NOT ready: {url}", file=sys.stderr)
        sys.exit(1)
PY

(
  cd "$WEB_RUN_DIR"
  WEB_BASE_URL="$WEB_BASE_URL" npx playwright test --config=playwright.config.ts
)

echo ""
echo "✅ 验收全部通过：参考色对、GS1 标签解析、Vitest、真实联调 E2E。"
