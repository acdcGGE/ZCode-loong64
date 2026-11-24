# ZCode → linux-loong64 移植实测报告

**日期**：2026-11-11（补充 11-12、11-20）· **机器**：Deepin 25 / Loongson-3A5000 LA464 / glibc 2.38 / 15 GiB RAM
**上游**：acdcGGE/ZCode（基于 `loong64-3.18.0-preview`，11-20 合入上游后为 3.18.2）

> 本报告记录 3.18.x 时期的首次移植过程与踩坑。v4.0.0 重建结果见 `../README.md` 与 `DEPENDENCY-AUDIT.json`。

## 一、结论

移植全链路端到端跑通（含真实桌面启动），不是"改个版本就能跑"：

- 龙芯工具链、30 条源码适配补丁（14 文件）、整棵 workspace 依赖安装完成；
- `pnpm run build:bootstrap` 全量构建 **exit 0**（5m50s，21 个产物）；
- 6 项原生绑定注入（含 2 项龙芯官方原生包），node-pty 用龙芯官方包；
- `bundle:desktop --os linux --arch loong64` 完整打包：electron-builder 26.15.6 packaging + afterPack 全断言通过，产物 `dist/linux-loong64-unpacked/`（约 805 MB，`--dir`，含 382 MB app.asar）；
- Deepin 图形会话**真实启动**：主进程无异常、窗口渲染完成、host 子进程与 RPC 正常、退出码 0（截图 `report/zcode-loong64-launch.png`）；
- 本机工具构造的标准 `.deb` / `.pkg.tar.zst`（各约 212 MiB）按 `/usr/bin` → `/opt/zcode-preview` 安装布局**再次启动成功**（5/5 PASS，GPU FATAL 0 次），22 项包自检全过。

**解法分层**：构建期注入社区二进制 + JS 层对齐；打包期逐条补平台映射 + 官方源直取 + 本地编译兜底；运行期 API 面差审计 + 43/44 双路径兼容；安装包绕开 electron-builder 的 x86_64 fpm 走本机工具。

**唯一保留降级项**：keyring（回退文件凭据，上游 `systemCredentialCipher` 本就有该设计）。证据见 `report/*.log` 与 `report/*.json`。

## 二、环境与前置核查

| 检查 | 结果 |
| --- | --- |
| CPU / ISA | `Loongson-3A5000 LA464`，Features 含 `lsx lasx`；编译并运行 LSX 指令通过 |
| glibc | 2.38，满足 electron-loong64 `>= 2.38` |
| 系统 Node | 20.15.1，不满足 ZCode `node >= 24` |
| Node 24.14.0 来源 | nodejs.org 无 loong64 包、Deepin 源只有 20；改用 `loong64/node` v24.14.0，`sha256sum -c` 通过 |
| Electron 44.7.0 | 官方 GitHub / npmmirror 的 `linux-loong64.zip` 均 404；electron-loong64 最高 v43.7.7 |
| 自编译 Electron 44 | 需 32 GiB RAM + 200 GiB 磁盘，本机 15 / 56 GiB，不具备 |
| 下载通道 | GitHub 单连接 40~104 KB/s；`aria2c -x12` + 三镜像，Node 30 MB 用 64 秒（约 490 KB/s） |
| 本地 C++ 工具链 | gcc/g++ 12.3.0、node-gyp 9.3.0、make、python3、patchelf、readelf 可用 |

## 三、关键决策

