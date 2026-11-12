#!/usr/bin/env bash
# 在 loong64 上安装 ZCode workspace 依赖。
# 默认两阶段：先 --ignore-scripts 验证依赖树可解析，再按需执行允许的安装脚本。
#   ./02-install.sh                 # 完整（尝试 install scripts）
#   ./02-install.sh --no-scripts   # 只解析依赖，不跑任何 install 脚本
set -euo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/_layout.sh"
ZCODE_ROOT="$(resolve_zcode_root)"
OPT="$PORT_ROOT/opt"
NODE_VER="24.14.0"
ELECTRON_VER="43.7.7"

export PATH="$OPT/node-v${NODE_VER}-linux-loong64/bin:$OPT/pnpm-home/bin:$PATH"
export npm_config_registry="https://registry.npmmirror.com"
export ELECTRON_MIRROR="https://github.com/darkyzhou/electron-loong64/releases/download/"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export ELECTRON_OVERRIDE_DIST_PATH="$OPT/electron-v${ELECTRON_VER}-linux-loong64"
export electron_use_remote_checksums=1
export ZCODE_TARGET_OS=linux
export ZCODE_TARGET_ARCH=loong64

cd "$ZCODE_ROOT"
mkdir -p "$PORT_ROOT/report"
echo "[install] cwd=$PWD"
echo "[install] node=$(node -v) pnpm=$(pnpm -v) arch=$(node -p process.arch)"
echo "[install] registry=$npm_config_registry"
echo "[install] electron dist=$ELECTRON_OVERRIDE_DIST_PATH"
echo "[install] start=$(date -Is)"

ARGS=(install --no-frozen-lockfile)
if [[ "${1:-}" == "--no-scripts" ]]; then ARGS+=(--ignore-scripts); fi

set +e
pnpm "${ARGS[@]}" 2>&1 | tee "$PORT_ROOT/report/pnpm-install.log"
RC=${PIPESTATUS[0]}
set -e
echo "[install] exit=$RC end=$(date -Is)"
echo "[install] 日志: report/pnpm-install.log"

if [[ $RC -ne 0 ]]; then
  echo "[install] 失败，常见原因与处理见 report/PORTING-REPORT.md「阻塞项」"
fi
exit $RC
