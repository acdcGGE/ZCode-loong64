#!/usr/bin/env bash
# 09-smoke-launch.sh —— 运行期冒烟测试
#
# 打包成功不等于跑得起来：主进程的 ESM 具名导入、原生模块加载、preload 沙箱
# 都要在真实的 Electron 运行时里才会暴露问题。本脚本启动已打包的 loong64 产物，
# 断言主进程不崩、主窗口被创建，并在有 grim 的环境下留一张截图。
#
#   ./09-smoke-launch.sh              # 默认 25s 观察窗口
#   WAIT_SECONDS=40 ./09-smoke-launch.sh
#   ./09-smoke-launch.sh --no-screenshot
#
# 退出码：0 = 通过；1 = 主进程崩溃；2 = 产物缺失
set -uo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/_layout.sh"
ZCODE_ROOT="$(resolve_zcode_root)"
APP_DIR="$ZCODE_ROOT/packages/desktop/dist/linux-loong64-unpacked"
# 可指向从 deb / pacman 解包出来的安装布局（/usr/bin/<exe> 软链 -> /opt/<pkg>/<exe>），
# 用来验证「装完能不能跑」而不只是「解包目录能不能跑」。
APP="${ZCODE_SMOKE_APP:-$APP_DIR/zcode-preview}"
WAIT_SECONDS="${WAIT_SECONDS:-25}"
SHOT="${SHOT:-$PORT_ROOT/report/zcode-loong64-launch.png}"
LOG="${SMOKE_LOG:-$PORT_ROOT/report/smoke-launch.log}"
SHOOT=1
[[ "${1:-}" == "--no-screenshot" ]] && SHOOT=0

mkdir -p "$PORT_ROOT/report"
[[ -x "$APP" ]] || { echo "[smoke] 找不到可执行文件：$APP"; exit 2; }
APP_REAL="$(readlink -f "$APP")"
APP_RESOURCES="$(dirname "$APP_REAL")/resources/app.asar"
[[ -f "$APP_RESOURCES" ]] || { echo "[smoke] 找不到 $APP_RESOURCES"; exit 2; }

# 用隔离的数据目录，避免污染用户 ~/.zcode 里的设置与会话。
SMOKE_HOME="$(mktemp -d /tmp/zcode-smoke-home.XXXXXX)"
export ZCODE_DATA_BASE_DIR="$SMOKE_HOME"
# 工作台环境里可能带着 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成正牌 node 直接退出。
unset ELECTRON_RUN_AS_NODE

echo "[smoke] app=$APP"
echo "[smoke] real=$APP_REAL"
echo "[smoke] data=$SMOKE_HOME wait=${WAIT_SECONDS}s"

# setsid 独立进程组：超时后可按组回收，不留孤儿渲染进程。
setsid "$APP" > "$LOG" 2>&1 &
LAUNCHER=$!
sleep 1
PGID="$(ps -o pgid= -p "$LAUNCHER" 2>/dev/null | tr -d ' ')"

for _ in $(seq 1 "$WAIT_SECONDS"); do
  sleep 1
  kill -0 "$LAUNCHER" 2>/dev/null || break
done

ALIVE=0
kill -0 "$LAUNCHER" 2>/dev/null && ALIVE=1

# 截图必须在进程存活时抓取，否则只能拿到桌面
if [[ "$SHOOT" == "1" ]] && [[ "$ALIVE" == "1" ]] && command -v grim >/dev/null 2>&1; then
  if grim "$SHOT" 2>/dev/null; then echo "[smoke] 截图：$SHOT"; else echo "[smoke] 截图失败（无 Wayland 会话时跳过）"; fi
fi

if [[ -n "${PGID:-}" ]]; then
  kill -TERM "-$PGID" 2>/dev/null
  sleep 3
  kill -KILL "-$PGID" 2>/dev/null
fi
wait "$LAUNCHER" 2>/dev/null

fail=0
pass() { echo "[smoke] PASS  $1"; }
bad()  { echo "[smoke] FAIL  $1"; fail=$((fail + 1)); }

# 1) 主进程未因模块加载失败而退出（ESM 具名导入缺失的典型症状）
if grep -qiE "does not provide an export named|A JavaScript error occurred in the main process|Uncaught Exception" "$LOG"; then
  bad "主进程抛出未捕获异常（详见 $LOG）"
  grep -iE "does not provide an export named|Uncaught Exception" "$LOG" | head -3 | cut -c1-200
else
  pass "主进程无未捕获异常"
fi

# 2) 启动流程真的走到了创建主窗口
if grep -q "创建主窗口\|creating main window" "$LOG"; then
  pass "主窗口创建流程已触发"
else
  bad "日志中没有主窗口创建记录"
fi

# 3) 渲染进程与 preload 未报错（did-fail-load 表示页面没起来）
if grep -q "did-fail-load" "$LOG"; then
  bad "渲染进程加载失败（did-fail-load）"
else
  pass "渲染进程无加载失败"
fi

# 4) host 子进程（agent runtime）成功启动，说明 node-pty/koffi 等原生模块可加载
if grep -q "forked host process" "$LOG"; then
  pass "host 子进程已拉起"
else
  bad "host 子进程未拉起"
fi

# 5) 观察窗口结束时进程仍存活（没有静默退出）
[[ "$ALIVE" == "1" ]] && pass "观察窗口内进程保持存活" || bad "进程提前退出"

echo "[smoke] 日志：$LOG（隔离数据目录 $SMOKE_HOME 可手动删除）"
[[ "$fail" -eq 0 ]] || { echo "[smoke] === $fail 项失败 ==="; exit 1; }
echo "[smoke] === 全部通过 ==="
exit 0