1. **Electron 44.7.0 → 43.7.7**：用 `darkyzhou/electron-loong64` v43.7.7 预编译包（ZIP SHA256 与 release `SHASUMS256.txt` 一致）。`ELECTRON_RUN_AS_NODE=1` 实跑得 `electron 43.7.7 / node 24.21.0 / arch loong64 / ABI 148`；宿主 Node 24.14.0 的 ABI 是 137 —— Electron 内原生模块必须按 43 headers 重编译。
2. **electron-builder 用 `@loongdotjs/*` 26.15.6 三件套 override**（上游 26.17.0 不认 loong64），按 26.15.6 的 `scheme.json` 全量静态比对。
3. **架构白名单**：`pnpm-workspace.yaml`、`target-platform.mjs`、`bundle.mjs`、`native-search-tools-config.mjs`、`stage-credential-keyring.mjs`、`desktop-native-package-policy.mjs`、`electron-builder.config.js` 等 14 文件、30 条补丁，diff 在 `patches/zcode-loong64.patch`（可 `git apply -R`）。
4. **Rust 原生绑定**：上游 JS 层大多已写好 `loong64` 分支，只是 npm 没发 `.node`；不改 JS / lockfile，按上游 `require()` 的文件名注入社区 fork 的 `.node`。
5. **node-pty 用龙芯官方包**：`@lydell/node-pty-linux-loong64@1.2.0-beta.10` 与 optionalDependencies 精确匹配，DT_NEEDED 仅 libstdc++/libm/libgcc_s/libc/ld-linux，Electron 43 / Node 24 双环境加载通过；本地编译为 fallback。
6. **keyring 运行时降级**：上游与龙芯源均无 `@napi-rs/keyring-linux-loong64-gnu`；`systemCredentialCipher.ts:162` 对加载失败本就有 catch + `unavailable()` → 文件凭据回退，故 stage 对 loong64 跳过原生包，其余平台维持缺包即失败。
7. **安装包与 electron-builder 解耦**：`linux.target=["dir"]`，deb / pacman 由 `scripts/10` 用本机 loong64 工具从 unpacked 构造，避免 fpm / AppImage 的 x86_64 二进制与在线下载；Depends 由 `DT_NEEDED` 反查过滤。

## 四、实测结果

| 环节 | 结果 |
| --- | --- |
| `pnpm install --ignore-scripts --no-frozen-lockfile` | **exit 0**：2491 resolved / 2273 downloaded / 2692 added，3m42s，无平台解析报错 |
| `04-verify.sh` 体检 | **18 PASS / 0 FAIL**（Node / pnpm / Electron / 平台键 / bundle target / 版本对齐 / esbuild / 注入链 / node-pty / canvas+oxide / electron 导入 / 安装包 4 项） |
| esbuild 0.25.12 | `transformSync('const a=1')` 正常，`@esbuild/linux-loong64` 落地 |
| `@zcode/formal-proof` | vite build exit 0，572 modules，336ms |
| `@zcode/web-share` | vite build exit 0，6308 modules，28.08s，产出 5.8 MB JS |
| `build:bootstrap` 全量 | exit 0，5m50s，21 个产物（desktop 生产构建 1m35s） |
| node-pty（官方包） | LoongArch ELF，Electron 43 / Node 24 双环境 `require` 成功（`fork,open,resize,process`） |
| `bundle:desktop --skip-build` | 完整链路：prepare → packaging → afterPack 全断言 → 依赖审计，约 805 MB |
| afterPack 断言 | node-pty / CUA sharp / koffi / helper / mac locales 全过；sourcemap 清理 5498 处引用 / 5474 文件 |
| **运行期实跑** | 成功：主进程无未捕获异常、窗口渲染完成、host 子进程拉起并完成 RPC、窗口尺寸持久化 |
| `09-smoke-launch.sh` | **5/5 PASS**：无异常 / 主窗口 / 渲染无加载失败 / host 子进程 / 观察期存活 |
| 退出路径 | 修复后退出码 **0**、GPU FATAL **0 次**（修复前 132 / 1 次） |
| `08` API 审计 | 8281 源文件 / 57 个 electron 具名导入，与 43.7.7 `electron.d.ts` 比对无缺失 |
| `10` 构造安装包 | exit 0，deb 222477412 B（`e9cfa113…`）、pkg.tar.zst 222239331 B（`fa96b4cc…`），**22 PASS / 0 FAIL** |
| **deb 解包安装布局实跑** | **5/5 PASS**，GPU FATAL 0 次（截图 `report/zcode-loong64-installed-deb.png`） |

## 五、失败点与修复

### 构建期

