#!/usr/bin/env bash
# 移植体检：不改任何产物，只检查运行时、平台识别、打包参数、原生模块落地与安装包完整性。
set -uo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/_layout.sh"
ZCODE_ROOT="$(resolve_zcode_root)"
OPT="$PORT_ROOT/opt"
NODE_VER="24.14.0"
ELECTRON_VER="43.7.7"
REPORT="$PORT_ROOT/report/verify.json"

export PATH="$OPT/node-v${NODE_VER}-linux-loong64/bin:$OPT/pnpm-home/bin:$PATH"
export ZCODE_TARGET_OS=linux
export ZCODE_TARGET_ARCH=loong64
export ELECTRON_OVERRIDE_DIST_PATH="$OPT/electron-v${ELECTRON_VER}-linux-loong64"

PASS=0; FAIL=0
check() { # $1 名称, $2 命令输出或状态判定
  local name="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "0" ]]; then echo "  PASS  $name $detail"; PASS=$((PASS+1));
  else echo "  FAIL  $name $detail"; FAIL=$((FAIL+1)); fi
}

echo "=== ZCode loong64 移植体检 $(date -Is) ==="

node -v >/dev/null 2>&1; check "Node 24 loong64" "$?" "$(node -v 2>/dev/null) / $(node -p process.arch 2>/dev/null)"
pnpm -v >/dev/null 2>&1; check "pnpm 10.33.2" "$?" "$(pnpm -v 2>/dev/null)"

ELE="$OPT/electron-v${ELECTRON_VER}-linux-loong64/electron"
ELE_OUT="$(ELECTRON_RUN_AS_NODE=1 "$ELE" -p "process.versions.electron+' node='+process.versions.node+' abi='+process.versions.modules" 2>/dev/null)"
[[ $? -eq 0 && "$ELE_OUT" == 43.7.7* ]]; check "Electron loong64 可执行" "$?" "$ELE_OUT"

PLATFORM_KEY="$(cd "$ZCODE_ROOT" && node -e "import('./packages/desktop/scripts/target-platform.mjs').then(m=>console.log(m.getTargetPlatform().key))" 2>/dev/null)"
[[ "$PLATFORM_KEY" == "linux-loong64" ]]; check "target-platform 平台键" "$?" "$PLATFORM_KEY"

BUNDLE_OUT="$(cd "$ZCODE_ROOT/packages/desktop" && node scripts/bundle.mjs --dry-run 2>&1 | grep -m1 'target=')"
[[ "$BUNDLE_OUT" == *"linux/loong64"* ]]; check "bundle.mjs 目标参数" "$?" "$BUNDLE_OUT"

ELE_PKG_VER="$(cd "$ZCODE_ROOT" && node -p "require('./packages/desktop/package.json').devDependencies.electron || require('./packages/desktop/package.json').dependencies.electron" 2>/dev/null)"
[[ "$ELE_PKG_VER" == "43.7.7" ]]; check "Electron 版本对齐" "$?" "$ELE_PKG_VER"

# 本仓库 .npmrc 使用 node-linker=hoisted，原生包平铺在 node_modules/ 下，而非 .pnpm/
for pkg in "@esbuild/linux-loong64" "@rollup/rollup-linux-loong64-gnu"; do
  [[ -d "$ZCODE_ROOT/node_modules/$pkg" ]]; check "原生包 $pkg" "$?"
done
(cd "$ZCODE_ROOT" && node -e "require('esbuild').transformSync('const a=1')" >/dev/null 2>&1)
check "esbuild 龙芯原生二进制可加载" "$?"

# 05-inject-native-bindings.mjs 的四项适配
(cd "$ZCODE_ROOT" && node -e "if(require('rolldown').VERSION!=='1.0.3') process.exit(1); require('lightningcss').transform; require('@tailwindcss/oxide').Scanner" >/dev/null 2>&1)
check "rolldown/lightningcss/oxide 注入链" "$?"
node "$PORT_ROOT/scripts/05-inject-native-bindings.mjs" --check >/dev/null 2>&1
check "原生绑定注入项齐备" "$?"

# 06 脚本编译的 node-pty prebuild：必须能被 Electron 43 真正 require
PTY="$ZCODE_ROOT/node_modules/node-pty/prebuilds/linux-loong64/pty.node"
PTY_OUT="$(ELECTRON_RUN_AS_NODE=1 "$ELE" -e "const p=require('$PTY'); console.log(Object.keys(p).join(','))" 2>/dev/null)"
[[ "$PTY_OUT" == *fork* ]]; check "node-pty loong64 prebuild 可加载" "$?" "$PTY_OUT"

