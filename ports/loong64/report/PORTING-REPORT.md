# ZCode → linux-loong64 移植实测报告

**日期**：2026-11-11（补充：2026-11-12、2026-11-20）
**机器**：Deepin 25 / Loongson-3A5000 LA464 / glibc 2.38 / 15 GiB RAM
**上游**：acdcGGE/ZCode（分支基于 `loong64-3.18.0-preview` tag；11-20 合入上游后源码版本为 3.18.2）

## 一、结论

移植**全链路端到端跑通（含真实桌面启动）**，不是"改个版本就能跑"的移植：

- 龙芯工具链、29 条源码适配补丁（14 个文件）、整棵 workspace 依赖安装完成；
- `pnpm run build:bootstrap` 全量构建 **exit 0**，耗时 5m50s，产出 21 个构建产物；
- 6 项原生绑定注入（含 2 项龙芯官方原生包），node-pty 换用龙芯官方包；
- `bundle:desktop --os linux --arch loong64` 完整打包链路：electron-builder 26.15.6 真实 packaging + afterPack 全部断言通过（node-pty / CUA sharp / CUA koffi / CUA helper），产物为 `dist/linux-loong64-unpacked/`（约 805 MB，`--dir` 形态，含 382 MB app.asar 与 glm agent 资源）；
- **产物在 Deepin 图形会话中真实启动**：主进程无异常、窗口渲染完成（截图 `report/zcode-loong64-launch.png`）、host 子进程与 RPC 正常、退出码 0；
- 用本机原生工具（`dpkg-deb 1.22.6 -Zzstd`、`bsdtar/libarchive 3.7.4` + `zstd 1.5.7`）从同一 unpacked 目录构造出标准 **`.deb` 与 ArchLinux `.pkg.tar.zst`**（各约 212 MiB），22 项内置自检全部通过，解包到临时根、按 `/usr/bin` 软链 → `/opt/zcode-preview` 的真实安装布局**再次启动成功**（5/5 PASS，GPU FATAL 0 次）。

**解法分层**：

| 阶段 | 手段 |
| --- | --- |
| 构建期 | 注入社区二进制 + JS 层对齐 |
| 打包期 | 逐条补平台映射 + 官方源直取 + 本地编译兜底 |
| 运行期 | API 面差审计 + 43/44 双路径兼容 |
| 安装包 | 绕开 electron-builder 的 x86_64 fpm，走本机原生工具 |

**全链路唯一保留的降级项**：keyring（回退文件凭据，上游 `systemCredentialCipher` 本就有该设计）。证据均留在 `report/*.log` 与 `report/*.json`。

## 二、环境与前置核查

| 检查 | 结果 |
| --- | --- |
| CPU / ISA | `Loongson-3A5000 LA464`，Features 含 `lsx lasx`；编译并运行一条 LSX 指令通过 |
| glibc | 2.38，满足 electron-loong64 要求的 `>= 2.38` |
| 系统 Node | 20.15.1，不满足 ZCode 的 `node >= 24` |
| Node 24.14.0 来源 | nodejs.org 无 loong64 包、Deepin 源只有 20；改用 `loong64/node` release v24.14.0，`sha256sum -c` 通过 |
| Electron 44.7.0 | 官方 GitHub / npmmirror 的 `linux-loong64.zip` 均 404；electron-loong64 最高只有 v43.7.7 |
| 自编译 Electron 44 | electron-loong64 README 要求 32 GiB RAM + 200 GiB 磁盘，本机 15 GiB / 56 GiB，不具备 |
| 下载通道 | GitHub 单连接 40~104 KB/s；`aria2c -x12` + 三镜像实测 Node 30 MB 用 64 秒（均值 490 KB/s） |
| 本地 C++ 工具链 | gcc/g++ 12.3.0、node-gyp 9.3.0、make、python3、patchelf、readelf 均可用 |

## 三、关键决策

