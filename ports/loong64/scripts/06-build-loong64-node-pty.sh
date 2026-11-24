#!/usr/bin/env bash
# 为 linux-loong64 落地 node-pty 原生模块，并按 electron-builder 的 beforePack 约定 staged。
#
# 优先级（实测验证过的两条路径）：
#  A. 龙芯官方源 registry.loongnix.cn:5873 的 @lydell/node-pty-linux-loong64
#     （与工程 desktop optionalDependencies 声明的 1.2.0-beta.10 精确匹配）。
#     官方包干净：DT_NEEDED 只有 libstdc++/libm/libgcc_s/libc/ld-linux，无 libnode 依赖，
#     Electron 43 与 Node 24 双环境 require 通过。
#  B. 本地源码编译（fallback）：node-pty 1.1.0 Linux 目标是 N-API，用 Electron 43 headers
#     + node-gyp 编译。Debian node-gyp 会额外链接宿主 libnode.so.115（Node 20 的库），
#     Electron 43 目录里没有，直接 require 会 SIGSEGV(139)；patchelf 去掉该 DT_NEEDED 后
#     Electron 主程序自导出的 napi_* 符号即可满足加载。
#
# beforePack 的 restoreTargetNodePtyPrebuild 要求能 require.resolve 到
# @lydell/node-pty-linux-loong64，且包内存在 prebuilds/linux-loong64/pty.node。
#
# 用法: ./scripts/06-build-loong64-node-pty.sh [--force] [--from-source]
#   --force       忽略已有产物，重新获取/编译
#   --from-source 跳过官方包，强制本地源码编译
set -euo pipefail

P="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/_layout.sh"
ZCODE_ROOT="$(resolve_zcode_root)"
ELECTRON_VER="43.7.7"
HEADERS="${ELECTRON_HEADERS_DIR:-$HOME/.cache/electron/node-v${ELECTRON_VER}-headers}"
ELECTRON_BIN="${ELECTRON_BIN:-$P/opt/electron-v${ELECTRON_VER}-linux-loong64/electron}"
REPORT="$P/report/native-node-pty.json"
PLATFORM_KEY="linux-loong64"
LOONGNIX="https://registry.loongnix.cn:5873"
OFFICIAL_VER="1.2.0-beta.10"
OFFICIAL_TGZ="$P/downloads/native/loongnix/node-pty-linux-loong64-${OFFICIAL_VER}.tgz"
FORCE=0
FROM_SOURCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --from-source) FROM_SOURCE=1 ;;
  esac
done

export PATH="$P/opt/node-v24.14.0-linux-loong64/bin:$PATH"