# 05 脚本新增的两项龙芯官方原生包必须能在 Electron 43 里真正工作。
# 只在 host Node 上验会漏掉 canvas 的 libstdc++ 问题：Node 主进程自带该库，Electron 不带。
NATIVE_OUT="$(ELECTRON_RUN_AS_NODE=1 "$ELE" -e "const c=require('$ZCODE_ROOT/node_modules/@napi-rs/canvas');const b=c.createCanvas(8,8).toBuffer('image/png');require('$ZCODE_ROOT/node_modules/@tailwindcss/oxide/tailwindcss-oxide.linux-loong64-gnu.node');const o=require('$ZCODE_ROOT/node_modules/@tailwindcss/oxide');console.log('png='+b.length+' scanner='+typeof o.Scanner)" 2>/dev/null)"
[[ "$NATIVE_OUT" == png=*scanner=function* ]]; check "canvas/oxide 官方原生包在 Electron 43 可用" "$?" "$NATIVE_OUT"

# 08 脚本：源码里从 electron 静态具名导入的「值」必须在目标 Electron 版本中存在。
# ESM 在模块链接期校验导出表，缺失就抛 SyntaxError 把整个主进程带走；
# loong64 从上游的 44.7.0 降到 43.7.7 后，ClipboardItem 正是这样炸掉的。
AUDIT_OUT="$(node "$PORT_ROOT/scripts/08-audit-electron-api.mjs" 2>&1)"
[[ $? -eq 0 ]]; check "electron 具名导入与 43 兼容" "$?" "$(echo "$AUDIT_OUT" | head -1 | cut -c1-70)"

# 阶段 10：deb / pacman 安装包。--dir 只是 electron-builder 的交付形态，
# 两个标准格式包由 scripts/10 用本机 dpkg-deb + bsdtar/zstd 从解包目录另行构造。
# 首次复现时体检排在打包之前、报告还不存在，此时跳过而不是误报 FAIL；
# reproduce.sh 在 package 阶段结束后会再跑一次体检，把这 4 项补上。
PKG_REPORT="$PORT_ROOT/report/linux-packages.json"
if [[ -f "$PKG_REPORT" ]]; then
  PKG_CHECK_OUT="$(node "$PORT_ROOT/scripts/10-package-linux.mjs" --check 2>&1)"
  check "deb/pacman 产物完整且校验和一致" "$?" "$(echo "$PKG_CHECK_OUT" | tail -1 | cut -c1-70)"
  # 报告里的 path 是生成时的本机绝对路径；按文件名在当前源码树的 dist/ 下重新定位。
  DIST_DIR="$ZCODE_ROOT/packages/desktop/dist"
  DEB_FILE="$(node -p "require('$PKG_REPORT').deb.file" 2>/dev/null)"
  PACMAN_FILE="$(node -p "require('$PKG_REPORT').pacman.file" 2>/dev/null)"
  DEB_PATH="$DIST_DIR/$DEB_FILE"
  PACMAN_PATH="$DIST_DIR/$PACMAN_FILE"
  DEB_FIELDS="$(dpkg-deb -f "$DEB_PATH" Package Version Architecture Depends 2>/dev/null)"
  [[ "$DEB_FIELDS" == *"Architecture: loong64"* && "$DEB_FIELDS" == *"Depends:"* ]]
  check "deb 控制字段（loong64 / Depends）" "$?" "$(echo "$DEB_FIELDS" | grep -m1 '^Architecture:' | cut -c1-50)"

  PKGINFO="$(bsdtar -xOf "$PACMAN_PATH" .PKGINFO 2>/dev/null)"
  [[ "$PKGINFO" == *"arch = loong64"* && "$PKGINFO" == *"pkgname = "* && "$PKGINFO" == *"depend ="* ]]
  check "pacman .PKGINFO（arch / depend）" "$?" "$(echo "$PKGINFO" | grep -m1 '^pkgname =' | cut -c1-50)"

  PKG_CHECKS="$(node -e "const c=require('$PKG_REPORT').checks||[];console.log(c.filter(x=>x.pass).length+'/'+c.length)" 2>/dev/null)"
  [[ "$PKG_CHECKS" =~ ^([0-9]+)/([0-9]+)$ ]] && (( BASH_REMATCH[1] > 0 && BASH_REMATCH[1] == BASH_REMATCH[2] ))
  check "安装包构造自检全通过" "$?" "$PKG_CHECKS"
else
  echo "  SKIP  安装包 4 项（尚无 report/linux-packages.json，跑完阶段 10 后由体检覆盖）"
fi

echo "=== 结果: PASS=$PASS FAIL=$FAIL ==="
mkdir -p "$PORT_ROOT/report"
cat > "$REPORT" <<EOF
{
  "checkedAt": "$(date -Is)",
  "pass": $PASS,
  "fail": $FAIL,
  "node": "$(node -v 2>/dev/null)",
  "nodeArch": "$(node -p process.arch 2>/dev/null)",
  "electron": "$ELE_OUT",
  "targetPlatformKey": "$PLATFORM_KEY",
  "bundleTarget": "$BUNDLE_OUT",
  "nodePtyPrebuild": "$PTY_OUT",
  "officialNativeBindings": "$NATIVE_OUT",
  "linuxPackagesChecks": "${PKG_CHECKS:-}",
  "linuxPackagesDeb": "${DEB_FILE:-}",
  "linuxPackagesPacman": "${PACMAN_FILE:-}"
}
EOF
[[ $FAIL -eq 0 ]]
