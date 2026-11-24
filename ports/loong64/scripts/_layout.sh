#!/usr/bin/env bash
# 移植层的布局探测（供各 shell 脚本 source）。
#
# 支持两种摆放方式，无需调用方设置 ZCODE_ROOT：
#   A 独立目录：<workdir>/zcode-loong64-port/   源码树在 <workdir>/ZCode/
#   B 仓库内  ：<repo>/ports/loong64/           源码树就是 <repo>/ 本身
# 判定依据：布局 B 的「上两级」就是仓库根，含 packages/desktop。
#
# 用法：
#   source "$(dirname "${BASH_SOURCE[0]}")/_layout.sh"
#   ZCODE_ROOT="$(resolve_zcode_root)"
# 仍可用 ZCODE_ROOT=/path 显式覆盖。

_LAYOUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_zcode_root() {
  if [[ -n "${ZCODE_ROOT:-}" ]]; then
    printf '%s\n' "$ZCODE_ROOT"
    return
  fi
  local port_root repo_root
  port_root="$(cd "$_LAYOUT_DIR/.." && pwd)"
  repo_root="$(cd "$port_root/../.." && pwd)"
  if [[ -d "$repo_root/packages/desktop" ]]; then
    printf '%s\n' "$repo_root"
  else
    printf '%s\n' "$(cd "$port_root/.." && pwd)/ZCode"
  fi
}
