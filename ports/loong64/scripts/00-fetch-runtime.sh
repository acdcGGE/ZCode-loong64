#!/usr/bin/env bash
# 获取 ZCode 龙芯移植所需的运行时二进制，并校验、就地安装。
# 可重复执行：已下载且校验通过的文件会跳过。
set -euo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VER="24.14.0"
ELECTRON_VER="43.7.7"
PNPM_VER="10.33.2"
DL="$PORT_ROOT/downloads"
OPT="$PORT_ROOT/opt"
REGISTRY="https://registry.npmmirror.com"

mkdir -p "$DL" "$OPT" "$PORT_ROOT/report"

NODE_TAR="node-v${NODE_VER}-linux-loong64.tar.xz"
ELE_ZIP="electron-v${ELECTRON_VER}-linux-loong64.zip"
NODE_URL="https://github.com/loong64/node/releases/download/v${NODE_VER}"
ELE_URL="https://github.com/darkyzhou/electron-loong64/releases/download/v${ELECTRON_VER}"

# 单连接访问 GitHub release 会被限速到 5~100 KB/s；多镜像 + 多连接实测可达 1 MB/s。
PROXY_PREFIXES=("" "https://ghproxy.net/" "https://gh-proxy.com/")

fetch() {
  local upstream="$1" name="$2" uris=() p
  local out="$DL/$name"
  if [[ -s "$out" ]]; then
    echo "[fetch] skip (exists): $name"
    return 0
  fi
  for p in "${PROXY_PREFIXES[@]}"; do uris+=("${p}${upstream}"); done
  echo "[fetch] $name <- ${#uris[@]} mirrors"
  if command -v aria2c >/dev/null 2>&1; then
    aria2c -x 12 -s 12 -k 1M --min-split-size=1M --file-allocation=none \
      --max-tries=5 --retry-wait=3 --timeout=60 --console-log-level=warn \
      --summary-interval=0 -d "$DL" -o "$name" "${uris[@]}"
  else
    curl -fL --retry 5 --retry-delay 3 -o "$out" "$upstream"
  fi
}

check_sha() {
  local file="$DL/$1" expected="$2"
  echo "${expected}  ${file}" | sha256sum -c - >/dev/null
  echo "[verify] OK: $1"
}

# ---- Node.js 24.14.0 (loong64/node 的 glibc 构建) ----
fetch "${NODE_URL}/${NODE_TAR}" "$NODE_TAR"
fetch "${NODE_URL}/${NODE_TAR}.sha256" "${NODE_TAR}.sha256"
NODE_SHA="$(awk '{print $1}' "$DL/${NODE_TAR}.sha256")"
check_sha "$NODE_TAR" "$NODE_SHA"

NODE_HOME="$OPT/node-v${NODE_VER}-linux-loong64"
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  tar -xJf "$DL/$NODE_TAR" -C "$OPT"
fi
export PATH="$NODE_HOME/bin:$PATH"
echo "[runtime] $(node -v) / $(node -p process.arch) / ABI $(node -p process.versions.modules)"

# ---- pnpm ----
if [[ ! -x "$OPT/pnpm-home/bin/pnpm" ]]; then
  "$NODE_HOME/bin/npm" install -g --prefix "$OPT/pnpm-home" --registry="$REGISTRY" "pnpm@${PNPM_VER}"
fi
export PATH="$OPT/pnpm-home/bin:$PATH"
echo "[runtime] pnpm $(pnpm -v)"

# ---- Electron 43.7.7 loong64 (darkyzhou/electron-loong64) ----
fetch "${ELE_URL}/${ELE_ZIP}" "$ELE_ZIP"
fetch "${ELE_URL}/SHASUMS256.txt" "SHASUMS256.txt"
fetch "${ELE_URL}/ffmpeg-v${ELECTRON_VER}-linux-loong64.zip" "ffmpeg-v${ELECTRON_VER}-linux-loong64.zip"

# headers 是小文件，多连接分段反而容易被代理截断；逐源 curl 并做 tar 完整性校验。
HEADERS="node-v${ELECTRON_VER}-headers.tar.gz"
if [[ ! -s "$DL/$HEADERS" ]] || ! tar -tzf "$DL/$HEADERS" >/dev/null 2>&1; then
  HEADERS_URL="${ELE_URL}/${HEADERS}"
  for prefix in "${PROXY_PREFIXES[@]}"; do
    echo "[fetch] $HEADERS <- ${prefix:-direct}"
    if curl -fsSL -m 120 -o "$DL/$HEADERS" "${prefix}${HEADERS_URL}" && \
       [[ $(stat -c%s "$DL/$HEADERS") -gt 200000 ]] && \
       tar -tzf "$DL/$HEADERS" >/dev/null 2>&1; then
      echo "[verify] OK: $HEADERS"
      break
    fi
  done
fi
tar -tzf "$DL/$HEADERS" >/dev/null 2>&1 || { echo "[verify] $HEADERS 不完整，无法继续"; exit 1; }

ELE_SHA="$(awk -v n="$ELE_ZIP" '$2 == "*" n || $2 == n {print $1}' "$DL/SHASUMS256.txt" | head -1)"
if [[ -z "$ELE_SHA" ]]; then echo "[verify] 找不到 $ELE_ZIP 的摘要"; exit 1; fi
check_sha "$ELE_ZIP" "$ELE_SHA"

ELE_HOME="$OPT/electron-v${ELECTRON_VER}-linux-loong64"
if [[ ! -x "$ELE_HOME/electron" ]]; then
  mkdir -p "$ELE_HOME"
  unzip -oq "$DL/$ELE_ZIP" -d "$ELE_HOME"
fi
echo "[runtime] electron binary: $(file -b "$ELE_HOME/electron" | cut -c1-90)"

# Electron 43 的 node headers 供 @electron/rebuild 重编译 node-pty 等原生模块
ELE_CACHE="$HOME/.cache/electron/node-v${ELECTRON_VER}-headers"
if [[ ! -f "$ELE_CACHE/include/node/node.h" ]]; then
  mkdir -p "$ELE_CACHE"
  tar -xzf "$DL/$HEADERS" -C "$ELE_CACHE" --strip-components=1
fi
echo "[runtime] electron headers: $ELE_CACHE"

cat > "$PORT_ROOT/report/runtime.json" <<EOF
{
  "node": {"version": "$(node -v)", "arch": "$(node -p process.arch)", "modules": "$(node -p process.versions.modules)", "home": "$NODE_HOME"},
  "pnpm": "$(pnpm -v)",
  "electron": {"version": "${ELECTRON_VER}", "home": "$ELE_HOME", "source": "darkyzhou/electron-loong64", "sha256": "$ELE_SHA"},
  "generatedAt": "$(date -Is)"
}
EOF
echo "[done] 运行时就绪，摘要见 report/runtime.json"