1. **Electron 降级 44.7.0 → 43.7.7**，用 `darkyzhou/electron-loong64` v43.7.7 预编译包（ZIP SHA256 与 release `SHASUMS256.txt` 一致）。以 `ELECTRON_RUN_AS_NODE=1` 实跑得 `electron 43.7.7 / node 24.21.0 / arch loong64 / ABI 148`。宿主 Node 24.14.0 的 ABI 是 137 —— **所有 Electron 内原生模块必须按 43 的 headers 重编译**。
2. **electron-builder 用 `@loongdotjs/*` 26.15.6 三件套 override**（上游 26.17.0 不认识 loong64），并按 26.15.6 的 `scheme.json` 与配置做全量静态比对。
3. **架构白名单**：`pnpm-workspace.yaml`、`target-platform.mjs`、`bundle.mjs`、`native-search-tools-config.mjs`、`stage-credential-keyring.mjs`、`desktop-native-package-policy.mjs`、`electron-builder.config.js` 等共 14 个文件、29 条补丁，完整 diff 在 `patches/zcode-loong64.patch`（已验证可 `git apply -R` 回退）。
4. **Rust 原生绑定**：上游 JS 层大多已写好 `loong64` 分支，只是 npm 没发对应 `.node`。因此不改 JS、不改 lockfile，直接把社区 fork 的 `.node` 按上游 `require()` 的文件名注入。
5. **node-pty 用龙芯官方包**：`registry.loongnix.cn:5873` 的 `@lydell/node-pty-linux-loong64@1.2.0-beta.10` 与工程 optionalDependencies 精确匹配；官方包 DT_NEEDED 只有 libstdc++/libm/libgcc_s/libc/ld-linux，Electron 43 / Node 24 双环境加载通过。本地源码编译保留为 fallback。
6. **keyring 走运行时降级**：上游与龙芯官方源均无 `@napi-rs/keyring-linux-loong64-gnu`；上游 `systemCredentialCipher`（`packages/shared/src/credential-security/systemCredentialCipher.ts:162`）对 keyring 加载失败本就有 catch + `unavailable()` → 文件凭据回退，因此 stage 对 loong64 跳过原生包，其余平台维持缺包即失败。
7. **安装包与 electron-builder 解耦**：`linux.target` 保持 `["dir"]`，deb / pacman 由移植层 `scripts/10` 用本机 loong64 工具从 unpacked 目录另行构造，避免 fpm / AppImage 的 x86_64 二进制与在线下载。两个包共用同一份标准布局，Depends 由 `DT_NEEDED` 反查并过滤误命中。

## 四、实测结果

| 环节 | 结果 |
| --- | --- |
| `pnpm install --ignore-scripts --no-frozen-lockfile` | **exit 0**；2491 resolved / 2273 downloaded / 2692 added，3m42s；无平台解析报错 |
| `04-verify.sh` 体检 | **18 PASS / 0 FAIL**（Node / pnpm / Electron 可执行 / 平台键 `linux-loong64` / bundle target / 版本对齐 / esbuild 原生二进制 / 注入链 / node-pty prebuild 可加载 / canvas+oxide 官方原生包 / electron 具名导入与 43 兼容 / 安装包 4 项） |
| esbuild 0.25.12 | `transformSync('const a=1')` 输出正常，`@esbuild/linux-loong64` 落地 |
| `@zcode/formal-proof` | vite build **exit 0**，572 modules，`✓ built in 336ms` |
| `@zcode/web-share` | vite build **exit 0**，6308 modules，`✓ built in 28.08s`，产出 5.8 MB JS |
| `pnpm run build:bootstrap` 全量 | **exit 0**，5m50s，21 个构建产物（含 `packages/desktop` 生产构建 1m35s） |
| node-pty（官方包） | LoongArch ELF，Electron 43 与 Node 24 双环境 `require` 成功（`fork,open,resize,process`） |
| `bundle:desktop --os linux --arch loong64 --skip-build` | **完整链路**：prepare → electron-builder packaging → afterPack 全断言 → 运行时依赖审计；产物约 805 MB |
| afterPack 断言 | node-pty / CUA sharp / CUA koffi / CUA helper / mac locales 全过；sourcemap 清理 5498 处引用 / 5474 文件 |
| **运行期启动**（`--dir` 产物实跑） | **成功**：主进程无未捕获异常、窗口渲染完成（登录页）、host 子进程拉起并完成 RPC、窗口尺寸正常持久化 |
| `09-smoke-launch.sh` 冒烟 | **5/5 PASS**：无未捕获异常 / 主窗口创建 / 渲染进程无加载失败 / host 子进程拉起 / 观察期内存活 |
| 退出路径 | 修复后退出码 **0**、`GPU process isn't usable` FATAL **0 次**（修复前 132 / 1 次） |
| `08` API 审计 | 8281 源文件 / 57 个 electron 具名导入，与 43.7.7 的 `electron.d.ts` 比对**无缺失** |
| `10` 构造安装包 | **exit 0**，deb 222477412 B（SHA256 `e9cfa113…`）、pkg.tar.zst 222239331 B（SHA256 `fa96b4cc…`）；内置 **22 PASS / 0 FAIL** |
| **deb 解包后安装布局实跑** | **5/5 PASS**，GPU FATAL 0 次，截图 `report/zcode-loong64-installed-deb.png` |

