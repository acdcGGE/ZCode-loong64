# 第三方组件与二进制来源

本移植层只含脚本、补丁与文档，构建时按需下载并注入以下第三方组件，**均不随本仓库分发**。这里记录包名、精确版本与来源，供审计与二次分发核对；许可证以各 npm 包内 `LICENSE` / `package.json` 的 `license` 字段为准，本文件不代替许可文本。

## 工具链（`scripts/00-fetch-runtime.sh`）

| 组件 | 版本 | 来源 | 用途 |
| --- | --- | --- | --- |
| Node.js loong64 | 24.14.0 | `loong64/node` glibc 构建 | 宿主 Node（系统 20.15.1 不满足 24+） |
| pnpm | 10.33.2 | npm 官方包 | workspace 依赖管理 |
| Electron loong64 | 43.7.7 | `darkyzhou/electron-loong64` 预编译二进制 + headers | 桌面运行时；上游锁 44.7.0，龙芯暂无 44 构建 |
| Electron headers | 43.7.7 | 同上 | node-gyp 编译 node-pty 时对齐 ABI 148 |

## 注入的原生绑定（`scripts/05-inject-native-bindings.mjs`）

| 组件 | 版本 | 来源 | 注入目标 |
| --- | --- | --- | --- |
| `rolldown`（JS 层覆盖） | 1.0.3 | npm 官方 | `node_modules/rolldown/dist` + `package.json` |
| `@rolldown-loong64/binding-linux-loong64-gnu` | 1.0.3 | 龙芯社区 fork，npmmirror | `rolldown/dist/shared/*.node` |
| `@loong64/lightningcss-linux-loong64-gnu` | 1.33.0 | 龙芯社区 fork，npmmirror | `lightningcss/*.node` |
| `@tailwindcss/oxide-linux-loong64-gnu` | **4.2.2** | 龙芯官方源 `registry.loongnix.cn:5873` | `@tailwindcss/oxide/*.node` |
| `@napi-rs/canvas-linux-loong64-gnu` | **0.1.100** | 龙芯官方源 `registry.loongnix.cn:5873` | `@napi-rs/canvas/skia.linux-loong64-gnu.node` |
| `@tailwindcss/oxide-wasm32-wasi` | 4.2.2 | npm 官方 | 兜底包（有原生 `.node` 时不加载） |

oxide / canvas 与 `pnpm-lock.yaml` 精确对齐，无需升级依赖。canvas 官方包漏声明 `libstdc++.so.6`，脚本用 `patchelf --add-needed` 补一条 `DT_NEEDED`，只改动态依赖表。`--all` 另可注入 3 项 EXPERIMENTAL 社区绑定（`@oxc-parser/binding`、`@oxlint/binding`、`@oxfmt/binding` loong64 变体），默认不启用、不在已验证链路内。

## node-pty（`scripts/06-build-loong64-node-pty.sh`）

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| `@lydell/node-pty-linux-loong64` | 1.2.0-beta.10 | 龙芯官方源（lydell/node-pty 的 loong64 构建） |

仅官方包不可用时才走本地源码编译（node-gyp + Electron 43 headers），并用 `patchelf --remove-needed libnode.so.115` 去掉 Debian node-gyp 强加的依赖；**本地编译产物不应二次分发**。

## 上游与运行时

- **ZCode v4.0.0**（`acdcGGE/ZCode`）：Apache-2.0，本移植层不改版权与声明；源码改动以 `patches/zcode-loong64.patch` 提供，可 `git apply -R` 回退。早期版本见 `report/PORTING-REPORT.md`。
- `esbuild` / `rollup` 的 loong64 平台包、koffi 2.15.6 自带的 `linux_loong64/koffi.node`、`@img/sharp` 等由 pnpm 按 lockfile 正常安装，非手工注入。

## 分发检查清单

1. 保留本文件与各上游项目的 LICENSE / NOTICE。
2. `downloads/`、`opt/` 是本地缓存，不在仓库内；接收方用 `scripts/00-fetch-runtime.sh` 自行获取。
3. `dist/linux-loong64-unpacked/`（约 805 MB）含 Electron 运行时、app.asar 与 glm agent 资源，再分发需单独核对 Electron、Chromium 及各 `.node` 的许可。
4. `scripts/10` 产出的 `.deb` / `.pkg.tar.zst`（约 213 MiB / 个）是 unpacked 目录的原样副本，不额外引入二进制；control / `.PKGINFO` 已标注「community loong64 port; not an official upstream release」。分发时随包保留本文件。
