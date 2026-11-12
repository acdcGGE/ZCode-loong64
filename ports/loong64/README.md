# ZCode → linux-loong64 移植层

把 [acdcGGE/ZCode](https://github.com/acdcGGE/ZCode) v3.18.0（AI 编程工作台，Electron + pnpm monorepo）
移植到龙芯 LoongArch64 / Deepin 25。目标形态是**完整桌面版**，Electron 采用
[darkyzhou/electron-loong64](https://github.com/darkyzhou/electron-loong64) 的预编译二进制。

本目录是**独立于上游源码的移植层**，随 `acdcGGE/ZCode` 的 `feat/loong64-port` 分支
发布在 `ports/loong64/` 下；所有源码改动由脚本生成、可重复执行、可用 `git diff` 审计，
不在上游代码里堆手工修改。

**两种摆放方式都支持**：仓库内布局（`<repo>/ports/loong64/`，源码树就是仓库根）与
独立目录布局（本目录与 `ZCode/` 同级）。`scripts/_layout.sh` / `_layout.mjs` 会自动探测，
也可用 `ZCODE_ROOT=/path` 显式覆盖。

**当前状态**：全量构建通过，`bundle:desktop --os linux --arch loong64` 端到端跑通，
产物为 `dist/linux-loong64-unpacked/`（约 805 MB，`--dir` 形态），并已在 Deepin 图形会话中
**真实启动**：主进程无异常、窗口渲染完成（截图 `report/zcode-loong64-launch.png`）、
host 子进程与 RPC 正常、退出码 0。启动与退出各有一处非构建期问题（Electron 43 缺
`ClipboardItem`、退出时 GPU 进程重启失败），均已修复，见下文决策 14 / 15。
在此之上，用 `scripts/10` 由解包目录构造出**标准 `.deb` 与 ArchLinux `.pkg.tar.zst`**，
并从解包后的安装布局（`/usr/bin` 软链 → `/opt/zcode-preview`）再次真实启动成功
（截图 `report/zcode-loong64-installed-deb.png`），见决策 16。

## 实测环境

| 项 | 值 |
| --- | --- |
| 机器 | Loongson-3A5000 LA464，Deepin 25，内核 6.18.48-loong64 |
| CPU 特性 | `lsx lasx`（Electron loong64 二进制的硬性要求），实测 LSX 指令可执行 |
| glibc | 2.38（满足 electron-loong64 的 `>= 2.38`） |
| 内存 / 可用磁盘 | 15 GiB / 56 GiB |
| 宿主 Node | 系统自带 20.15.1（不够，ZCode 要求 24+） |
| 本地编译 | gcc/g++ 12.3.0、node-gyp 9.3.0、python3、patchelf、make |

## 关键技术决策（都有实测依据）

1. **Node 24.14.0**：nodejs.org 无 loong64 包，Deepin 源只有 20；改用
   [`loong64/node`](https://github.com/loong64/node) 的 v24.14.0 glibc 构建，SHA256 校验通过。
   ZCode 的 `scripts/assert-node-version.mjs` 只要求 major >= 24。
2. **Electron 44.7.0 → 43.7.7**：electron-loong64 目前最高 release 是 v43.7.7（分支/tag 无 44.x）；
   自编译 44 需 32 GiB RAM + 200 GiB 磁盘，这台机器不具备。43.7.7 二进制校验通过并实跑：
   `electron 43.7.7 / node 24.21.0 / loong64 / ABI 148`。
3. **electron-builder** 换成 [`@loongdotjs/electron-builder` 26.15.6](https://github.com/darkyzhou/electron-builder-loong64)，
   通过 pnpm overrides 同时替换 `electron-builder` / `app-builder-lib` / `builder-util`。
   该分支比上游 26.17.0 旧，`allowMissingDependencies` 等新增配置项不被 schema 接受，
   已用静态比对找出并适配（见 `report/PORTING-REPORT.md`）。
4. **架构白名单**：`pnpm-workspace.yaml` 的 `supportedArchitectures.cpu` 加 `loong64`，
   `target-platform.mjs` / `bundle.mjs` 增加 loong64 分支与 `--loong64` 打包参数；
   打包期的 keyring / sharp / native-search / schema / electronDist / target / 审计目录
   映射逐条补齐（共 29 条补丁）。
5. **缺失的 Rust 原生绑定**：上游 JS 层多数已写好 loong64 分支、只是没有 `.node` 文件。
   从龙芯社区 fork 下载预编译 `.node`，按上游 `require()` 的文件名注入到包内。
   **JS 与 binding 必须成套对齐**：rolldown 1.0.0-rc.15 配社区 1.2.8 能加载但 `onLog`
   回调不兼容；换 1.0.3 后小包能过、6308 模块的大包仍触发回调差异；最终把 rolldown 的
   JS 层也对齐到官方 1.0.3 才全程通过。
6. **tailwind oxide 用龙芯官方原生包**：`registry.loongnix.cn:5873` 的
   `@tailwindcss/oxide-linux-loong64-gnu@4.2.2` 与工程锁定的 4.2.2 精确对齐，
   上游 `index.js:366` 的 loong64-gnu 分支会优先 require 同目录 `.node`。
   早期只查 `dist-tags.latest`（4.3.5）误判为「版本不匹配」，补装
   `@tailwindcss/oxide-wasm32-wasi` 走 WASM；现在 WASM 包仅留作兜底，主路径已是原生。
7. **node-pty 优先官方包**：龙芯官方源 `registry.loongnix.cn:5873` 提供
   `@lydell/node-pty-linux-loong64@1.2.0-beta.10`（与工程 optionalDependencies 声明
   精确匹配），官方包无 libnode 依赖、Electron 43 / Node 24 双环境加载通过，
   `scripts/06` 默认取官方包完整落地；下载失败才降级为本地源码编译
   （node-gyp + Electron 43 headers + `patchelf` 去掉 Debian node-gyp 强加的
   `libnode.so.115` 依赖，后者会导致 Electron 下 SIGSEGV）。
8. **平台脚本的安全降级**：`linux-loong64` 不在上游原生搜索工具（ripgrep/ugrep）发布白名单里，
   补上架构识别后自动走 `enabled=false`，跳过资源准备而不是抛错。
9. **Electron zip 本地直供**：electron-builder 内置的 @electron/get 走官方 CDN 拉龙芯 zip，
   本机实测会静默挂起数分钟；`ZCODE_ELECTRON_DIST` 指向 `00-fetch-runtime.sh` 已校验的
   本地 zip 后走 `electronDist` 快路径，直接解压、零下载。
10. **龙芯产物形态用 `--dir`**：AppImage 的打包工具链是 x86_64 二进制、fpm 需在线下载，
    龙芯上不可用；loong64 目标改为 `["dir"]`，交付 unpacked 目录（约 800 MB，含 382 MB app.asar）。
   deb / pacman 安装包不由它产出，见下文决策 16。
11. **koffi 无需移植**：工程锁定的 koffi 2.15.6 的 npm 包自带
    `build/koffi/linux_loong64/koffi.node`（LoongArch ELF），afterPack 的 stage 校验直接通过。
12. **keyring 走运行时降级**：`@napi-rs/keyring-linux-loong64-gnu` 上游与龙芯官方源均无
    loong64 包。上游 `systemCredentialCipher` 对 keyring 加载失败本就有 catch + 回退
    文件凭据的设计，因此 stage 脚本对 loong64 跳过原生包（其余平台维持严格失败）；
    凭据存储退化为文件加密（功能取舍，见报告第六节）。
13. **龙芯官方 npm 源**：`https://registry.loongnix.cn:5873`（verdaccio）覆盖广，实测含
    `@lydell/node-pty-linux-loong64`、`@napi-rs/canvas-linux-loong64-gnu`、
    `@img/sharp-linux-loong64` + libvips、`@tailwindcss/oxide-linux-loong64-gnu`、
    `@mbears/opentui-core`、`@rolldown/binding-linux-loong64-gnu`、
    `lightningcss-linux-loong64-gnu`、`esbuild-linux-loong64` 等；缺 keyring 与 oxlint
    平台包。**判定有没有可用包必须查完整 `versions` 列表，不能只看 `dist-tags.latest`**：
    此前据此误判 canvas / oxide 版本不匹配，实测 canvas 源上 20 个版本含 `0.1.100`
    （lock 0.1.100）、oxide 11 个版本含 `4.2.2`（lock 4.2.2），二者都能精确对齐。
    按「龙芯源有的不降级」，已用 `scripts/05` 直取官方原生包，不改 JS、不改 lockfile。
    canvas 官方包漏声明 `libstdc++`（host Node 自带、Electron 43 不带，会报
    `__cxxabiv1` 符号未定义），脚本用 `patchelf --add-needed` 补齐。
14. **Electron 43 / 44 的 API 面差**：上游锁 44.7.0，而 loong64 只有一个 43.7.7 构建。
    代码里用了 44 才有的 `ClipboardItem`（44 移除了同步 `clipboard.writeImage`，改为异步
    `clipboard.write([new ClipboardItem(...)])`），ESM 的具名导入在模块链接期校验导出表，
    在 43 上直接 `SyntaxError: ... does not provide an export named 'ClipboardItem'` 把整个
    主进程带走（不是运行时异常，是加载期失败，所以表现为启动即弹错误框）。
    把全仓 8281 个源文件、57 个不同的 `electron` 具名导入逐条与 43.7.7 的 `electron.d.ts`
    比对后，**只有这一个符号缺失**，因此不做整体 API 降级，只给剪贴板写入加一层运行时探测：
    有 `ClipboardItem` 走 44 的异步 `write`，否则回落 43 的同步 `writeImage`——两者都是原生
    写入，43 侧只是不等异步完成。该审计固化为 `scripts/08`，后续换 Electron 版本可直接回归。
15. **退出时的 GPU 崩溃**：产物能正常用，但每次退出都以 SIGILL / 退出码 132 结束。
    原因是窗口关闭后 Chromium 仍会重启 GPU 进程，loong64 上该重启必败
    （`GPU process launch failed error_code=1002`），连续失败到上限后 `gpu_data_manager`
    走 `FATAL: GPU process isn't usable. Goodbye.`——LoongArch 上用 trap 指令实现"立即崩溃"，
    所以是 SIGILL 而不是普通 abort。加 loong64 专用 `--disable-gpu-process-crash-limit`
    后退出码 132 → 0、FATAL 归零，其余平台行为不变。
16. **安装包不用 electron-builder，也不等"loongdeb"**：electron-builder 26.x 的
    deb/pacman target 走 fpm（构建期从 GitHub 下载的 x86_64 AppImage），AppImage 运行时
    同理，龙芯上既下不动也跑不了；因此保留 `linux.target=["dir"]`，由 `scripts/10`
    用**本机原生工具**（`dpkg-deb 1.22.6 -Zzstd`、`bsdtar/libarchive 3.7.4` +
    `zstd 1.5.7`）把同一个 unpacked 目录装进标准布局：`/opt/<pkg>/` + 相对软链
    `/usr/bin/<exe> -> ../../opt/<pkg>/<exe>` + hicolor 图标 + `.desktop` + copyright。
    deb 的 `Depends` 由 `readelf -d` 取 34 个 `DT_NEEDED` 再 `dpkg -S` 反查，
    用「系统库目录白名单 + 基线运行库 + `-dev`/Essential 过滤」去掉 gcc-14.4.0 / liblol /
    noctalia 这类同名误命中，最终 26 项；`chrome-sandbox` 保持 `4755 root:root`。
    pacman 侧补齐 `.PKGINFO` / `.MTREE` / `.BUILDINFO`。产物各有 SHA256，
    脚本内置 22 项自检（`report/linux-packages.json`），`--check` 可幂等复验。

## 复现步骤

以下步骤也可由 `./reproduce.sh` 一键串行执行（共 11 个阶段）：`--dry-run` 预览阶段、
`--from=<阶段>` 断点续跑、`--skip-smoke` 用于无图形会话环境、`--skip-packages`
用于没有 `dpkg-deb` / `bsdtar` 的环境。手工执行时：

```bash
cd zcode-loong64-port

# 1. 上游源码（仅独立目录布局需要；仓库内布局已自带源码树，
#    reproduce.sh 的 clone 阶段检测到 .git 会自动跳过）
git clone --depth 1 -b feat/loong64-port https://github.com/acdcGGE/ZCode.git ../ZCode

# 2. 下载并校验运行时：Node 24.14.0 / pnpm 10.33.2 / Electron 43.7.7 + headers
./scripts/00-fetch-runtime.sh

# 3. 打 29 条源码补丁（幂等，结果写入 report/patch-apply.json）
node scripts/01-apply-port.mjs --check   # 先预检
node scripts/01-apply-port.mjs

# 4. 安装依赖（先 --no-scripts 验证依赖树，再跑完整安装）
./scripts/02-install.sh --no-scripts
./scripts/02-install.sh

# 5. 注入 6 项已验证的原生绑定适配（幂等，可 --check 预检）
#    rolldown JS 对齐 1.0.3 / rolldown binding / lightningcss binding /
#    canvas + tailwind oxide 的龙芯官方原生包 / oxide WASI 兜底包
node scripts/05-inject-native-bindings.mjs --check
node scripts/05-inject-native-bindings.mjs

# 6. 落地 linux-loong64 的 node-pty 原生模块（官方包优先，--from-source 强制本地编译）
./scripts/06-build-loong64-node-pty.sh

# 7. 体检：Node / pnpm / Electron / 平台键 / 打包参数 / 原生包
#    安装包 4 项在尚未生成产物时自动跳过，出包后再跑一次即为 18/18
./scripts/04-verify.sh

# 8. 构建（分阶段，便于定位失败点）
./scripts/03-build.sh build
# 打包前把本地 Electron zip 交给 electron-builder，绕开在线下载
export ZCODE_ELECTRON_DIST="$PWD/downloads/electron-v43.7.7-linux-loong64.zip"
./scripts/03-build.sh bundle
# 产物：../ZCode/packages/desktop/dist/linux-loong64-unpacked/（--dir 形态）

# 9. 构造 deb / pacman 安装包（用本机 dpkg-deb + bsdtar/zstd，零下载）
#    产物 dist/*.deb 与 dist/*.pkg.tar.zst；--check 可只做幂等复验
node scripts/10-package-linux.mjs

# 10. 运行期冒烟：真实启动产物，断言主进程不崩、主窗口创建、host 子进程拉起
#     ZCODE_SMOKE_APP=/path/to/usr/bin/zcode-preview 可改测安装后的布局
./scripts/09-smoke-launch.sh
```

所有脚本通过 `scripts/_layout.*` 自动定位源码树（仓库内布局取上两级、独立布局取同级
`../ZCode`），可用 `ZCODE_ROOT=/path` 覆盖；`01-apply-port.mjs` /
`05-inject-native-bindings.mjs` 另支持 `--zcode=/path`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `scripts/_layout.sh` / `_layout.mjs` | 布局探测：自动定位源码树（仓库内 `ports/loong64/` 或独立目录），支持 `ZCODE_ROOT` 覆盖 |
| `scripts/00-fetch-runtime.sh` | 多镜像 + 多连接下载运行时，SHA256 / tar 完整性校验，就地解压安装 |
| `scripts/01-apply-port.mjs` | 29 条幂等源码补丁，`--check` 预检，输出结构化结果 |
| `scripts/02-install.sh` | 带完整环境变量的 pnpm install |
| `scripts/03-build.sh` | bootstrap / build / bundle 分阶段构建，逐阶段留日志 |
| `scripts/04-verify.sh` | 移植体检（运行时 / 平台 / 原生包 / 安装包，共 18 项），输出 `report/verify.json`；安装包未生成时该组自动跳过 |
| `scripts/05-inject-native-bindings.mjs` | 6 项已验证注入（社区 `.node` / JS 层对齐 / 龙芯官方原生 canvas+oxide / WASM 兜底包），`--check` / `--all`，canvas 自动 patchelf |
| `scripts/06-build-loong64-node-pty.sh` | node-pty 龙芯官方包获取（fallback 本地源码编译 + patchelf 修补）+ Electron 加载验证 + prebuild 落地，输出 `report/native-node-pty.json` |
| `scripts/08-audit-electron-api.mjs` | 逐条核对源码里从 `electron` 静态具名导入的「值」在目标 Electron 版本是否存在，输出 `report/electron-api-audit.json` |
| `scripts/09-smoke-launch.sh` | 运行期冒烟：真实启动已打包产物，断言主进程不崩 / 主窗口创建 / 渲染进程无加载失败 / host 子进程拉起，可留截图；`ZCODE_SMOKE_APP` 可改测安装布局 |
| `scripts/10-package-linux.mjs` | 用本机 `dpkg-deb -Zzstd` + `bsdtar`/`zstd` 从 `--dir` 产物构造 `.deb` 与 `.pkg.tar.zst`（标准 `/opt` 布局、自动反查 Depends、22 项自检、`--check` 幂等复验） |
| `patches/zcode-loong64.patch` | 上游改动的完整 diff（14 文件 / 364 行，可 `git apply` 审计 / `git apply -R` 回退） |
| `report/porting-matrix.json` | 工具链 / 补丁 / 原生模块覆盖 / 安装包 / 阻塞项的结构化清单 |
| `report/linux-packages.json` | 两个安装包的身份、布局、Depends、SHA256 与 22 项自检结果 |
| `report/PORTING-REPORT.md` | 实测记录、结论与剩余工作 |
| `report/zcode-loong64-installed-deb.png` | 从 deb 解包后的安装布局真实启动截图 |
| `reproduce.sh` | 一键复现入口，11 个阶段（`--dry-run` / `--from=<阶段>` / `--skip-smoke` / `--skip-packages`） |
| `THIRD-PARTY-NOTICES.md` | 第三方二进制来源、版本与许可核对清单 |
| `downloads/`、`opt/` | 下载缓存与本地工具链（不入版本库） |

## 发布位置与获取方式

本移植层随 [`acdcGGE/ZCode`](https://github.com/acdcGGE/ZCode) 的 **`feat/loong64-port`**
分支发布，位于仓库的 `ports/loong64/` 目录；该分支的仓库根已应用 29 条源码补丁。
**不向上游 `zai-org/ZCode` 提 PR**，也不改动 `main`。

```bash
git clone -b feat/loong64-port https://github.com/acdcGGE/ZCode.git ZCode
cd ZCode/ports/loong64
./reproduce.sh --dry-run     # 预览 11 个阶段
```

- 29 条源码改动可用 `patches/zcode-loong64.patch` 以 `git apply` / `git apply -R`
  单独审计或回退；脚本本身幂等，重复执行不会叠加。
- `.gitignore` 排除 `downloads/`、`opt/`（约 600 MB 本地工具链）、`build/`、
  `report/*.log` 与截图；入库的是脚本、补丁、文档与关键 JSON，增量约 280 KB。
- **安装包不进 git**：`.deb` 与 `.pkg.tar.zst` 各约 212 MiB，超过 GitHub 单文件
  100 MB 限制，作为 [Release `loong64-3.18.0-preview`](https://github.com/acdcGGE/ZCode/releases/tag/loong64-3.18.0-preview)
  的附件分发（含 `SHA256SUMS`）。本地构建后可用
  `node scripts/10-package-linux.mjs --check` 复验体积与 SHA256。
- **许可沿用仓库根的 Apache-2.0 LICENSE**，无需单独文件；第三方二进制来源与许可
  见 `THIRD-PARTY-NOTICES.md`。Release 附件的 control / `.PKGINFO` 已标注
  「community loong64 port, not an official upstream release」。
- 一键复现入口 `./reproduce.sh` 串行跑完 11 个阶段，任一失败即中止；
  产物落在 `<源码树>/packages/desktop/dist/`。

## 许可与合规

- 上游 ZCode：Apache-2.0；electron-loong64：MIT；Node.js：MIT；
  社区 binding 各自遵循其原项目许可。本移植层只做适配，不修改上游版权与声明。
  完整清单见 `THIRD-PARTY-NOTICES.md`。
- 注入的 `.node` 二进制来自公开 npm 包，脚本保留来源包名与版本，便于审计。
  其中 canvas / oxide 两项取自龙芯官方源，许可沿用各自上游项目；
  `patchelf` 只补一条 `DT_NEEDED`（libstdc++.so.6），不改动代码段。
- `scripts/06` 从龙芯官方源落地 `@lydell/node-pty-linux-loong64`（MIT，来自
  github.com/lydell/node-pty 的 loong64 构建）；仅当降级为本地编译时生成的产物
  不应二次分发。
- `.deb` / `.pkg.tar.zst` 打包的是上游 `--dir` 产物的原样副本（含 Electron 43.7.7
  与各第三方 `.node`）。control 的 `Description` 已标明「community loong64 port,
  not an official upstream release」，再分发时须一并保留 `THIRD-PARTY-NOTICES.md`。
