#!/usr/bin/env bash
# 一键复现 ZCode linux-loong64 移植 —— README「复现步骤」的可执行版本。
#
# 用法:
#   ./reproduce.sh                   # 全流程
#   ./reproduce.sh --dry-run         # 只打印阶段，不执行
#   ./reproduce.sh --from=bundle     # 从指定阶段续跑（前面的阶段已完成时）
#   ./reproduce.sh --skip-smoke      # 跑完打包即止（无图形会话时用）
#   ./reproduce.sh --skip-packages   # 跳过 deb / pacman 构造（无 dpkg-deb / bsdtar 时）
#
# 任一阶段失败即中止；各脚本自身会往 report/ 写日志与结构化结果。
set -euo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$PORT_ROOT/scripts/_layout.sh"
ZCODE_ROOT="$(resolve_zcode_root)"
export ZCODE_ROOT

# 移植工具链不在系统 PATH，必须显式前置
export PATH="$PORT_ROOT/opt/node-v24.14.0-linux-loong64/bin:$PORT_ROOT/opt/pnpm-home/bin:$PATH"
export ELECTRON_OVERRIDE_DIST_PATH="$PORT_ROOT/opt/electron-v43.7.7-linux-loong64"
export ZCODE_TARGET_OS=linux ZCODE_TARGET_ARCH=loong64
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"

# electron-builder 走 electronDist 快路径，绕开会挂起的在线下载；目录或 zip 都可
if [[ -z "${ZCODE_ELECTRON_DIST:-}" ]]; then
  if [[ -d "$PORT_ROOT/opt/electron-v43.7.7-linux-loong64" ]]; then
    export ZCODE_ELECTRON_DIST="$PORT_ROOT/opt/electron-v43.7.7-linux-loong64"
  elif [[ -f "$PORT_ROOT/downloads/electron-v43.7.7-linux-loong64.zip" ]]; then
    export ZCODE_ELECTRON_DIST="$PORT_ROOT/downloads/electron-v43.7.7-linux-loong64.zip"
  fi
fi

STAGES=(clone fetch patch install inject pty verify build bundle package smoke)
FROM="${STAGES[0]}"
DRY=0
SKIP_SMOKE=0
SKIP_PACKAGES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --skip-packages) SKIP_PACKAGES=1 ;;
    --from=*) FROM="${arg#--from=}" ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

start=-1
for i in "${!STAGES[@]}"; do
  if [[ "${STAGES[$i]}" == "$FROM" ]]; then start=$i; fi
done
if (( start < 0 )); then
  echo "--from 必须是以下之一: ${STAGES[*]}" >&2
  exit 2
fi

echo "=== ZCode loong64 一键复现 ==="
echo "源码树       : $ZCODE_ROOT"
echo "Node         : $(command -v node 2>/dev/null || echo '尚未安装（请先跑 fetch 阶段）')"
echo "Electron dist: ${ZCODE_ELECTRON_DIST:-<未设置>}"

for i in "${!STAGES[@]}"; do
  if (( i < start )); then continue; fi
  stage="${STAGES[$i]}"
  if [[ "$stage" == "smoke" && "$SKIP_SMOKE" == "1" ]]; then continue; fi
  if [[ "$stage" == "package" && "$SKIP_PACKAGES" == "1" ]]; then continue; fi
  echo ""
  echo "━━━ [$((i+1))/${#STAGES[@]}] $stage  $(date +%H:%M:%S) ━━━"
  if (( DRY )); then
    echo "  (dry-run 跳过)"
    continue
  fi
  case "$stage" in
    clone)
      if [[ -d "$ZCODE_ROOT/.git" ]]; then
        echo "  上游源码已存在，跳过"
      else
        git clone --depth 1 https://github.com/acdcGGE/ZCode.git "$ZCODE_ROOT"
      fi ;;
    fetch)
      "$PORT_ROOT/scripts/00-fetch-runtime.sh" ;;
    patch)
      node "$PORT_ROOT/scripts/01-apply-port.mjs" --check --zcode="$ZCODE_ROOT"
      node "$PORT_ROOT/scripts/01-apply-port.mjs" --zcode="$ZCODE_ROOT" ;;
    install)
      "$PORT_ROOT/scripts/02-install.sh" --no-scripts
      "$PORT_ROOT/scripts/02-install.sh" ;;
    inject)
      node "$PORT_ROOT/scripts/05-inject-native-bindings.mjs" --check --zcode="$ZCODE_ROOT"
      node "$PORT_ROOT/scripts/05-inject-native-bindings.mjs" --zcode="$ZCODE_ROOT" ;;
    pty)
      "$PORT_ROOT/scripts/06-build-loong64-node-pty.sh" ;;
    verify)
      "$PORT_ROOT/scripts/04-verify.sh" ;;
    build)
      "$PORT_ROOT/scripts/03-build.sh" build ;;
    bundle)
      "$PORT_ROOT/scripts/03-build.sh" bundle ;;
    package)
      # 从 --dir 产物用本机 dpkg-deb / bsdtar+zstd 构造 deb 与 ArchLinux 包。
      node "$PORT_ROOT/scripts/10-package-linux.mjs"
      # 前面的 verify 阶段排在这里之前，安装包检查会被跳过；出包后再跑一次补齐 18 项。
      "$PORT_ROOT/scripts/04-verify.sh" ;;
    smoke)
      "$PORT_ROOT/scripts/09-smoke-launch.sh" ;;
  esac
done

echo ""
echo "全部阶段完成。"
echo "解包目录 : $ZCODE_ROOT/packages/desktop/dist/linux-loong64-unpacked/"
echo "安装包   : $ZCODE_ROOT/packages/desktop/dist/ 下的 .deb 与 .pkg.tar.zst"
