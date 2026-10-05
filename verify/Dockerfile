# 验收镜像：Python（pytest + httpx）+ Node（Vitest）+ Playwright Chromium。
#
# Playwright 官方 noble 镜像只含 Node 与浏览器（Chromium/Firefox/WebKit），
# 不含 Python/pip，因此这里先装 python3 并引导 pip；前端依赖构建期装好到
# /opt/web-pkg，运行时 entrypoint 复制到可写目录执行 Vitest 与 Playwright。
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /workspace

# Python 运行时（ubuntu noble main 源即有）。基础镜像默认是 root。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 引导 pip（noble 的 python3-pip 在 universe，为避免多架构源差异改用官方引导脚本），
# 再安装后端测试依赖；--break-system-packages 绕过 noble 的 PEP 668 外部环境保护。
COPY api/requirements.txt /tmp/api-requirements.txt
RUN curl -sSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py \
    && python3 /tmp/get-pip.py --break-system-packages \
    && python3 -m pip install --break-system-packages -r /tmp/api-requirements.txt \
    && rm -f /tmp/get-pip.py \
    && python3 -m pytest --version

# Node 侧依赖（仓库提交了 package-lock.json，用 npm ci 保证可复现）
RUN mkdir -p /opt/web-pkg
COPY web/package.json web/package-lock.json /opt/web-pkg/
RUN cd /opt/web-pkg && npm ci
