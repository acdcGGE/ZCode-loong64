# ZCode → linux-loong64 移植层

把 [acdcGGE/ZCode](https://github.com/acdcGGE/ZCode)（AI 编程工作台，Electron + pnpm monorepo）移植到龙芯 LoongArch64 / Deepin 25。目标形态是完整桌面版，Electron 采用 [darkyzhou/electron-loong64](https://github.com/darkyzhou/electron-loong64) 预编译二进制。

本目录是独立移植层（随 `feat/loong64-port` 分支发布），源码改动全部由脚本生成、幂等可审计，不往上游代码堆手工修改。两种布局都支持：仓库内 `<repo>/ports/loong64/` 或独立目录（与 `ZCode/` 同级），`scripts/_layout.*` 自动探测，`ZCODE_ROOT=/path` 可覆盖。

## 构建记录

- **v4.0.0（2026-11-24）**：基线 main `a4b4445` / 移植层 `4efef90`，30 条补丁零冲突；体检 18/18、包检查 22/22、启动冒烟 5/5；产物两个约 213 MiB 安装包走 Release `loong64-4.0.0-preview`，node-pty 降级源码编译并验证通过。
- **早期版本**：v3.18.x 的完整实测与踩坑见 `report/PORTING-REPORT.md`，第三方来源见 `THIRD-PARTY-NOTICES.md`，依赖来源审查见 `report/DEPENDENCY-AUDIT.json`。

当前状态：全量构建通过，`bundle:desktop --os linux --arch loong64` 端到端跑通，产物 `dist/linux-loong64-unpacked/`（约 805 MB，`--dir` 形态，含 382 MB app.asar）；Deepin 图形会话真实启动（主进程无异常、窗口渲染完成、host 子进程与 RPC 正常、退出码 0）；`scripts/10` 构造的 `.deb` / `.pkg.tar.zst` 按安装布局再次启动成功。

## 实测环境

Loongson-3A5000 LA464 / Deepin 25 / 内核 6.18.48-loong64 · CPU `lsx lasx`（Electron loong64 硬性要求）· glibc 2.38 · 15 GiB RAM、56 GiB 可用磁盘 · 宿主 Node 20.15.1（不足，要求 24+）· gcc 12.3.0、node-gyp 9.3.0、python3、patchelf、make。

## 关键技术决策

1. **Node 24.14.0**：nodejs.org 无 loong64 包、Deepin 源只有 20，改用 `loong64/node` 的 v24.14.0 glibc 构建（SHA256 校验通过）。
2. **Electron 43.7.7**：上游锁 44.7.0，但 electron-loong64 最高 v43.7.7；自编译 44 需 32 GiB RAM + 200 GiB 磁盘，机器不具备。实跑 `electron 43.7.7 / node 24.21.0 / ABI 148`。
3. **`@loongdotjs/electron-builder` 26.15.6**：pnpm overrides 同时替换 electron-builder / app-builder-lib / builder-util；该分支比上游旧，`allowMissingDependencies` 等新配置项不被 schema 接受，已静态比对后适配。
4. **架构白名单**：`pnpm-workspace.yaml` 的 `supportedArchitectures.cpu` 加 loong64，`target-platform.mjs` / `bundle.mjs` 加 loong64 分支与 `--loong64` 参数；共 30 条补丁。
5. **JS 与 binding 必须成套对齐**：上游 JS 层多数已写好 loong64 分支、只缺 `.node`。rolldown 1.0.0-rc.15 配社区 1.2.8 能加载但 `onLog` 回调不兼容，JS 层也对齐到官方 1.0.3 才全程通过。
6. **龙芯官方源优先，不降级**：`registry.loongnix.cn:5873` 覆盖 node-pty / canvas / sharp / tailwind oxide / rolldown / lightningcss / esbuild 的 loong64 包，缺 keyring 与 oxlint。**判定可用性必须查完整 `versions` 列表，不能只看 `dist-tags.latest`**。canvas 官方包漏声明 `libstdc++`，脚本用 `patchelf --add-needed` 补齐。
7. **node-pty 官方包优先**：`@lydell/node-pty-linux-loong64@1.2.0-beta.10` 与 optionalDependencies 精确匹配、无 libnode 依赖，Electron 43 / Node 24 双环境加载通过；下载失败才降级源码编译（需 `patchelf` 去掉 Debian node-gyp 强加的 `libnode.so.115`，否则 Electron 下 SIGSEGV）。
8. **Electron zip 本地直供**：@electron/get 走官方 CDN 拉龙芯 zip 会静默挂起数分钟；`ZCODE_ELECTRON_DIST` 指向 `00-fetch-runtime.sh` 已校验的本地 zip，走 `electronDist` 快路径、零下载。
9. **产物形态用 `--dir`**：AppImage 工具链是 x86_64 二进制、fpm 需在线下载，龙芯上不可用 → `linux.target=["dir"]`，交付 unpacked 目录。
10. **安装包不用 electron-builder**：26.x 的 deb/pacman target 走 fpm（x86_64 AppImage），改由 `scripts/10` 用本机 `dpkg-deb 1.22.6 -Zzstd`、`bsdtar`、`zstd 1.5.7` 把 unpacked 目录装进标准布局：`/opt/<pkg>/` + 相对软链 `/usr/bin/<exe>` + 图标 + `.desktop` + copyright。Depends 由 `readelf -d` 取 `DT_NEEDED` 再 `dpkg -S` 反查、白名单过滤；`chrome-sandbox` 保持 `4755 root:root`；pacman 补 `.PKGINFO`/`.MTREE`/`.BUILDINFO`，22 项自检。
11. **Electron 43 缺 `ClipboardItem`**：上游用 44 的异步 `clipboard.write([new ClipboardItem])`，ESM 具名导入在链接期校验导出表，43 上直接 `SyntaxError` 带走主进程。全仓 8281 源文件、57 处 `electron` 具名导入逐条比对后只缺这一个符号，故只给剪贴板写入加运行时探测（有 `ClipboardItem` 走异步 `write`，否则回落同步 `writeImage`），审计固化为 `scripts/08`。
12. **退出 SIGILL（132）**：关窗后 Chromium 重启 GPU 进程，loong64 上必败（`error_code=1002`），到上限后 FATAL，LoongArch 用 trap 实现"立即崩溃"故为 SIGILL。加 loong64 专用 `--disable-gpu-process-crash-limit` 后退出码归 0。
13. **其余降级**：keyring 走上游已有的 catch + 文件凭据加密回退；`koffi 2.15.6` 自带 `linux_loong64/koffi.node`，无需移植；`linux-loong64` 不在 ripgrep/ugrep 发布白名单，补架构识别后 `enabled=false` 跳过资源准备。

## 复现

`./reproduce.sh` 串行跑 11 个阶段，任一失败即中止；`--dry-run` 预览、`--from=<阶段>` 断点续跑、`--skip-smoke`（无图形会话）、`--skip-packages`（缺 `dpkg-deb`/`bsdtar`）。手工执行：

```bash
cd zcode-loong64-port
git clone --depth 1 -b feat/loong64-port https://github.com/acdcGGE/ZCode.git ../ZCode  # 仅独立布局需要；检测到 .git 会跳过
./scripts/00-fetch-runtime.sh                       # Node 24.14.0 / pnpm 10.33.2 / Electron 43.7.7 + headers
node scripts/01-apply-port.mjs --check && node scripts/01-apply-port.mjs   # 30 条补丁，幂等
./scripts/02-install.sh --no-scripts && ./scripts/02-install.sh
node scripts/05-inject-native-bindings.mjs --check && node scripts/05-inject-native-bindings.mjs  # 6 项绑定
./scripts/06-build-loong64-node-pty.sh              # 官方包优先，--from-source 强制本地编译
./scripts/04-verify.sh                              # 体检，出包后为 18/18
./scripts/03-build.sh build
export ZCODE_ELECTRON_DIST="$PWD/downloads/electron-v43.7.7-linux-loong64.zip"
./scripts/03-build.sh bundle
node scripts/10-package-linux.mjs                   # deb / pacman，--check 幂等复验
./scripts/09-smoke-launch.sh                        # ZCODE_SMOKE_APP 可改测安装后布局
```

`01` / `05` 另支持 `--zcode=/path`。

## 目录

| 路径 | 内容 |
|---|---|
| `reproduce.sh` | 一键复现 11 阶段（`--dry-run` / `--from=` / `--skip-smoke` / `--skip-packages`） |
| `scripts/00-fetch-runtime.sh` | 多镜像多连接下载运行时，SHA256 / tar 校验，就地解压 |
| `scripts/01-apply-port.mjs` | 30 条幂等源码补丁，`--check` 预检 |
| `scripts/02-install.sh` | 带完整环境变量的 pnpm install |
| `scripts/03-build.sh` | bootstrap / build / bundle 分阶段构建，逐阶段留日志 |
| `scripts/04-verify.sh` | 移植体检 18 项，输出 `report/verify.json` |
| `scripts/05-inject-native-bindings.mjs` | 6 项原生绑定注入（`--check` / `--all`，canvas 自动 patchelf） |
| `scripts/06-build-loong64-node-pty.sh` | node-pty 官方包 / 本地编译 + Electron 加载验证 |
| `scripts/08-audit-electron-api.mjs` | 核对源码里 `electron` 具名导入的值在目标版本是否存在 |
| `scripts/09-smoke-launch.sh` | 真实启动产物，断言主进程 / 主窗口 / 渲染 / host 子进程 |
| `scripts/10-package-linux.mjs` | 本机 `dpkg-deb` + `bsdtar`/`zstd` 构造 `.deb` / `.pkg.tar.zst` |
| `patches/zcode-loong64.patch` | 上游改动完整 diff（14 文件 / 364 行，可 `git apply -R` 回退） |
| `report/*` | 结构化 JSON、报告与各阶段日志 / 截图 |
| `THIRD-PARTY-NOTICES.md` | 第三方二进制来源、版本与许可核对 |

## 发布与获取

随 `acdcGGE/ZCode` 的 `feat/loong64-port` 分支发布（仓库根已应用 30 条补丁）；**不向上游 `zai-org/ZCode` 提 PR，也不改 `main`**。

```bash
git clone -b feat/loong64-port https://github.com/acdcGGE/ZCode.git ZCode
cd ZCode/ports/loong64 && ./reproduce.sh --dry-run
```

- 补丁可用 `git apply` / `-R` 单独审计或回退，脚本幂等不叠加。
- `.gitignore` 排除 `downloads/`、`opt/`（约 600 MB 工具链）、`build/`、日志与截图，入库增量约 280 KB。
- 安装包各约 213 MiB，超 GitHub 100 MB 限制，不进 git；v4.0.0 产物走 Release `loong64-4.0.0-preview`（含 `SHA256SUMS-v4.0.0.txt`）。

## 许可与合规

上游 ZCode Apache-2.0；electron-loong64 与 Node.js MIT；社区 binding 各依其原项目许可。本移植层只做适配，不改上游版权与声明；注入的 `.node` 来自公开 npm 包并保留来源包名版本，`patchelf` 仅补一条 `DT_NEEDED`（libstdc++.so.6）。安装包 control / `.PKGINFO` 标注「community loong64 port, not an official upstream release」；再分发须保留 `THIRD-PARTY-NOTICES.md`，`scripts/06` 降级本地编译的 node-pty 产物不应二次分发。