- `pnpm-workspace.yaml` 重复 mapping key → 删重复 `koffi: true`，补丁器改幂等 + `--check`。
- 缺 `@rolldown/binding-linux-loong64-gnu` → 注入 `@rolldown-loong64`；社区 1.2.8 与 rolldown 1.0.0-rc.15 的 `onLog` 回调不兼容 → 换 1.0.3；6308 模块大构建仍报 `ThreadsafeFunction<BindingLog>` → JS 层也对齐官方 1.0.3。
- 缺 lightningcss / tailwind oxide 的 loong64 `.node` → 分别注入 `@loong64/lightningcss-linux-loong64-gnu` 1.33.0、oxide 官方原生 4.2.2（曾试 WASI 兜底，后弃用）。

### 打包期

- 平台白名单散落多个脚本、逐个试错每轮 6–11 分钟 → 先一次源码扫描列出所有含 `x64/arm64` 白名单的脚本，再一次性补齐。
- `native-search-tools-config.mjs` 不认 loong64 → 补架构识别，走 `enabled=false` 安全降级（0 tools）。
- `Unsupported keyring platform: linux-loong64` → 正则补 loong64，并补 `desktop-native-package-policy.mjs` 的 `SUPPORTED_DESKTOP_PLATFORM_KEYS` / `SHARP_VARIANTS_BY_PLATFORM`。
- `unknown property 'allowMissingDependencies'`（26.17.0 新字段）→ 静态比对确认仅此一处，删声明（26.15.6 默认语义相同）。
- packaging 静默挂起 6+ 分钟 → electron-builder 重下 139 MB zip 且不认 `ELECTRON_OVERRIDE_DIST_PATH`；用 `ZCODE_ELECTRON_DIST` 注入 `electronDist` 指向本地已校验 zip，零下载。
- `linux.target` 尾声仍需下载 x86_64 AppImage/fpm → 改 `["dir"]`。
- 后置审计写死平台目录 / 产物形态 → 补 loong64 分支，`--dir` 跳过体积审计。
- `missing staged koffi runtime` 并非缺二进制：koffi 2.15.6 自带 `build/koffi/linux_loong64/koffi.node`，是 `--skip-prepare` 跳过了 stage。

### 运行期

- **启动即崩**：`SyntaxError: 'electron' does not provide an export named 'ClipboardItem'`。上游锁 44.7.0、代码用 44 才有的符号，而 loong64 只有 43.7.7；ESM 具名导入在链接期校验导出表，缺符号直接终止主进程。`scripts/08` 逐条比对 8281 文件 / 57 具名导入，确认只此一个 → 不整体降级 API，改运行时探测（有 `ClipboardItem` 走异步 `write`，否则回落同步 `writeImage`）。
- **退出 SIGILL（132）**：关窗后 Chromium 重启 GPU 进程，loong64 必败（`error_code=1002`），累积到上限后 `FATAL: GPU process isn't usable. Goodbye.`；LoongArch 用 trap 指令实现崩溃 → SIGILL。加 loong64 专用 `--disable-gpu-process-crash-limit` 后 132 → 0、FATAL 归零。

### 补充修正（11-12）

- **canvas / oxide「版本不匹配」是误判**：只看 `dist-tags.latest` 没看完整 `versions`。canvas 源上 20 版含 `0.1.100`、oxide 11 版含 `4.2.2`，均与 lockfile 精确对齐 → 直取官方原生包，零源码 / 零 lockfile 改动，WASM 降为兜底。
- **canvas 漏声明依赖**：`.node` 的 DT_NEEDED 无 `libstdc++` 但 Skia 用 C++ RTTI；host Node 自带该库故 `node -e` 假阳性通过，Electron 下报 `undefined symbol: _ZTVN10__cxxabiv117__class_type_infoE`。用 `patchelf --add-needed libstdc++.so.6`（幂等）补齐，`04-verify.sh` 增加 Electron 43 功能验证（真实绘 PNG + Scanner 加载）。
- **canvas 不进 app.asar 是上游有意设计**：`findDesktopNativePackageViolations` 对 `@napi-rs/canvas*` 是 fail-closed 断言，pdf 插件自带 `Matrix2D` 顶替 DOMMatrix。