## 五、失败点与修复

### 构建期

- `pnpm-workspace.yaml` 重复 mapping key → 删除重复的 `koffi: true`，补丁器改为幂等并支持 `--check`。
- 缺 `@rolldown/binding-linux-loong64-gnu` → 注入 `@rolldown-loong64`；社区 1.2.8 与 rolldown 1.0.0-rc.15 回调约定不兼容（`onLog` 返回值错误）→ 换 1.0.3；6308 模块大构建再次触发 `ThreadsafeFunction<BindingLog>` 错误 → 把 rolldown 的 JS 层也对齐到官方 1.0.3。
- 缺 `lightningcss.linux-loong64-gnu.node` → 注入 `@loong64/lightningcss-linux-loong64-gnu@1.33.0`。
- 缺 `@tailwindcss/oxide-linux-loong64-gnu` → 曾补装 WASI 包兜底，后改直取官方原生 4.2.2（见下）。

### 打包期

- 平台白名单散落在多个脚本里，逐个试错每轮 6–11 分钟 → **先用一次源码扫描列出所有含 `x64/arm64` 白名单的打包脚本，再一次性补齐**。
- `native-search-tools-config.mjs` 不认 `loong64` → 补架构识别，走 `enabled=false` 安全降级（0 tools）。
- `Unsupported keyring platform: linux-loong64` → 正则补 loong64，并补 `desktop-native-package-policy.mjs` 的 `SUPPORTED_DESKTOP_PLATFORM_KEYS` 与 `SHARP_VARIANTS_BY_PLATFORM`。
- `unknown property 'allowMissingDependencies'`（26.17.0 新增字段）→ 全量静态比对确认仅此一处，删掉该声明（26.15.6 默认即"缺依赖失败"，语义不变）。
- packaging 阶段静默挂起 6+ 分钟 → fd 检查发现 electron-builder 在重下 139 MB Electron zip 且不认 `ELECTRON_OVERRIDE_DIST_PATH`；补丁让 `ZCODE_ELECTRON_DIST` 注入 `electronDist` 指向本地已校验 zip，零下载。
- `linux.target` 尾声仍需下载 x86_64 AppImage/fpm → 改为 `["dir"]`。
- 后置审计写死平台目录/产物形态（`dist/linux-unpacked/`、体积审计）→ 补 loong64 分支识别，`--dir` 形态跳过体积审计。
- `missing staged koffi runtime for linux_loong64` 并非缺二进制：koffi 2.15.6 npm 包自带 `build/koffi/linux_loong64/koffi.node`，是 `--skip-prepare` 跳过了 stage。

### 运行期

- **运行期 #1（启动即崩）**：`SyntaxError: The requested module 'electron' does not provide an export named 'ClipboardItem'`。上游锁 44.7.0，代码用了 44 才有的 `ClipboardItem`，而 loong64 只有 43.7.7；ESM 具名导入在**模块链接期**校验导出表，缺符号直接终止主进程。写 `scripts/08` 逐条比对 8281 源文件、57 个具名导入，确认**只此一个**缺失 → 不整体降级 API，改运行时探测：有 `ClipboardItem` 走 44 异步 `write`，否则回落 43 同步 `writeImage`。
- **运行期 #2（退出 SIGILL）**：关窗后 Chromium 仍尝试重启 GPU 进程，loong64 上必败（`gpu_process_host: GPU process launch failed error_code=1002`），累积到上限后 `FATAL: GPU process isn't usable. Goodbye.`；LoongArch 用 trap 指令实现"立即崩溃" → SIGILL / 132。加 loong64 专用 `--disable-gpu-process-crash-limit` 后：132 → 0，FATAL 归零。

### 补充修正（2026-11-12）

