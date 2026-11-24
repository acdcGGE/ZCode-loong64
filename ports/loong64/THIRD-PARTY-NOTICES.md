# 第三方组件与二进制来源

本移植层本身只包含脚本、补丁与文档。为了让 ZCode 在 LoongArch64 上运行，
构建过程中会下载并注入以下第三方组件。**它们不随本仓库分发**，均由脚本在
本地按需获取；这里记录包名、精确版本与来源，便于审计与二次分发时补齐许可声明。

各组件的许可证以**其 npm 包内 `LICENSE` 文件 / `package.json` 的 `license` 字段**为准。
本文件不代替各项目的许可文本；如需再分发二进制，请逐项附上对应 NOTICE。

## 工具链（`scripts/00-fetch-runtime.sh`）

| 组件 | 版本 | 来源 | 用途 |
| --- | --- | --- | --- |
| Node.js loong64 | 24.14.0 | `loong64/node` glibc 构建 | 宿主 Node（系统自带 20.15.1 不满足 ZCode 的 24+ 要求） |
| pnpm | 10.33.2 | npm 官方包 | workspace 依赖管理 |
| Electron loong64 | 43.7.7 | `darkyzhou/electron-loong64` 预编译二进制（及对应 headers） | 桌面运行时；上游锁 44.7.0，龙芯暂无 44 构建 |
| Electron headers | 43.7.7 | 同上 | node-gyp 编译 node-pty 时对齐 ABI 148 |

## 注入的原生绑定（`scripts/05-inject-native-bindings.mjs`）

| 组件 | 版本 | 来源 | 注入目标 |
| --- | --- | --- | --- |
| `rolldown`（JS 层覆盖） | 1.0.3 | npm 官方 | `node_modules/rolldown/dist` + `package.json` |
| `@rolldown-loong64/binding-linux-loong64-gnu` | 1.0.3 | 龙芯社区 fork，npmmirror | `rolldown/dist/shared/*.node` |
| `@loong64/lightningcss-linux-loong64-gnu` | 1.33.0 | 龙芯社区 fork，npmmirror | `lightningcss/*.node` |
| `@tailwindcss/oxide-linux-loong64-gnu` | **4.2.2** | 龙芯官方源 `registry.loongnix.cn:5873` | `@tailwindcss/oxide/*.node` |
| `@napi-rs/canvas-linux-loong64-gnu` | **0.1.100** | 龙芯官方源 `registry.loongnix.cn:5873` | `@napi-rs/canvas/skia.linux-loong64-gnu.node` |
| `@tailwindcss/oxide-wasm32-wasi` | 4.2.2 | npm 官方 | 兜底包（有原生 `.node` 时不会被加载） |

后两项与 `pnpm-lock.yaml` 锁定的版本**精确对齐**，不需要升级依赖。
canvas 官方包漏声明 `libstdc++.so.6`：脚本用 `patchelf --add-needed` 补一条
`DT_NEEDED` 记录，只改动态依赖表，不改动代码段。

`--all` 另外可注入 3 项 EXPERIMENTAL 社区绑定（`@oxc-parser/binding`、
`@oxlint/binding`、`@oxfmt/binding` 的 loong64 变体），默认不启用，也不在
已验证链路内。

## node-pty（`scripts/06-build-loong64-node-pty.sh`）

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| `@lydell/node-pty-linux-loong64` | 1.2.0-beta.10 | 龙芯官方源（lydell/node-pty 的 loong64 构建） |

仅在官方包不可用时才走本地源码编译（node-gyp + Electron 43 headers），
并用 `patchelf --remove-needed libnode.so.115` 去掉 Debian node-gyp 强加的依赖。
**本地编译产物不应二次分发**，请用官方包路径。

## 上游与运行时

- **ZCode v3.18.0**（`acdcGGE/ZCode`）：Apache-2.0。本移植层不改其版权与声明，
  全部源码改动以 `patches/zcode-loong64.patch` 的形式提供，可 `git apply -R` 回退。
- `esbuild` / `rollup` 的 loong64 平台包、koffi 2.15.6 自带的
  `linux_loong64/koffi.node`、`@img/sharp` 等：由 pnpm 按 lockfile 正常安装，
  非手工注入。

## 分发检查清单

1. 保留本文件与各上游项目的 LICENSE / NOTICE。
2. `downloads/`、`opt/` 属于本地缓存，不在本仓库内；接收方用
   `scripts/00-fetch-runtime.sh` 自行获取。
3. 最终 `dist/linux-loong64-unpacked/`（约 805 MB）含 Electron 运行时、
   app.asar 与 glm agent 资源，再分发时需单独核对 Electron、Chromium 及各
   `.node` 的许可与声明。
4. `scripts/10-package-linux.mjs` 产出的 `.deb` / `.pkg.tar.zst` 是上述 unpacked
   目录的**原样副本**（约 212 MiB / 个，zstd 压缩），不额外引入第三方二进制；
   control / `.PKGINFO` 的 `Description` 与 `pkgdesc` 已标注
   「community loong64 port; not an official upstream release」。分发安装包时
   同样适用第 1、3 条，并随包保留本文件。