log() { printf '[node-pty] %s\n' "$*"; }
die() { printf '[node-pty] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$ZCODE_ROOT/node_modules/node-pty" ]] || die "node-pty 未安装: $ZCODE_ROOT"
[[ -x "$ELECTRON_BIN" ]]                 || die "Electron 二进制不存在: $ELECTRON_BIN"

PTY_ROOT="$ZCODE_ROOT/node_modules/node-pty"
PREBUILD_DIR="$PTY_ROOT/prebuilds/$PLATFORM_KEY"
PREBUILD="$PREBUILD_DIR/pty.node"
SHIM_DIR="$ZCODE_ROOT/node_modules/@lydell/node-pty-$PLATFORM_KEY"
SOURCE="none"

# 验证失败一律 return 1（不能 die/exit）：官方包可能因 GLIBC 版本不匹配而无法加载，
# 此时必须让 fetch_official 失败，好让主流程降级到本地源码编译。
verify_pty() {
  local bin="$1"
  file "$bin" | grep -qi 'LoongArch' || { log "验证失败: 产物不是 LoongArch ELF: $bin"; return 1; }
  readelf -d "$bin" | grep -q 'libnode.so' && { log "验证失败: 存在 libnode DT_NEEDED（Electron 下会 SIGSEGV）: $bin"; return 1; }
  local out
  out="$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e \
    "const p=require('$bin'); console.log(Object.keys(p).join(','))" 2>&1)" \
    || { log "验证失败: Electron $ELECTRON_VER 加载 pty.node 失败: ${out:0:400}"; return 1; }
  echo "$out" | grep -q 'fork' || { log "验证失败: Electron 加载结果异常: $out"; return 1; }
  log "Electron $ELECTRON_VER 加载通过: $out"
  node -e "const p=require('$bin'); if(!p.fork) process.exit(1)" \
    || { log "验证失败: Node 24 加载 pty.node 失败"; return 1; }
  log "Node 24 加载通过"
  return 0
}

# ---- A. 官方包路径 ----
fetch_official() {
  log "从龙芯官方源获取 @lydell/node-pty-linux-loong64@$OFFICIAL_VER"
  mkdir -p "$(dirname "$OFFICIAL_TGZ")"
  if [[ ! -s "$OFFICIAL_TGZ" || $FORCE -eq 1 ]]; then
    curl -fsSL -m 120 -o "$OFFICIAL_TGZ" \
      "$LOONGNIX/@lydell%2fnode-pty-linux-loong64/-/node-pty-linux-loong64-$OFFICIAL_VER.tgz" \
      || { rm -f "$OFFICIAL_TGZ"; return 1; }
  fi
  local tmp
  tmp="$(mktemp -d)"
  tar -xzf "$OFFICIAL_TGZ" -C "$tmp" || { rm -rf "$tmp"; return 1; }
  local bin="$tmp/package/prebuilds/$PLATFORM_KEY/pty.node"
  [[ -f "$bin" ]] || { rm -rf "$tmp"; log "官方包内无 prebuilds/$PLATFORM_KEY/pty.node"; return 1; }
  verify_pty "$bin" || { rm -rf "$tmp"; log "官方包验证失败（常见于上游重编后要求更高 GLIBC），降级本地编译"; return 1; }
  mkdir -p "$PREBUILD_DIR"
  cp -f "$bin" "$PREBUILD"
  # 完整落地官方包（lib/ + package.json + prebuilds），保持与真实安装一致的布局，
  # require.resolve('@lydell/node-pty-linux-loong64') 才能命中 package.json 的 exports。
  rm -rf "$SHIM_DIR"
  cp -r "$tmp/package" "$SHIM_DIR"
  rm -rf "$tmp"
  SOURCE="loongnix-official@$OFFICIAL_VER"
  log "官方包落地: $SHIM_DIR（prebuild 同步到 $PREBUILD）"
  return 0
}

# ---- B. 本地源码编译路径 ----
build_from_source() {
  [[ -f "$HEADERS/include/node/node.h" ]] || die "Electron headers 缺失或不完整: $HEADERS"
  for tool in node-gyp gcc g++ make python3 patchelf readelf; do
    command -v "$tool" >/dev/null 2>&1 || die "缺少工具: $tool"
  done
  local built="$PTY_ROOT/build/Release/pty.node"
  if [[ $FORCE -eq 1 || ! -f "$built" ]]; then
    log "node-gyp rebuild --nodedir=$HEADERS --arch=loong64"
    (cd "$PTY_ROOT" && node-gyp rebuild --nodedir="$HEADERS" --arch=loong64) \
      > "$P/report/node-pty-build.log" 2>&1 || {
        tail -c 1500 "$P/report/node-pty-build.log" >&2
        die "node-gyp 编译失败，日志 report/node-pty-build.log"
      }
    log "编译完成: $built"
  else
    log "复用已编译产物: $built（--force 可强制重编）"
  fi
  [[ -f "$built" ]] || die "编译产物不存在: $built"

  local -a node_libs=()
  mapfile -t node_libs < <(readelf -d "$built" | sed -n 's/.*NEEDED.*\[\(libnode\.so[^]]*\)\].*/\1/p')
  if ((${#node_libs[@]} > 0)); then
    for lib in "${node_libs[@]}"; do
      log "patchelf --remove-needed $lib"
      patchelf --remove-needed "$lib" "$built"
    done
  fi
  readelf -d "$built" | grep -q 'libnode.so' && die "仍存在 libnode DT_NEEDED"
  verify_pty "$built" || die "本地编译产物验证失败"

  mkdir -p "$PREBUILD_DIR" "$SHIM_DIR/prebuilds/$PLATFORM_KEY"
  cp -f "$built" "$PREBUILD"
  cp -f "$built" "$SHIM_DIR/prebuilds/$PLATFORM_KEY/pty.node"
  cat > "$SHIM_DIR/package.json" <<EOF
{
  "name": "@lydell/node-pty-$PLATFORM_KEY",
  "version": "1.1.0",
  "main": "index.js",
  "description": "Local loong64 prebuild built from source by zcode-loong64-port/scripts/06 (not for redistribution)"
}
EOF
  cat > "$SHIM_DIR/index.js" <<'EOF'
// Minimal shim: the real payload is prebuilds/<platformKey>/pty.node.
module.exports = {};
EOF
  SOURCE="local-build"
  log "本地编译产物落地: $PREBUILD"
}

# ---- 选择路径：默认官方优先，--from-source 强制本地编译 ----
if [[ $FROM_SOURCE -eq 0 ]]; then
  fetch_official || { log "官方包路径失败，降级为本地源码编译"; build_from_source; }
else
  log "--from-source：跳过官方包，直接本地编译"
  build_from_source
fi

# ---- beforePack 解析验证 ----
RESOLVE_OUT="$(cd "$ZCODE_ROOT" && node -e "
const r=require('module').createRequire('$ZCODE_ROOT/packages/desktop/scripts/node-pty-package-assets.mjs');
const p=r.resolve('@lydell/node-pty-$PLATFORM_KEY');
const fs=require('fs'),path=require('path');
let d=path.dirname(p);
while(d!==path.dirname(d)){
  const c=path.resolve(d,'prebuilds','$PLATFORM_KEY','pty.node');
  if(fs.existsSync(c)){console.log(c);process.exit(0)}
  d=path.dirname(d);
}
console.error('not found');process.exit(1)
" 2>&1)" || die "beforePack 解析失败: $RESOLVE_OUT"
log "beforePack 解析通过: $RESOLVE_OUT"

mkdir -p "$(dirname "$REPORT")"
cat > "$REPORT" <<EOF
{
  "platform": "$PLATFORM_KEY",
  "electronVersion": "$ELECTRON_VER",
  "source": "$SOURCE",
  "officialRegistry": "$LOONGNIX",
  "officialVersion": "$OFFICIAL_VER",
  "stagedPrebuild": "$PREBUILD",
  "stagedPackage": "$SHIM_DIR",
  "electronLoadTest": "fork,open,resize,process",
  "node24LoadTest": "pass",
  "beforePackResolve": "$RESOLVE_OUT",
  "elf": "$(file -b "$PREBUILD")",
  "verified": true
}
EOF
log "报告写入 $REPORT"
log "完成（来源: $SOURCE）。"