- **canvas / oxide 的「版本不匹配」是误判**：只看了 `dist-tags.latest`，没看完整 `versions` 列表。canvas 源上 20 个版本含 `0.1.100`、oxide 11 个版本含 `4.2.2`，**均与 lockfile 精确对齐** → 直取官方原生包，零源码 / 零 lockfile 改动，无需 WASM、无需 Rust 编译；`scripts/05` 固化 6 项注入，oxide 主路径由 WASM 切原生，WASM 降为兜底。
- **canvas 漏声明依赖**：官方 `.node` 的 `DT_NEEDED` 无 `libstdc++`，但 Skia 用到 C++ RTTI；host Node 自带该库故 `node -e` **假阳性通过**，Electron 下报 `undefined symbol: _ZTVN10__cxxabiv117__class_type_infoE`。用 `patchelf --add-needed libstdc++.so.6`（幂等，`--print-needed` 判重）补齐，并在 `04-verify.sh` 增加 Electron 43 下的**功能**验证（真实绘制 PNG + 原生 Scanner 加载）。
- **canvas 不进 `app.asar` 是上游有意设计**：`findDesktopNativePackageViolations` 对 `/node_modules/@napi-rs/canvas*` 是 fail-closed 断言，pdf 插件自带轻量 `Matrix2D` 顶替 pdf.js 的 DOMMatrix。canvas 只落在源码树 / 服务 CLI / 开发 / 构建期。

### 重新安装复现（2026-11-20）

- **`pnpm install` 的 `packages/desktop postinstall` exit 1**：链路是 `node-pty-rebuild.mjs → ensureElectronRuntime()`，后者只认 `node_modules/electron/path.txt` + dist，没有就跑 `electron/install.js` 从 GitHub 下载 139 MB zip，弱网下 `TypeError: terminated`。`02-install.sh` 虽设了 `ELECTRON_OVERRIDE_DIST_PATH`，但 install.js 不认该变量（它只被 electron-builder 用）。修复：补丁器新增第 30 条 `postinstall-electron-local-dist`，给 `ensure-electron-runtime.mjs` 的 `installRuntime()` 加本地 dist 快路径——override 目录存在就把已校验的 Electron 43.7.7 dist 硬链进包并写 `path.txt`，零下载。重跑 `02-install.sh` exit 0。
- **`cpu-features` 编译失败非致命**：它是 ssh2 的 `optionalDependencies`，loong64 上 buildcheck 只编了 `hwcaps.c` 但 `binding.cc` 无条件 `using namespace cpu_features` → gyp 失败；pnpm 忽略可选依赖失败，不影响 install 退出码。
- **龙芯官方 node-pty 包被上游重编，GLIBC 要求升到 2.42**：同一版本号 `1.2.0-beta.10` 的 tgz，11-11 实测可加载（BuildID `0d71dd…`），11-20 重新下载的变成要求 `GLIBC_2.42`（BuildID `7e5c6a…`），本机 glibc 2.38 加载失败。同时发现 `06-build-loong64-node-pty.sh` 的 `verify_pty()` 用 `die`（exit 1），会绕过主流程已有的 `fetch_official || build_from_source` 降级。修复：把 verify_pty 的失败改为 `return 1` 并在调用点检查，官方包不兼容时自动降级本地编译（Electron headers + patchelf 去 libnode），`--force` 无需人工干预。
- **pnpm install 会剪除手工注入的 loong64 绑定**：每次 `02-install.sh` 后必须重跑 `05-inject-native-bindings.mjs`（6 项）和 `06-build-loong64-node-pty.sh`（node-pty），否则 `04-verify.sh` 报注入项缺失。完整顺序见 `reproduce.sh`。

### 安装包三坑

1. `dpkg -S` 反查 `DT_NEEDED` 误命中 `gcc-14.4.0` / `noctalia` / `liblol` → 用「系统库目录白名单 + 基线运行库 + `-dev`/Essential 过滤」收敛到 26 项干净依赖。
2. 绝对路径软链在解包到临时根后指向宿主机 `/opt` 导致启动失败 → 改成 `../../opt/...` 相对链。
3. pacman 需 `.PKGINFO` 为首个条目且带 `.MTREE`/`.BUILDINFO` → `bsdtar --format=mtree` + zstd 手工生成。

