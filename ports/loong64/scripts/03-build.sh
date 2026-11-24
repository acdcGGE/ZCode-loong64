#!/usr/bin/env bash
# 构建 ZCode 龙芯桌面版。按阶段执行，便于定位首个失败点。
#   ./03-build.sh bootstrap   # 等价于 pnpm bootstrap（依赖 + 本地运行资源 + 全量 build）
#   ./03-build.sh build       # pnpm build:bootstrap
#   ./03-build.sh bundle      # electron-builder 打 linux/loong64 包
#   ./03-build.sh all         # 依次执行以上三步
set -euo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/_layout.sh"
ZCODE_ROOT="$(resolve_zcode_root)"
OPT="$PORT_ROOT/opt"
NODE_VER="24.14.0"
ELECTRON_VER="43.7.7"
STAGE="${1:-all}"

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

run_stage() {
  local name="$1"; shift
  echo "[build] === $name === $(date -Is)"
  set +e
  "$@" 2>&1 | tee "$PORT_ROOT/report/build-${name}.log"
  local rc=${PIPESTATUS[0]}
  set -e
  echo "[build] $name exit=$rc"
  return $rc
}

# beforePack 需要 @lydell/node-pty-linux-loong64 的 prebuild，上游没有该包；
# 打包前先本地编译（脚本幂等，已有产物会直接复用并复验）。
prepare_node_pty() {
  echo "[build] === prepare-node-pty === $(date -Is)"
  "$PORT_ROOT/scripts/06-build-loong64-node-pty.sh" || return $?
}

case "$STAGE" in
  bootstrap) run_stage bootstrap pnpm bootstrap ;;
  build)     run_stage build pnpm run build:bootstrap ;;
  bundle)    prepare_node_pty && run_stage bundle pnpm run bundle:desktop -- --os linux --arch loong64 ;;
  all)
    run_stage bootstrap pnpm bootstrap || exit $?
    run_stage build pnpm run build:bootstrap || exit $?
    prepare_node_pty || exit $?
    run_stage bundle pnpm run bundle:desktop -- --os linux --arch loong64 || exit $?
    ;;
  *) echo "用法: $0 {bootstrap|build|bundle|all}"; exit 2 ;;
esac
