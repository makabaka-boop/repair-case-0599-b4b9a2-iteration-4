#!/usr/bin/env bash
# verify 容器入口：
#   web 源码在 compose 中以只读方式挂载到 /workspace/web，无法在其中写 node_modules。
#   每次运行把源码复制到可写目录 /tmp/web-run，再把镜像构建期装好的 node_modules
#   从 /opt/web-pkg 复制过去，随后执行验收脚本。
set -euo pipefail

RUN=/tmp/web-run
rm -rf "$RUN"
mkdir -p "$RUN"
cp -a /workspace/web/. "$RUN/"
rm -rf "$RUN/node_modules"
cp -a /opt/web-pkg/node_modules "$RUN/node_modules"

export WEB_RUN_DIR="$RUN"
exec "$@"