### node-pty 两条路径（`scripts/06`，官方优先）

1. **官方包（默认）**：完整落地 `lib/ + package.json + prebuilds`，`require.resolve` 与 beforePack 解析直接通过。
2. **本地编译（`--from-source`）**：`node-gyp rebuild --nodedir=~/.cache/electron/node-v43.7.7-headers --arch=loong64` → 6 秒产出 LoongArch ELF（N-API）。坑：Debian node-gyp 自动加 `-lnode`，产物 NEEDED `libnode.so.115`，Electron 43 下 `require` 直接 **SIGSEGV 139**；`patchelf --remove-needed libnode.so.115` 后由 Electron 自导出的 `napi_*` 符号满足加载。

### 三条最值得记住的经验

1. **只补 `.node` 不够，JS 与 binding 的版本必须成套**：小包（572 模块）能过，大包（6308 模块）才暴露回调约定差异。
2. **打包成功 ≠ 能启动**：ESM 缺符号是加载期失败、FATAL 只在关窗时出现；冒烟必须覆盖"启动 + 存活 + 退出码"三段。
3. **判断原生包有无可用版本，必须查完整 `versions` 列表**：只看 `dist-tags.latest` 会得出错误结论。

## 六、当前原生模块覆盖

| 模块 | 状态 | 方案 |
| --- | --- | --- |
| esbuild / rollup | ✅ 上游自带 loong64 | 直接安装 |
| rolldown | ✅ 已注入 | JS 对齐 1.0.3 + `@rolldown-loong64` binding 1.0.3 |
| lightningcss | ✅ 已注入 | `@loong64/lightningcss-linux-loong64-gnu` 1.33.0 |
| tailwind oxide | ✅ 官方原生 | `@tailwindcss/oxide-linux-loong64-gnu` 4.2.2（龙芯官方源，与 lock 精确对齐）；WASM 仅兜底 |
| node-pty | ✅ 官方包 | `@lydell/node-pty-linux-loong64` 1.2.0-beta.10（龙芯官方源）；本地编译兜底 |
| koffi | ✅ 无需移植 | 2.15.6 npm 包自带 `linux_loong64/koffi.node` |
| opentui-core | ✅ 纯 JS | 无 `.node`，此前标记 BLOCKED 有误 |
| oxc-parser / oxc-resolver / oxlint / oxfmt | 🟡 社区有包 | `@loongdotjs/oxc-*`、`@oxlint-loong64/*`、`@oxfmt-loong64/*`；标 EXPERIMENTAL（`--all`） |
| sharp | 🟡 官方源有包 | `@img/sharp-linux-loong64` 0.35.5 + libvips 1.3.4 |
| @napi-rs/canvas | ✅ 官方原生 | `@napi-rs/canvas-linux-loong64-gnu` 0.1.100 + patchelf 补 libstdc++；桌面产物按上游设计裁掉 |
| @napi-rs/keyring | 🟡 运行时降级 | 无任何 loong64 包；回退文件凭据。需 OS 密钥环时源码编译 |

**龙芯官方源直取复核（5.1）**

| 包 | lock 版本 | 源上 latest | 实际匹配版本 |
| --- | --- | --- | --- |
| `@napi-rs/canvas-linux-loong64-gnu` | 0.1.100 | 1.1.0 | **0.1.100**（源上 20 个版本） |
| `@tailwindcss/oxide-linux-loong64-gnu` | 4.2.2 | 4.3.5 | **4.2.2**（源上 11 个版本 4.1.11–4.3.5） |

上游 JS 层（`js-binding.js:284`、`index.js:366`）本就写好了 loong64 分支，缺的只是 `.node` 文件。

## 七、剩余工作（按优先级）

1. **凭据降级的功能确认**：keyring 走文件凭据后，确认登录/令牌存储在产品上可接受；不可接受则从 Rust 源码编译 `@napi-rs/keyring`（本机 rustc/cargo 1.87 可用）。**这是全链路唯一保留的降级项。**
2. **原生搜索工具**：`enabled=false` 降级，龙芯包内不带 ripgrep/ugrep；需验证「用户版本优先、缺失回退系统 rg」路径（打包日志中两条 `file source doesn't exist ... bundled-tools/linux-loong64/ripgrep` 即该降级的直接表现）。
3. **electron-builder 版本差**：26.15.6 与上游 26.17.0 的其它行为差异（pnpm 收集器、asar 裁剪）已随完整出包覆盖大部分，升级分支后复查。
4. **许可与再分发**：注入的 `.node` 与官方源包来自各上游，二次分发时保留 NOTICE / 第三方声明；安装包 control 已标注非官方上游发布。