### 重新安装复现（11-20）

- **`packages/desktop postinstall` exit 1**：链路 `node-pty-rebuild.mjs → ensureElectronRuntime()` 只认 `node_modules/electron/path.txt` + dist，否则跑 `install.js` 从 GitHub 下 139 MB，弱网 `TypeError: terminated`；`ELECTRON_OVERRIDE_DIST_PATH` 只被 electron-builder 认。修复：第 30 条补丁 `postinstall-electron-local-dist` 给 `installRuntime()` 加本地 dist 快路径（override 目录存在就硬链 dist + 写 `path.txt`），零下载。
- **`cpu-features` 编译失败非致命**：ssh2 的 optionalDependencies，loong64 buildcheck 只编 `hwcaps.c` 但 `binding.cc` 无条件 `using namespace cpu_features` → gyp 失败，pnpm 忽略可选依赖失败。
- **龙芯官方 node-pty 包被重编，GLIBC 升到 2.42**：同版本号 `1.2.0-beta.10` 的 tgz，11-11 可加载（BuildID `0d71dd…`），11-20 变成要求 `GLIBC_2.42`（BuildID `7e5c6a…`），本机 2.38 失败。`verify_pty()` 用 `die` 会绕过 `fetch_official || build_from_source` 降级 → 改为 `return 1` 并在调用点检查，官方包不兼容时自动本地编译。
- **pnpm install 剪除手工注入绑定**：每次 `02-install.sh` 后必须重跑 `05`（6 项）和 `06`（node-pty），否则 `04-verify.sh` 报缺失，顺序见 `reproduce.sh`。

### 安装包三坑

1. `dpkg -S` 反查 `DT_NEEDED` 误命中 `gcc-14.4.0` / `noctalia` / `liblol` → 系统库白名单 + 基线运行库 + `-dev`/Essential 过滤，收敛到 26 项。
2. 绝对路径软链解包到临时根后指向宿主机 `/opt` → 改 `../../opt/...` 相对链。
3. pacman 需 `.PKGINFO` 为首个条目且带 `.MTREE`/`.BUILDINFO` → `bsdtar --format=mtree` + zstd 手工生成。

### node-pty 两条路径（官方优先）

1. **官方包（默认）**：落地 `lib/ + package.json + prebuilds`，`require.resolve` 与 beforePack 直接通过。
2. **本地编译（`--from-source`）**：`node-gyp rebuild --nodedir=~/.cache/electron/node-v43.7.7-headers --arch=loong64`，6 秒出 LoongArch ELF（N-API）。坑：Debian node-gyp 自动加 `-lnode`，产物 NEEDED `libnode.so.115`，Electron 43 下 `require` SIGSEGV 139；`patchelf --remove-needed libnode.so.115` 后由 Electron 自导出 `napi_*` 符号满足加载。

**三条经验**：① 只补 `.node` 不够，JS 与 binding 版本必须成套（小包 572 模块能过，大包 6308 模块才暴露回调差异）；② 打包成功 ≠ 能启动，冒烟须覆盖「启动 + 存活 + 退出码」三段；③ 判断原生包版本必须查完整 `versions` 列表，只看 `dist-tags.latest` 会误判。

## 六、当前原生模块覆盖

| 模块 | 状态 | 方案 |
| --- | --- | --- |
| esbuild / rollup | ✅ 上游自带 | 直接安装 |
| rolldown | ✅ 已注入 | JS 对齐 1.0.3 + `@rolldown-loong64` binding 1.0.3 |
| lightningcss | ✅ 已注入 | `@loong64/lightningcss-linux-loong64-gnu` 1.33.0 |
| tailwind oxide | ✅ 官方原生 | `@tailwindcss/oxide-linux-loong64-gnu` 4.2.2（与 lock 精确对齐），WASM 仅兜底 |
| node-pty | ✅ 官方包 | `@lydell/node-pty-linux-loong64` 1.2.0-beta.10，本地编译兜底 |
| koffi | ✅ 无需移植 | 2.15.6 自带 `linux_loong64/koffi.node` |
| opentui-core | ✅ 纯 JS | 无 `.node`，此前标记 BLOCKED 有误 |
| oxc-parser / resolver / oxlint / oxfmt | 🟡 社区有包 | `--all` 注入，标 EXPERIMENTAL |
| sharp | 🟡 官方源有包 | `@img/sharp-linux-loong64` 0.35.5 + libvips 1.3.4 |
| @napi-rs/canvas | ✅ 官方原生 | 0.1.100 + patchelf 补 libstdc++；桌面产物按上游设计裁掉 |
| @napi-rs/keyring | 🟡 运行时降级 | 无 loong64 包，回退文件凭据；需 OS 密钥环时源码编译 |

