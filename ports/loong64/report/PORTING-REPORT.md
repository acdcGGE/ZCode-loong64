# ZCode → linux-loong64 移植实测报告

日期：2026-11-11 · 机器：Deepin 25 / Loongson-3A5000 LA464 / glibc 2.38 / 15 GiB RAM
上游：[acdcGGE/ZCode](https://github.com/acdcGGE/ZCode) v3.18.0（18657 文件，shallow clone 356 MB）

## 结论摘要

**已完成并端到端跑通（含真实桌面启动）**：龙芯工具链、29 条源码适配补丁、整棵 workspace
依赖安装、平台识别与打包参数、Electron loong64 二进制实跑、6 项原生绑定注入（含 2 项龙芯官方原生包）、
`pnpm run build:bootstrap` 全量构建 exit 0（21 个构建产物）、node-pty 换用龙芯官方包，
**`bundle:desktop --os linux --arch loong64` 完整打包链路**——electron-builder 26.15.6
真实 packaging + afterPack 全部断言通过（node-pty / CUA sharp / CUA koffi / CUA helper），
产物为 `dist/linux-loong64-unpacked/`（约 805 MB，`--dir` 形态，含 382 MB app.asar 与 glm
agent 资源）；以及**产物在 Deepin 图形会话中的真实启动**：主进程无异常、窗口渲染完成
（见截图 `report/zcode-loong64-launch.png`）、host 子进程与 RPC 正常、退出码 0。
完整日志 `report/bundle-final.log`、`report/smoke-launch.log`。

启动与退出各踩到一处非构建期问题：Electron 43 缺 `ClipboardItem` 导致主进程在模块链接期
直接终止，以及退出时 GPU 进程重启失败触发 Chromium FATAL（SIGILL / 132）。两处均已修复，
定位与验证见第四节第 17、18 条。

2026-11-12 补充一：复核龙芯官方源后，canvas / oxide 改为直取与 lockfile 精确对齐的
官方原生包（0.1.100 / 4.2.2），无需升级任何依赖，也无需 WASM 或 Rust 源码编译；
**全链路唯一保留的降级项只剩 keyring**。见 5.1 节与第四节第 19 条。

2026-11-12 补充二：`--dir` 之外，用本机原生工具（`dpkg-deb 1.22.6 -Zzstd`、
`bsdtar/libarchive 3.7.4` + `zstd 1.5.7`）从同一个 unpacked 目录构造出标准
**`.deb`（约 212 MiB）与 ArchLinux `.pkg.tar.zst`（约 212 MiB）**，无需 fpm /
AppImage 这类 x86_64 工具链，也不需要网络。脚本内置 22 项自检全部通过，
并把包解包到临时根、按 `/usr/bin` 软链 → `/opt/zcode-preview` 的真实安装布局
**再次启动成功**（5/5 PASS、`GPU process isn't usable` FATAL 0 次，
截图 `report/zcode-loong64-installed-deb.png`）。见第四节第 20 条与第七节。

这不是"改个版本就能跑"的移植：构建期靠注入社区二进制 + JS 层对齐解决，
打包期靠逐条补平台映射 + 官方源直取 + 本地编译兜底解决，运行期靠 API 面差审计 +
43/44 双路径兼容解决，安装包靠绕开 electron-builder 的 x86_64 fpm 走本机原生工具，
证据都留在 `report/*.log` 与 `report/*.json`。

## 一、环境与前置核查

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

## 二、关键决策与证据

1. **Electron 降级 44.7.0 → 43.7.7**，用 `darkyzhou/electron-loong64` v43.7.7 预编译包。
   ZIP SHA256 与 release 的 `SHASUMS256.txt` 一致；以 `ELECTRON_RUN_AS_NODE=1` 实跑得到：
   `electron 43.7.7 / node 24.21.0 / arch loong64 / ABI 148`。
   宿主 Node 24.14.0 的 ABI 是 137 —— **所有 Electron 内原生模块必须按 43 的 headers 重编译**。
2. **electron-builder** 用 `@loongdotjs/*` 26.15.6 三件套 override（上游 26.17.0 不认识 loong64）。
   两个版本存在 schema 差异，见迭代 #9。
3. **架构白名单**：`pnpm-workspace.yaml`、`target-platform.mjs`、`bundle.mjs`、
   `native-search-tools-config.mjs`、`stage-credential-keyring.mjs`、
   `desktop-native-package-policy.mjs`、`electron-builder.config.js` 等共 14 个文件、
   29 条补丁，完整 diff 在 `patches/zcode-loong64.patch`（已验证可 `git apply -R` 回退）。
4. **Rust 原生绑定**：上游 JS 层其实大多已写好 `loong64` 分支，只是 npm 没发对应 `.node`。
   因此不改 JS、不改 lockfile，直接把社区 fork 的 `.node` 按上游 `require()` 的文件名注入。
5. **node-pty 用龙芯官方包**：`registry.loongnix.cn:5873` 的
   `@lydell/node-pty-linux-loong64@1.2.0-beta.10` 与工程 optionalDependencies 精确匹配；
   官方包 DT_NEEDED 只有 libstdc++/libm/libgcc_s/libc/ld-linux，Electron 43 / Node 24
   双环境加载通过。本地源码编译保留为 fallback（见迭代 #10 的 patchelf 坑）。
6. **keyring 走运行时降级**：上游与龙芯官方源均无 `@napi-rs/keyring-linux-loong64-gnu`；
   上游 `systemCredentialCipher`（packages/shared/src/credential-security/systemCredentialCipher.ts:162）
   对 keyring 加载失败本就有 catch + `unavailable()` → 文件凭据回退，因此 stage 对 loong64
   跳过原生包，其余平台维持缺包即失败。
7. **安装包与 electron-builder 解耦**：`linux.target` 保持 `["dir"]`，deb / pacman 由
   移植层 `scripts/10` 用本机 loong64 工具从 unpacked 目录另行构造，避免 fpm / AppImage
   的 x86_64 二进制与在线下载。两个包共用同一份标准布局， Depends 由 `DT_NEEDED`
   反查并过滤误命中，产物带 SHA256 与 22 项自检（见第四节第 20 条）。

## 三、实测结果

| 环节 | 结果 |
| --- | --- |
| `pnpm install --ignore-scripts --no-frozen-lockfile` | **exit 0**；2491 resolved / 2273 downloaded / 2692 added，3m42s；无平台解析报错 |
| `04-verify.sh` 体检 | **18 PASS / 0 FAIL**（Node / pnpm / Electron 可执行 / 平台键 `linux-loong64` / `bundle target=linux/loong64` / 版本对齐 / esbuild 原生二进制 / 注入链 / node-pty prebuild 可加载 / canvas+oxide 官方原生包 / electron 具名导入与 43 兼容 / **安装包 4 项**：产物与 SHA256、deb 控制字段、pacman `.PKGINFO`、22 项构造自检） |
| esbuild 0.25.12 | `transformSync('const a=1')` 输出正常，`@esbuild/linux-loong64` 落地 |
| `@zcode/formal-proof` | vite build **exit 0**，572 modules，`✓ built in 336ms`，产出 HTML/CSS/JS |
| `@zcode/web-share` | vite build **exit 0**，6308 modules，`✓ built in 28.08s`，产出 5.8 MB JS |
| `pnpm run build:bootstrap` 全量 | **exit 0**，5m50s，21 个构建产物，含 `packages/desktop` 生产构建（1m35s），日志 `report/build-final.log` |
| node-pty（官方包） | LoongArch ELF，Electron 43 与 Node 24 双环境 `require` 成功（`fork,open,resize,process`），详见 `report/native-node-pty.json` |
| `bundle:desktop --os linux --arch loong64 --skip-build` | **完整链路**：prepare（CLI agent bundle、官方插件、koffi/keyring stage）→ electron-builder packaging → afterPack 全断言 → 运行时依赖审计；产物 `dist/linux-loong64-unpacked/` 约 805 MB |
| afterPack 断言 | node-pty prebuild / CUA sharp / CUA koffi / CUA helper / mac locales 全部通过；sourcemap 清理 5498 处引用 / 5474 文件 |
| **运行期启动**（`--dir` 产物实跑） | **成功**：主进程无未捕获异常、窗口渲染完成（登录页，截图 `report/zcode-loong64-launch.png`）、host 子进程拉起并完成 RPC（`project.readTree` / `setting.update` / `onboarding-record.*`）、窗口尺寸正常持久化 |
| `09-smoke-launch.sh` 冒烟 | **5/5 PASS**：无未捕获异常 / 主窗口创建 / 渲染进程无加载失败 / host 子进程拉起 / 观察期内存活 |
| 退出路径 | 修复后退出码 **0**、`GPU process isn't usable` FATAL **0 次**（修复前 132 / 1 次） |
| `08-audit-electron-api.mjs` 审计 | 8281 源文件 / 57 个 electron 具名导入，与 43.7.7 的 `electron.d.ts` 比对**无缺失** |
| `10-package-linux.mjs` 构造安装包 | **exit 0**，`zcode-preview_3.18.0_loong64.deb`（222477412 B / SHA256 `e9cfa113…`）、`zcode-preview-3.18.0-1-loong64.pkg.tar.zst`（222239331 B / SHA256 `fa96b4cc…`）；内置 **22 PASS / 0 FAIL**（control 字段、Depends 无误命中、app.asar、相对软链、setuid chrome-sandbox、desktop-file-validate、zstd 校验、`.PKGINFO`/`.MTREE`/`.BUILDINFO` 等），报告 `report/linux-packages.json` |
| **从 deb 解包后的安装布局实跑** | `ZCODE_SMOKE_APP=<tmp>/usr/bin/zcode-preview` 走 `/usr/bin` 相对软链 → `/opt/zcode-preview`，**5/5 PASS**，无未捕获异常 / 主窗口创建 / 渲染进程无加载失败 / host 子进程拉起 / 观察期内存活；`GPU process isn't usable` FATAL **0 次**；截图 `report/zcode-loong64-installed-deb.png`，日志 `report/smoke-installed-deb.log` |

## 四、迭代记录（构建 / 打包 / 运行期，每处失败点都有对应修复）

| # | 失败点 | 处理 |
| --- | --- | --- |
| 1 | `pnpm-workspace.yaml: duplicated mapping key` | 补丁重复加了上游已有的 `koffi: true`，删除；补丁器改为幂等并可 `--check` |
| 2 | `Cannot find module '@rolldown/binding-linux-loong64-gnu'` | 注入 `@rolldown-loong64/binding-linux-loong64-gnu` |
| 3 | 用社区 1.2.8 后：`onLog option: The function returned object, but expected undefined` | 1.2.8 与 rolldown 1.0.0-rc.15 的回调约定不兼容；换 1.0.3 |
| 4 | `Cannot find module '../lightningcss.linux-loong64-gnu.node'` | 注入 `@loong64/lightningcss-linux-loong64-gnu@1.33.0`，`transform()` 实测正常 |
| 5 | `Cannot find module '@tailwindcss/oxide-linux-loong64-gnu'` | 上游 4.2.2 自带 WASI 回退，但 pnpm 的 `supportedArchitectures` 不含 wasm32 故未安装；补装 `@tailwindcss/oxide-wasm32-wasi@4.2.2`，龙芯 V8 上 WASI 加载成功。**后续已改直取官方原生 4.2.2，见第 19 条** |
| 6 | 6308 模块大构建再次触发 `ThreadsafeFunction<BindingLog>` 返回值错误 | rc.15 的 JS 层与 1.0.3 binding 仍有差异；把 rolldown 的 JS 层也对齐到官方 1.0.3，web-share 构建通过 |
| 7 | 打包 #1：`native-search-tools-config.mjs` 不认 `loong64` | 补架构识别；`linux-loong64` 不在发布白名单，自动走 `enabled=false` 安全降级（0 tools） |
| 8 | 打包 #2：`Error: Unsupported keyring platform: linux-loong64` | `keyringPlatformPackage` 正则补 loong64；同时补 `desktop-native-package-policy.mjs` 的 `SUPPORTED_DESKTOP_PLATFORM_KEYS` 与 `SHARP_VARIANTS_BY_PLATFORM`（后者缺 key 会 `.includes()` 抛 TypeError） |
| 9 | 打包 #3：`Invalid configuration object ... unknown property 'allowMissingDependencies'` | 26.15.6 的 `scheme.json` 没有上游 26.17.0 新增的该字段。把配置对象与 scheme 做**全量静态比对**确认仅此一处，删掉该显式声明（26.15.6 默认即"缺依赖失败"，语义不变） |
| 10 | 打包 #4：`缺少 @lydell/node-pty-linux-loong64` | 龙芯官方源有精确匹配版本（1.2.0-beta.10），`scripts/06` 直接完整落地；官方包不可用时 fallback 本地编译（node-gyp + Electron 43 headers；Debian node-gyp 会强加 `libnode.so.115` 依赖导致 Electron 下 SIGSEGV 139，`patchelf --remove-needed` 去掉后可加载） |
| 11 | 打包 #5：packaging 阶段静默挂起 6+ 分钟（进程 6.5 分钟仅用 8 秒 CPU，无子进程） | fd 检查发现 electron-builder 在重下 139 MB Electron zip（`/tmp/electron-download-*/`），且不认 `ELECTRON_OVERRIDE_DIST_PATH`。补丁让 `ZCODE_ELECTRON_DIST` 注入 `electronDist` 指向本地已校验 zip，走 `selectElectron` 直解压分支，零下载 |
| 12 | 打包 #6：`linux.target=["AppImage","deb","rpm","pacman"]` 尾声仍需下载 x86_64 AppImage/fpm 工具链 | loong64 改为 `["dir"]`，交付 unpacked 目录；AppImage 运行时与 fpm 在龙芯上不可用 |
| 13 | 打包 #7（--skip-prepare 探测）：`missing staged koffi runtime for linux_loong64` | 非"缺二进制"：koffi 2.15.6 的 npm 包自带 `build/koffi/linux_loong64/koffi.node`；是 --skip-prepare 跳过了官方插件 stage。完整 prepare 链路会 stage koffi，无需额外移植 |
| 14 | 打包 #8：`Cannot find module '@napi-rs/keyring-linux-loong64-gnu/package.json'`（prepare 的 stage 阶段） | 上游与龙芯官方源均无此包。运行时本就有文件凭据回退（systemCredentialCipher catch），stage 对 loong64 跳过原生包，其余平台维持严格失败 |
| 15 | 打包 #9：asar 与 afterPack 全部通过后，`打包产物缺少 app.asar: dist/linux-unpacked/...` | 后置运行时依赖审计的 `resolveAppAsarPath` 目录名不含 arch；补 loong64 分支识别 `linux-loong64-unpacked` |
| 16 | 体积审计：`未找到 linux/loong64 的打包产物文件` | `--dir` 形态没有单文件安装包，loong64 跳过该审计 |
| 17 | **运行期 #1**：产物启动即弹窗 `A JavaScript error occurred in the main process`，`SyntaxError: The requested module 'electron' does not provide an export named 'ClipboardItem'` | 上游锁 44.7.0，代码用了 44 才有的 `ClipboardItem`（44 移除同步 `clipboard.writeImage`，改为异步 `clipboard.write([...])`），而 loong64 只有 43.7.7。ESM 的具名导入在**模块链接期**校验导出表，缺符号直接终止主进程（所以表现为"启动即崩"而非运行时异常）。写 `scripts/08` 把全仓 8281 个源文件、57 个不同的 electron 具名导入逐条与 43.7.7 的 `electron.d.ts` 比对，确认**只此一个**缺失 → 不整体降级 API，改运行时探测：有 `ClipboardItem` 走 44 异步 `write`，否则回落 43 同步 `writeImage` |
| 18 | **运行期 #2**：应用功能正常，但每次退出都以 **SIGILL / 退出码 132** 结束，并留下崩溃报告 | 最后一个窗口关闭后 Chromium 仍会尝试重启 GPU 进程，loong64 上该重启必败（`gpu_process_host: GPU process launch failed error_code=1002`），连续失败到上限后 `gpu_data_manager` 走 `FATAL: GPU process isn't usable. Goodbye.`；LoongArch 上用 trap 指令实现"立即崩溃"→ SIGILL。加 loong64 专用 `--disable-gpu-process-crash-limit` 后退出码 132 → 0、FATAL 归零（`kill -TERM` 复测） |
| 19 | **补充（2026-11-12）**：复查龙芯官方源，发现 canvas / oxide 的「版本不匹配」结论是误判——只看了 `dist-tags.latest`，没看完整 `versions` 列表 | canvas 源上 20 个版本含 `0.1.100`（lock 0.1.100），oxide 11 个版本含 `4.2.2`（lock 4.2.2），**都精确对齐**。按「龙芯源有的不降级」直取官方原生包，零源码 / 零 lockfile 改动；`scripts/05` 固化 6 项注入，oxide 主路径由 WASM 切原生，WASM 包降为兜底。canvas 在 Electron 43 下报 `undefined symbol: _ZTVN10__cxxabiv117__class_type_infoE`——官方包漏声明 `libstdc++`，host Node 自带该库故不暴露，用 `patchelf --add-needed libstdc++.so.6` 补齐后双运行时均能真实绘制 PNG。另确认上游**有意**把 canvas 裁出桌面产物（policy fail-closed 断言 + pdf 插件自研 `Matrix2D`），故不将其塞进 `app.asar` |
| 20 | **交付形态（2026-11-12）**：`--dir` 只有目录、没有可分发安装包；electron-builder 的 deb/pacman target 走 fpm（x86_64 AppImage，需在线下载），AppImage 运行时同理，龙芯上不可用 | 不等「loongdeb」之类的新打包器：写 `scripts/10` 直接复用本机 `dpkg-deb 1.22.6 -Zzstd` 与 `bsdtar 3.7.4 + zstd 1.5.7`，把 unpacked 目录装进 `/opt/<pkg>/` + `/usr/bin/<exe>` 相对软链 + hicolor 图标 + `.desktop` + copyright，零网络依赖。中途修掉三处坑：① `dpkg -S` 反查 `DT_NEEDED` 把 `/opt/gcc-14.4.0/lib/libgcc_s.so.1`、`/usr/local/lib/noc/...` 误命中成 `gcc-14.4.0` / `noctalia` / `liblol`，用「系统库目录白名单 + 基线运行库 + `-dev`/Essential 过滤」收敛到 26 项干净依赖；② 绝对路径软链在解包到临时根后指向宿主机 `/opt` 导致启动失败，改成 `../../opt/...` 相对链；③ pacman 需 `.PKGINFO` 为首个条目且带 `.MTREE`/`.BUILDINFO`，用 `bsdtar --format=mtree` + zstd 手工生成。最终 22/22 自检通过，解包后按真实安装布局实跑 5/5 PASS、GPU FATAL 0 次 |

> 构建期最容易踩的坑：**只补 `.node` 不够，JS 与 binding 的版本必须成套**。
> 小包（572 模块）能过，大包（6308 模块）才暴露回调约定差异。
>
> 打包期最容易踩的坑：**平台白名单散落在多个脚本里**，逐个试错每轮 6-11 分钟；
> 先用一次源码扫描列出所有含 `x64/arm64` 白名单的打包脚本，再一次性补齐，能省掉大半轮次。
>
> 打包后期还有一层"成功后的陷阱"：electron-builder 本体跑完后，上游自带的
> 后置审计（asar 路径、体积审计）也写死了平台目录/产物形态。
>
> 运行期最容易踩的坑：**打包成功 ≠ 能启动**。ESM 的具名导入缺失是"加载期"失败，
> 表现为一启动就弹 JS 错误框，日志里只有一行 `does not provide an export named`；
> 这类问题不会在任何构建步骤里报出来，必须真跑一次。同理，退出阶段的
> `FATAL ... Goodbye.` 只在关闭窗口时才出现，冒烟测试要覆盖"启动 + 存活 + 退出码"
> 三段，只测"起来了"会漏掉后者。

### node-pty 的两条路径（脚本 `scripts/06`，官方优先）

1. **官方包（默认）**：`registry.loongnix.cn:5873` / `@lydell/node-pty-linux-loong64@1.2.0-beta.10`，
   完整落地 `lib/ + package.json + prebuilds`，与真实安装布局一致，
   `require.resolve` 与 beforePack 解析直接通过。
2. **本地编译（--from-source）**：`node-gyp rebuild --nodedir=~/.cache/electron/node-v43.7.7-headers
   --arch=loong64` → 6 秒产出 LoongArch ELF（N-API，40 个 undefined 符号全是 `napi_*`）。
   坑：Debian node-gyp 自动加 `-lnode`，产物 `NEEDED libnode.so.115`（宿主 Node 20 的库），
   Electron 43 目录里没有，`require` 直接 **SIGSEGV (exit 139)**；
   `patchelf --remove-needed libnode.so.115` 后 Electron 自导出的 `napi_*` 符号即可满足加载。

## 五、当前原生模块覆盖

| 模块 | 状态 | 方案 |
| --- | --- | --- |
| esbuild / rollup | ✅ 上游自带 loong64 | 直接安装 |
| rolldown | ✅ 已注入 | JS 对齐 1.0.3 + `@rolldown-loong64` binding 1.0.3 |
| lightningcss | ✅ 已注入 | `@loong64/lightningcss-linux-loong64-gnu` 1.33.0 |
| tailwind oxide | ✅ 官方原生 | `@tailwindcss/oxide-linux-loong64-gnu` 4.2.2（龙芯官方源，与 lock 精确对齐）；WASM 包仅留兜底 |
| node-pty | ✅ 官方包 | `@lydell/node-pty-linux-loong64` 1.2.0-beta.10（龙芯官方源）；本地编译兜底 |
| koffi | ✅ 无需移植 | 2.15.6 npm 包自带 `linux_loong64/koffi.node`；afterPack 断言实测通过 |
| opentui-core | ✅ 纯 JS | 无 `.node`，此前标记 BLOCKED 有误 |
| oxc-parser / oxc-resolver / oxlint / oxfmt | 🟡 社区有包 | `@loongdotjs/oxc-*`、`@oxlint-loong64/*`、`@oxfmt-loong64/*`；注入器里标 EXPERIMENTAL（`--all`） |
| sharp | 🟡 官方源有包 | `@img/sharp-linux-loong64` 0.35.5 + libvips 1.3.4（registry.loongnix.cn）；computer-use producer 未装时 afterPack 不要求 |
| @napi-rs/canvas | ✅ 官方原生 | `@napi-rs/canvas-linux-loong64-gnu` 0.1.100（与 lock 精确对齐）+ patchelf 补 libstdc++；桌面产物按上游设计裁掉，服务源码树 / CLI / 构建期 |
| @napi-rs/keyring | 🟡 运行时降级 | 无任何 loong64 包；回退文件凭据（上游已有该设计）。需 OS 密钥环时源码编译 |


### 5.1 补充：龙芯官方源直取（2026-11-12）

判定某个原生包「有没有可用版本」，必须查 registry 返回的完整 `versions` 列表，
只看 `dist-tags.latest` 会得出错误结论。本次复核结果：

| 包 | lock 版本 | 源上 latest | 实际匹配版本 |
| --- | --- | --- | --- |
| `@napi-rs/canvas-linux-loong64-gnu` | 0.1.100 | 1.1.0 | **0.1.100**（源上 20 个版本） |
| `@tailwindcss/oxide-linux-loong64-gnu` | 4.2.2 | 4.3.5 | **4.2.2**（源上 11 个版本 4.1.11–4.3.5） |

因此不需要升级依赖、不需要 WASM 回退、不需要 Rust 源码编译：上游 JS 层
（`js-binding.js:284`、`index.js:366`）本就写好了 loong64 分支，缺的只是 `.node` 文件。
`scripts/05` 新增两项 VERIFIED 注入，产物形态与 lockfile 均不变。

canvas 有个龙芯包特有的坑：官方 `.node` 的 `DT_NEEDED` 只有
`libgcc_s / libm / libc / ld-linux-loongarch-lp64d`，但 Skia 用到 C++ RTTI，
需要 `libstdc++.so.6`。host Node 主进程自己链接了该库，所以只跑 `node -e` 会**假阳性通过**；
Electron 二进制不带，真实报 `undefined symbol: _ZTVN10__cxxabiv117__class_type_infoE`。
脚本用 `patchelf --add-needed` 补一条依赖（幂等，用 `--print-needed` 判重），
并在 `04-verify.sh` 新增 Electron 43 下的**功能**验证（真实绘制 PNG + 原生 Scanner 加载），
不再只测 host Node 的 `require()`。

另需澄清一个容易误判的点：**桌面产物不含 canvas 原生绑定是上游有意设计，不是缺件**。
`desktop-native-package-policy.mjs` 的 `findDesktopNativePackageViolations` 对
`/node_modules/@napi-rs/canvas*` 是 fail-closed 断言，pdf 插件也自带轻量 `Matrix2D`
顶替 pdf.js 的 DOMMatrix（源码注释明写 `a bundled plugin cannot ship`）。
所以官方原生包落在源码树，服务 CLI / 开发 / 构建期，不进 `app.asar`；
注入后重打包，该项断言仍须通过（`report/bundle-official-native.log`）。

## 六、剩余工作（按优先级）

1. **凭据降级的功能确认**：keyring 走文件凭据后，确认登录/令牌存储在产品上可接受；
   不可接受则从 Rust 源码编译 `@napi-rs/keyring`（本机 rustc/cargo 1.87 可用）。
   这是全链路唯一保留的降级项。
2. **原生搜索工具**：`native-search-tools-config.mjs` 走 `enabled=false` 降级，
   龙芯包内不带 ripgrep/ugrep 预编译；需验证「用户版本优先、缺失回退系统 rg」路径。
   打包日志里可见两条 `file source doesn't exist ... bundled-tools/linux-loong64/ripgrep`，即该降级的直接表现。
3. **electron-builder 版本差**：26.15.6 与上游 26.17.0 的其它行为差异（pnpm 收集器、
   asar 裁剪）已随完整出包覆盖大部分，升级分支后复查。
4. **许可与再分发**：注入的 `.node` 与官方源包来自各上游，二次分发时保留
   NOTICE / 第三方声明；安装包 control 已标注非官方上游发布。

### 已完成的原剩余项

- ~~桌面会话启动验证~~：已于本次完成（真实启动 + 截图 + 冒烟脚本 `09`，见第四节第 17、18 条）。
- ~~Electron 43/44 API 回归~~：已完成并固化为 `scripts/08`，结论是**仅 `ClipboardItem` 一个符号差异**。
- ~~补齐 canvas / 原生 oxide~~：已完成，且**不需要升级任何依赖**——龙芯官方源本就有与 lockfile 精确对齐的版本，详见 5.1 节。
- ~~安装包形态~~：`.deb` 与 `.pkg.tar.zst` 已由 `scripts/10` 用本机原生工具产出并实跑验证，
  不需要 loongdeb / fpm / AppImage，见第四节第 20 条。

### 观察到但未处理的现象（与移植无直接关系）

- `[BroadcastHub] / [task-realtime] invalid host response message`：host 启动握手时有一条
  消息不被主进程的 zod 判别联合接受，两处各记一次 warn 后丢弃，随后 RPC 全部正常。
  与架构无关（同一份源码构建的 host 与 main），属上游行为。
- `ZCode Built-in client-config: HTTP 400`：Preview 版后端返回，网络层问题，非移植引入。
- `Failed to initialize cpuinfo`：Chromium 的 `base::CPU` 尚不识别 LoongArch 型号，
  仅影响 CPU 型号上报，不影响运行。

## 七、产物清单

- `scripts/00-fetch-runtime.sh` — 运行时下载/校验/安装（多镜像 + aria2 多连接）
- `scripts/01-apply-port.mjs` — 29 条幂等源码补丁
- `scripts/02-install.sh`、`03-build.sh`、`04-verify.sh` — 安装 / 分阶段构建 / 体检
- `scripts/05-inject-native-bindings.mjs` — 6 项已验证注入（含 2 项龙芯官方原生包）+ 3 项 EXPERIMENTAL
- `scripts/06-build-loong64-node-pty.sh` — node-pty 官方包获取（fallback 本地编译 + patchelf）与加载验证
- `scripts/08-audit-electron-api.mjs` — electron 具名导入与目标版本 API 面差审计
- `scripts/09-smoke-launch.sh` — 运行期冒烟（启动 / 存活 / 退出码 + 截图），支持 `ZCODE_SMOKE_APP` 测安装布局
- `scripts/10-package-linux.mjs` — `deb` / `pacman` 安装包构造（本机 `dpkg-deb` + `bsdtar`/`zstd`）、22 项自检、`--check` 幂等复验
- `reproduce.sh` — 11 阶段一键复现（含 `package` 阶段与出包后的二次体检）
- `patches/zcode-loong64.patch` — 上游改动完整 diff（14 文件 / 364 行，可 `git apply -R` 回退）
- `report/porting-matrix.json` — 结构化矩阵（工具链 / 29 补丁 / 原生覆盖 / 安装包 / 龙芯官方源清单）
- `report/linux-packages.json` — 两个安装包的身份、安装布局、Depends 反查、SHA256 与 22 项自检结果
- `report/zcode-loong64-launch.png` — loong64 `--dir` 产物真实启动截图（登录页）
- `report/zcode-loong64-installed-deb.png` — deb 解包后按安装布局真实启动截图
- `report/*.json` — 补丁、注入、运行时、体检、node-pty、安装包的结构化结果（入库）
- `report/*.log`、`report/*.png` — 每次构建/打包/冒烟的原始日志与两张启动截图；
  **仅在本地留档，不入库**（体积大且依赖本机环境）
- `<源码树>/packages/desktop/dist/linux-loong64-unpacked/` — **最终桌面应用产物**（约 805 MB，`--dir` 形态）
- `<源码树>/packages/desktop/dist/zcode-preview_3.18.0_loong64.deb` — **Debian/Deepin 安装包**（约 212 MiB）
- `<源码树>/packages/desktop/dist/zcode-preview-3.18.0-1-loong64.pkg.tar.zst` — **ArchLinux 安装包**（约 212 MiB）

> 两个安装包因超过 GitHub 单文件 100 MB 限制，不进 git，作为
> [`acdcGGE/ZCode` 的 Release `loong64-3.18.0-preview`](https://github.com/acdcGGE/ZCode/releases/tag/loong64-3.18.0-preview) 附件分发；
> `report/linux-packages.json` 记录了各自体积与 SHA256，可校验下载结果。