### 已完成的原剩余项

- ~~桌面会话启动验证~~：已完成（真实启动 + 截图 + 冒烟脚本 `09`）。
- ~~Electron 43/44 API 回归~~：已完成并固化为 `scripts/08`，结论是**仅 `ClipboardItem` 一个符号差异**。
- ~~补齐 canvas / 原生 oxide~~：已完成，且**不需要升级任何依赖**。
- ~~安装包形态~~：`.deb` 与 `.pkg.tar.zst` 已由 `scripts/10` 产出并实跑验证，不需要 loongdeb / fpm / AppImage。

### 观察到但未处理的现象（与移植无直接关系）

- `[BroadcastHub] / [task-realtime] invalid host response message`：host 握手时一条消息不被主进程的 zod 判别联合接受，warn 后丢弃，随后 RPC 全部正常；同一份源码构建的 host 与 main，属上游行为。
- `ZCode Built-in client-config: HTTP 400`：Preview 版后端返回，网络层问题，非移植引入。
- `Failed to initialize cpuinfo`：Chromium 的 `base::CPU` 尚不识别 LoongArch 型号，仅影响 CPU 型号上报，不影响运行。

## 八、产物清单

- `scripts/00-fetch-runtime.sh` — 运行时下载/校验/安装（多镜像 + aria2 多连接）
- `scripts/01-apply-port.mjs` — 30 条幂等源码补丁
- `scripts/02-install.sh`、`03-build.sh`、`04-verify.sh` — 安装 / 分阶段构建 / 体检
- `scripts/05-inject-native-bindings.mjs` — 6 项已验证注入（含 2 项龙芯官方原生包）+ 3 项 EXPERIMENTAL
- `scripts/06-build-loong64-node-pty.sh` — node-pty 官方包获取（fallback 本地编译 + patchelf）与加载验证
- `scripts/08-audit-electron-api.mjs` — electron 具名导入与目标版本 API 面差审计
- `scripts/09-smoke-launch.sh` — 运行期冒烟（启动 / 存活 / 退出码 + 截图），支持 `ZCODE_SMOKE_APP` 测安装布局
- `scripts/10-package-linux.mjs` — `deb` / `pacman` 安装包构造（本机 `dpkg-deb` + `bsdtar`/`zstd`）、22 项自检、`--check` 幂等复验
- `reproduce.sh` — 11 阶段一键复现（含 `package` 阶段与出包后的二次体检）
- `patches/zcode-loong64.patch` — 上游改动完整 diff（14 文件 / 364 行，可 `git apply -R` 回退）
- `report/porting-matrix.json` — 结构化矩阵（工具链 / 30 补丁 / 原生覆盖 / 安装包 / 龙芯官方源清单）
- `report/linux-packages.json` — 两个安装包的身份、安装布局、Depends 反查、SHA256 与 22 项自检结果
- `report/zcode-loong64-launch.png`、`report/zcode-loong64-installed-deb.png` — 两张真实启动截图
- `report/*.json` — 补丁、注入、运行时、体检、node-pty、安装包的结构化结果（入库）
- `report/*.log`、`report/*.png` — 每次构建/打包/冒烟的原始日志与截图；**仅本地留档，不入库**
- `packages/desktop/dist/linux-loong64-unpacked/` — 最终桌面应用产物（约 805 MB，`--dir` 形态）
- `packages/desktop/dist/zcode-preview_3.18.2_loong64.deb` — Debian/Deepin 安装包（约 212 MiB，sha256 `fa0cc559…c8413b6`）
- `packages/desktop/dist/zcode-preview-3.18.2-1-loong64.pkg.tar.zst` — ArchLinux 安装包（约 212 MiB，sha256 `3af4124d…27c05`）

> 两个安装包因超过 GitHub 单文件 100 MB 限制，不进 git；`report/linux-packages.json` 记录了体积与 SHA256，可校验下载结果。11-20 重构建时源码已合入上游更新至 3.18.2，产物名随之从 3.18.0 更新。