**龙芯官方源直取复核**：canvas lock 0.1.100 / 源上 latest 1.1.0 / 实取 **0.1.100**（20 版）；oxide lock 4.2.2 / latest 4.3.5 / 实取 **4.2.2**（11 版 4.1.11–4.3.5）。上游 JS 层（`js-binding.js:284`、`index.js:366`）本就写好 loong64 分支，缺的只是 `.node`。

## 七、剩余工作

1. **凭据降级功能确认**：确认 keyring 回退文件凭据在产品上可接受；否则从 Rust 源码编译（rustc/cargo 1.87 可用）。唯一保留降级项。
2. **原生搜索工具**：`enabled=false` 降级，龙芯包不带 ripgrep/ugrep；需验证「用户版本优先、缺失回退系统 rg」路径。
3. **electron-builder 版本差**：26.15.6 与上游 26.17.0 的其它差异已随出包覆盖大部分，升级后复查。
4. **许可与再分发**：保留 NOTICE / 第三方声明，control 已标注非官方发布。

已完成项：桌面启动验证、Electron 43/44 API 回归（仅 `ClipboardItem` 一个符号差）、canvas / 原生 oxide 补齐（无需升级依赖）、安装包形态（不依赖 loongdeb / fpm / AppImage）。

观察到但未处理（与移植无关）：host 握手一条 zod 判别消息 warn 后丢弃（RPC 正常）；Preview 后端 `client-config: HTTP 400`；Chromium `base::CPU` 不识别 LoongArch 型号（仅影响上报）。

## 八、产物清单

- `scripts/00-fetch-runtime.sh` — 运行时下载 / 校验 / 安装（多镜像 + aria2）
- `scripts/01-apply-port.mjs` — 30 条幂等补丁
- `scripts/02-install.sh`、`03-build.sh`、`04-verify.sh` — 安装 / 分阶段构建 / 体检
- `scripts/05-inject-native-bindings.mjs` — 6 项已验证注入（+ 3 项 EXPERIMENTAL）
- `scripts/06-build-loong64-node-pty.sh` — node-pty 官方包 / 本地编译 + patchelf + 加载验证
- `scripts/08-audit-electron-api.mjs` — electron 具名导入 API 面差审计
- `scripts/09-smoke-launch.sh` — 运行期冒烟（启动 / 存活 / 退出码 + 截图）
- `scripts/10-package-linux.mjs` — deb / pacman 构造 + 22 项自检 + `--check` 幂等复验
- `reproduce.sh` — 11 阶段一键复现
- `patches/zcode-loong64.patch` — 完整 diff（14 文件 / 364 行，可回退）
- `report/porting-matrix.json`、`report/linux-packages.json` — 结构化矩阵与包信息
- `report/zcode-loong64-launch.png`、`report/zcode-loong64-installed-deb.png` — 启动截图
- `report/*.json` 入库；`report/*.log`、`report/*.png` 仅本地留档
- `packages/desktop/dist/linux-loong64-unpacked/` — 最终产物（约 805 MB）
- `packages/desktop/dist/zcode-preview_3.18.2_loong64.deb`、`zcode-preview-3.18.2-1-loong64.pkg.tar.zst` — 3.18.2 安装包（约 212 MiB）；v4.0.0 产物名见 `../README.md`

> 安装包超 GitHub 单文件 100 MB 限制，不进 git；`report/linux-packages.json` 记录体积与 SHA256 供校验。
