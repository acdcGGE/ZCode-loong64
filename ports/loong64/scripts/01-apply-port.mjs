#!/usr/bin/env node
/**
 * ZCode -> linux-loong64 移植补丁器（幂等）
 *
 * 用法:
 *   node scripts/01-apply-port.mjs                 # 应用补丁到源码树（自动探测布局）
 *   node scripts/01-apply-port.mjs --check        # 只检查，不写文件
 *   node scripts/01-apply-port.mjs --zcode=/path  # 指定源码树
 *
 * 设计原则：
 *  1. 不改上游语义，只增加 loong64 分支 / 替换版本与镜像地址；
 *  2. 每条改动带 marker，重复执行不会产生叠加；
 *  3. 上游结构变化导致 from 匹配失败时，明确报错而不是静默跳过；
 *  4. 结果写入 report/patch-apply.json，便于 CI 与复现审计。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveZcodeRoot } from "./_layout.mjs";

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zcodeArg = process.argv.find((a) => a.startsWith("--zcode="));
const zcodeRoot = zcodeArg ? resolve(zcodeArg.slice("--zcode=".length)) : resolveZcodeRoot(portRoot);
const checkOnly = process.argv.includes("--check");

const ELECTRON_MIRROR = "https://github.com/darkyzhou/electron-loong64/releases/download/";

/** @type {{id:string,file:string,from:string,to:string,marker:string,note:string}[]} */
const EDITS = [
  // ---------- 1. pnpm 架构白名单 ----------
  {
    id: "workspace-cpu-loong64",
    file: "pnpm-workspace.yaml",
    from: "  cpu:\n    - current\n    - x64\n    - arm64\n",
    to: "  cpu:\n    - current\n    - x64\n    - arm64\n    - loong64\n",
    marker: "    - loong64\n",
    note: "让 pnpm 解析/安装 linux-loong64 的 optional native 包",
  },
  {
    id: "workspace-allowbuilds-loong64",
    file: "pnpm-workspace.yaml",
    from: "  unsafe-pointer: true\n",
    to: [
      "  unsafe-pointer: true",
      "  # loong64: 上游没有预编译产物，允许从源码构建",
      "  \"@napi-rs/canvas\": true",
      "  \"@napi-rs/keyring\": true",
      "  \"@tailwindcss/oxide\": true",
      "  \"@mbears/opentui-core\": true",
      "  lightningcss: true",
      "  sharp: true",
      "",
    ].join("\n"),
    marker: "  # loong64: 上游没有预编译产物",
    note: "pnpm 10 默认禁止 install 脚本，放开需要从源码编译的原生包",
  },

  // ---------- 2. 目标平台识别 ----------
  {
    id: "target-platform-arch",
    file: "packages/desktop/scripts/target-platform.mjs",
    from: '    case "arm64":\n    case "aarch64":\n      return "arm64";\n',
    to: '    case "arm64":\n    case "aarch64":\n      return "arm64";\n    case "loong64":\n    case "loongarch64":\n      return "loong64";\n',
    marker: '    case "loong64":',
    note: "getTargetPlatform() 接受 loong64，产出 linux-loong64 平台键",
  },
  {
    id: "target-platform-types",
    file: "packages/desktop/scripts/target-platform.d.mts",
    from: 'export type TargetPlatformArch = "x64" | "arm64";',
    to: 'export type TargetPlatformArch = "x64" | "arm64" | "loong64";',
    marker: '"loong64"',
    note: "同步类型定义，避免 typecheck 失败",
  },

  // ---------- 3. bundle.mjs 架构与镜像 ----------
  {
    id: "bundle-default-os",
    file: "packages/desktop/scripts/bundle.mjs",
    from: 'const DEFAULT_TARGET_OS = "mac";',
    to: 'const DEFAULT_TARGET_OS = "linux";',
    marker: 'const DEFAULT_TARGET_OS = "linux";',
    note: "龙芯移植默认目标平台改为 linux",
  },
  {
    id: "bundle-default-arch",
    file: "packages/desktop/scripts/bundle.mjs",
    from: 'const DEFAULT_TARGET_ARCH = "arm64";',
    to: 'const DEFAULT_TARGET_ARCH = "loong64";',
    marker: 'const DEFAULT_TARGET_ARCH = "loong64";',
    note: "龙芯移植默认目标架构改为 loong64",
  },
  {
    id: "bundle-arch-alias",
    file: "packages/desktop/scripts/bundle.mjs",
    from: '  ["arm64", "arm64"],\n  ["aarch64", "arm64"],\n]);',
    to: '  ["arm64", "arm64"],\n  ["aarch64", "arm64"],\n  ["loong64", "loong64"],\n  ["loongarch64", "loong64"],\n]);',
    marker: '  ["loong64", "loong64"],',
    note: "--arch loong64 / loongarch64 均可解析",
  },
  {
    id: "bundle-arch-flag",
    file: "packages/desktop/scripts/bundle.mjs",
    from: 'const archBuilderFlagMap = {\n  x64: "--x64",\n  arm64: "--arm64",\n};',
    to: 'const archBuilderFlagMap = {\n  x64: "--x64",\n  arm64: "--arm64",\n  loong64: "--loong64",\n};',
    marker: '  loong64: "--loong64",',
    note: "@loongdotjs/electron-builder 的龙芯 CLI 标志",
  },
  {
    id: "bundle-artifact-hints",
    file: "packages/desktop/scripts/bundle.mjs",
    from: '  arm64: ["arm64", "aarch64"],\n};',
    to: '  arm64: ["arm64", "aarch64"],\n  loong64: ["loong64", "loongarch64"],\n};',
    marker: '  loong64: ["loong64", "loongarch64"],',
    note: "产物名校验兼容 loong64 命名",
  },
  {
    id: "bundle-electron-mirror",
    file: "packages/desktop/scripts/bundle.mjs",
    from: 'export const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";',
    to: `export const DEFAULT_ELECTRON_MIRROR = "${ELECTRON_MIRROR}";`,
    marker: ELECTRON_MIRROR,
    note: "Electron 运行时改从 electron-loong64 release 获取",
  },

  // ---------- 4. Electron 版本（上游 44.7.0 无 loong64 构建） ----------
  {
    id: "desktop-electron-version",
    file: "packages/desktop/package.json",
    from: '"electron": "44.7.0"',
    to: '"electron": "43.7.7"',
    marker: '"electron": "43.7.7"',
    note: "electron-loong64 目前最高预编译版本为 v43.7.7",
  },

  // ---------- 5. electron-builder 龙芯分支 ----------
  {
    id: "root-builder-overrides",
    file: "package.json",
    from: '    "overrides": {\n      "@electron/rebuild>node-abi": "4.37.0",',
    to: [
      '    "overrides": {',
      '      "@electron/rebuild>node-abi": "4.37.0",',
      '      "electron-builder": "npm:@loongdotjs/electron-builder@26.15.6",',
      '      "app-builder-lib": "npm:@loongdotjs/app-builder-lib@26.15.6",',
      '      "builder-util": "npm:@loongdotjs/builder-util@26.15.6",',
    ].join("\n"),
    marker: '"electron-builder": "npm:@loongdotjs/electron-builder',
    note: "官方 electron-builder 26.17.0 不认识 loong64，替换成龙芯分支三件套",
  },

  // ---------- 6. mise / npm 源 ----------
  {
    id: "mise-electron-mirror",
    file: "mise.toml",
    from: 'ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"',
    to: `ELECTRON_MIRROR = "${ELECTRON_MIRROR}"`,
    marker: ELECTRON_MIRROR,
    note: "mise 任务环境的 Electron 镜像",
  },
  {
    id: "npm-registry-mirror",
    file: ".npmrc",
    from: "registry=https://registry.npmjs.org",
    to: "registry=https://registry.npmmirror.com",
    marker: "registry.npmmirror.com",
    note: "本机实测 npmjs 单请求 10s / npmmirror 0.8s，切国内源加速依赖安装",
  },

  // ---------- 7. 资源准备脚本的架构识别（安全降级） ----------
  {
    id: "native-search-arch-loong64",
    file: "scripts/native-search-tools-config.mjs",
    from: [
      "export function normalizeNativeSearchArch(rawArch = process.arch) {",
      "  switch (rawArch.toLowerCase()) {",
      '    case "x64":',
      '    case "amd64":',
      '    case "x86_64":',
      '      return "x64";',
      '    case "arm64":',
      '    case "aarch64":',
      '      return "arm64";',
      "    default:",
    ].join("\n"),
    to: [
      "export function normalizeNativeSearchArch(rawArch = process.arch) {",
      "  switch (rawArch.toLowerCase()) {",
      '    case "x64":',
      '    case "amd64":',
      '    case "x86_64":',
      '      return "x64";',
      '    case "arm64":',
      '    case "aarch64":',
      '      return "arm64";',
      '    case "loong64":',
      '    case "loongarch64":',
      '      return "loong64";',
      "    default:",
    ].join("\n"),
    marker: '    case "loong64":',
    note: "让 linux-loong64 被识别；它不在 ENABLED_NATIVE_SEARCH_PLATFORM_KEYS 中，会走 enabled=false 的安全降级（跳过原生 ripgrep/ugrep 资源准备），而不是直接抛错",
  },

  // ---------- 8. 打包期的平台映射（只补识别，不改运行时语义） ----------
  {
    id: "keyring-platform-arch",
    file: "scripts/stage-credential-keyring.mjs",
    from: "  const match = /^(darwin|linux|win32)-(x64|arm64)$/.exec(platformKey);",
    to: "  const match = /^(darwin|linux|win32)-(x64|arm64|loong64)$/.exec(platformKey);",
    marker: "(x64|arm64|loong64)$",
    note: "keyringPlatformPackage() 接受 linux-loong64；desktop-native-package-policy 也调用它生成裁剪名单，原正则会抛 Unsupported keyring platform",
  },
  {
    id: "desktop-policy-platform-key",
    file: "packages/desktop/scripts/desktop-native-package-policy.mjs",
    from: '  "linux-arm64",\n  "linux-x64",\n  "win32-arm64",',
    to: '  "linux-arm64",\n  "linux-loong64",\n  "linux-x64",\n  "win32-arm64",',
    marker: '  "linux-loong64",',
    note: "assertSupportedTargetPlatformKey() 接受 linux-loong64；否则 electron-builder 的 createDesktopNativePackagePrunePatterns 直接抛不支持的桌面目标平台",
  },
  {
    id: "desktop-policy-sharp-variants",
    file: "packages/desktop/scripts/desktop-native-package-policy.mjs",
    from: '  "linux-arm64": ["sharp-linux-arm64", "sharp-libvips-linux-arm64"],\n};',
    to: [
      '  "linux-arm64": ["sharp-linux-arm64", "sharp-libvips-linux-arm64"],',
      "  // loong64: 上游无 sharp 预编译包，全部变体排除（fail-closed）；",
      "  // 等 @img-loong64/sharp-linux-loong64 落地后在此登记对应变体名。",
      '  "linux-loong64": [],',
      "};",
    ].join("\n"),
    marker: '"linux-loong64": []',
    note: "SHARP_VARIANTS_BY_PLATFORM 缺 key 会让 .includes() 抛 TypeError；给空数组表示所有 sharp 变体都不是目标平台资源",
  },
  {
    id: "builder-config-schema-26-15",
    file: "packages/desktop/electron-builder.config.js",
    from: "  allowMissingDependencies: false,",
    to: [
      "  // loong64: @loongdotjs/electron-builder 是 26.15.6，其 app-builder-lib scheme.json",
      "  // 没有上游 26.17.0 新增的 allowMissingDependencies 字段，带上去会直接 schema 校验失败。",
      "  // 26.15.6 默认行为就是\"缺依赖即失败\"，去掉该显式声明语义不变；",
      "  // 待龙芯分支跟进 26.17+ 后恢复此行。",
    ].join("\n"),
    marker: "26.15.6 默认行为就是",
    note: "消除 electron-builder 版本差导致的 Invalid configuration object（全量静态比对确认仅此一个未知字段）",
  },
  {
    id: "postinstall-electron-local-dist",
    file: "packages/desktop/scripts/ensure-electron-runtime.mjs",
    from: [
      "function installRuntime(packageRoot) {",
      "  return new Promise((resolve, reject) => {",
    ].join("\n"),
    to: [
      "function installRuntime(packageRoot) {",
      "  // loong64: 官方与 npmmirror 均无 linux-loong64 的 Electron zip，install.js 会直连",
      "  // GitHub 下载 139MB 并在弱网下 terminated（postinstall exit 1）。移植层已用",
      "  // 00-fetch-runtime.sh 下载并校验过同版本 dist，ELECTRON_OVERRIDE_DIST_PATH 指向它；",
      "  // 直接硬链/复制到 electron 包期望的 dist 并写 path.txt，让 installedBinary 命中，零下载。",
      "  const { cpSync, writeFileSync: writeTxt } = require(\"node:fs\");",
      "  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH?.trim();",
      "  if (override && require(\"node:fs\").existsSync(join(override, \"electron\"))) {",
      "    cpSync(override, join(packageRoot, \"dist\"), { recursive: true, force: true });",
      "    writeTxt(join(packageRoot, \"path.txt\"), \"electron\\n\");",
      "    return Promise.resolve();",
      "  }",
      "  return new Promise((resolve, reject) => {",
    ].join("\n"),
    marker: "ELECTRON_OVERRIDE_DIST_PATH?.trim()",
    note: "postinstall 的 ensureElectronRuntime 优先用本地已校验 Electron dist，避免弱网下载 139MB 导致 exit 1",
  },
  {
    id: "electron-dist-env-override",
    file: "packages/desktop/electron-builder.config.js",
    from: "  electronDownload: {",
    to: [
      "  // loong64: electron-builder 的 @electron/get 走官方 CDN 拉 electron zip（本机实测会",
      "  // 静默挂起数分钟）。ZCODE_ELECTRON_DIST 指向本地 zip 时走 electronDist 快路径，",
      "  // 直接解压、完全跳过下载（ElectronFramework.js selectElectron 分支）。",
      "  ...(process.env.ZCODE_ELECTRON_DIST ? { electronDist: process.env.ZCODE_ELECTRON_DIST } : {}),",
      "  electronDownload: {",
    ].join("\n"),
    marker: "ZCODE_ELECTRON_DIST ? { electronDist",
    note: "让 00-fetch-runtime.sh 下载并校验过的本地 Electron zip 直接进入打包，绕开慢速/易挂起的在线下载",
  },
  {
    id: "linux-dir-target-loong64",
    file: "packages/desktop/electron-builder.config.js",
    from: '    target: ["AppImage", "deb", "rpm", "pacman"],',
    to: [
      "    // loong64: AppImage/deb/rpm/pacman 的打包工具链（appimage 需 x86_64 运行时、",
      "    // fpm 需从 GitHub 下载二进制）在龙芯上既下不动也跑不了；--dir 产出的 unpacked",
      "    // 目录是 electron-builder 在龙芯上的交付形态，deb / pacman 安装包已由移植层的",
      "    // scripts/10-package-linux.mjs 用本机 dpkg-deb + bsdtar/zstd 从该目录另行构造。",
      '    target: targetPlatform.key === "linux-loong64" ? ["dir"] : ["AppImage", "deb", "rpm", "pacman"],',
    ].join("\n"),
    marker: 'targetPlatform.key === "linux-loong64" ? ["dir"]',
    note: "避免 electron-builder 在 packaging 尾声尝试下载 x86_64 AppImage/fpm 工具链导致挂起",
  },
  {
    id: "keyring-stage-loong64-degrade",
    file: "scripts/stage-credential-keyring.mjs",
    from: "  for (const name of [\"@napi-rs/keyring\", nativeName]) {\n    const source = dirname(require.resolve(`${name}/package.json`));",
    to: [
      "  for (const name of [\"@napi-rs/keyring\", nativeName]) {",
      "    // loong64: @napi-rs/keyring-linux-loong64-gnu 无上游/社区预编译包。",
      "    // 运行时 systemCredentialCipher 对 import(\"@napi-rs/keyring\") 失败已有 catch +",
      "    // unavailable() 降级（回退文件凭据），这里跳过原生包 stage 与该降级口径一致；",
      "    // 其余平台维持原严格行为（缺包即失败，防止漏带原生模块的包流出）。",
      "    if (name === nativeName && platformKey.endsWith(\"loong64\")) {",
      "      try {",
      "        require.resolve(`${name}/package.json`);",
      "      } catch {",
      "        console.warn(`[stage-credential-keyring] ${name} 不可用，loong64 跳过原生 keyring（运行时回退文件凭据）`);",
      "        continue;",
      "      }",
      "    }",
      "    const source = dirname(require.resolve(`${name}/package.json`));",
    ].join("\n"),
    marker: "loong64 跳过原生 keyring",
    note: "消除 prepare 阶段 Cannot find module '@napi-rs/keyring-linux-loong64-gnu'；运行时降级路径上游已实现（systemCredentialCipher.ts:162 catch）",
  },
  {
    id: "asar-audit-loong64-dir",
    file: "packages/desktop/scripts/bundle.mjs",
    from: "      arch === \"arm64\" ? \"linux-arm64-unpacked\" : \"linux-unpacked\",",
    to: [
      "      // loong64 输出目录是 linux-loong64-unpacked（electron-builder 按 arch 命名）。",
      "      arch === \"loong64\"",
      "        ? \"linux-loong64-unpacked\"",
      "        : arch === \"arm64\"",
      "          ? \"linux-arm64-unpacked\"",
      "          : \"linux-unpacked\",",
    ].join("\n"),
    marker: '"linux-loong64-unpacked"',
    note: "打包本体已成功，后置运行时依赖审计却因目录名不含 arch 找不到 app.asar 而误报失败",
  },
  {
    id: "size-audit-skip-dir-target",
    file: "packages/desktop/scripts/bundle.mjs",
    from: [
      "  const artifactPath = findBuiltArtifact(os, arch);",
      "  runTimedSync(\"bundle:audit-bundle-size\", () =>",
    ].join("\n"),
    to: [
      "  // loong64 产物形态是 --dir（unpacked 目录），没有可审计的单文件安装包。",
      "  if (arch === \"loong64\") {",
      "    console.log(\"[bundle] loong64 为 --dir 产物形态，跳过安装包体积审计\");",
      "    return;",
      "  }",
      "  const artifactPath = findBuiltArtifact(os, arch);",
      "  runTimedSync(\"bundle:audit-bundle-size\", () =>",
    ].join("\n"),
    marker: "跳过安装包体积审计",
    note: "--dir 输出没有 .AppImage/.deb 等单文件产物，findBuiltArtifact 必然抛错",
  },
  {
    id: "plugin-sandbox-clipboard-import",
    file: "packages/desktop/src/main/pluginSandbox/host.ts",
    from: ["  clipboard,", "  ClipboardItem,", "  MessageChannelMain,"].join("\n"),
    to: ["  clipboard,", "  MessageChannelMain,"].join("\n"),
    marker: ["  clipboard,", "  MessageChannelMain,"].join("\n"),
    note: "Electron 43 不导出 ClipboardItem，静态具名导入在模块链接期抛 SyntaxError 直接终止主进程（本次崩溃根因）",
  },
  {
    id: "plugin-sandbox-clipboard-native-image",
    file: "packages/desktop/src/main/pluginSandbox/host.ts",
    from: ["  dialog,", "  session as electronSession,"].join("\n"),
    to: ["  dialog,", "  nativeImage,", "  session as electronSession,"].join("\n"),
    marker: ["  nativeImage,", "  session as electronSession,"].join("\n"),
    note: "为 Electron 43 回落路径引入 nativeImage（43/44 均导出，不影响 44 行为）",
  },
  {
    id: "plugin-sandbox-clipboard-writer",
    file: "packages/desktop/src/main/pluginSandbox/host.ts",
    from: "export interface PluginSandboxHost {",
    to: [
      "/**",
      " * Electron 44 移除了同步的 `clipboard.writeImage`，图片复制改为异步",
      " * `clipboard.write([new ClipboardItem({ ... })])`。",
      " *",
      " * loong64 目前只有 Electron 43 的龙芯移植构建，并不导出 `ClipboardItem`；而 ESM 的具名导入",
      " * 会在模块链接期校验导出表，缺失即抛 SyntaxError 并终止整个主进程。因此这里不做静态导入，",
      " * 改为调用时探测：存在 ClipboardItem 就走 44 的异步写入，否则回落到 43 的同步 writeImage。",
      " * 两条路径都直接调用原生剪贴板，写入失败仍会向 IPC 调用方传播。",
      " */",
      "async function writePngToClipboard(png: Uint8Array): Promise<void> {",
      '  const { ClipboardItem } = (await import("electron")) as unknown as {',
      "    ClipboardItem?: new (items: Record<string, Blob>) => unknown;",
      "  };",
      "  if (ClipboardItem) {",
      "    const write = clipboard.write as unknown as (items: unknown[]) => Promise<void>;",
      "    await write([",
      "      new ClipboardItem({",
      '        "image/png": new Blob([Uint8Array.from(png)], { type: "image/png" }),',
      "      }),",
      "    ]);",
      "    return;",
      "  }",
      "  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)));",
      "}",
      "",
      "export interface PluginSandboxHost {",
    ].join("\n"),
    marker: "writePngToClipboard",
    note: "43/44 双路径剪贴板写入：有 ClipboardItem 走异步 write，否则回落 writeImage，保持上游 44 语义不变",
  },
  {
    id: "plugin-sandbox-clipboard-call-site",
    file: "packages/desktop/src/main/pluginSandbox/host.ts",
    from: [
      "    const cropped = captured.crop(scaleCaptureRect(request, captured.getSize()));",
      "    // Electron 44 移除同步 writeImage；以 PNG 保留图像编码，等待原生写入后才确认复制成功。",
      "    await clipboard.write([",
      "      new ClipboardItem({",
      '        "image/png": new Blob([Uint8Array.from(cropped.toPNG())], { type: "image/png" }),',
      "      }),",
      "    ]);",
    ].join("\n"),
    to: [
      "    const cropped = captured.crop(scaleCaptureRect(request, captured.getSize()));",
      "    // 以 PNG 保留图像编码，等待原生写入后才确认复制成功（44 走异步 write，43 回落 writeImage）。",
      "    await writePngToClipboard(cropped.toPNG());",
    ].join("\n"),
    marker: "await writePngToClipboard(cropped.toPNG());",
    note: "把 IPC 处理器的剪贴板写入切到兼容层；截图失效校验与错误传播保持不变",
  },
  {
    id: "loong64-gpu-crash-limit",
    file: "packages/desktop/src/main/index.ts",
    from: [
      'if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1") {',
      '  app.commandLine.appendSwitch("remote-debugging-port", "9229");',
      "}",
    ].join("\n"),
    to: [
      'if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1") {',
      '  app.commandLine.appendSwitch("remote-debugging-port", "9229");',
      "}",
      "",
      "// loong64：最后一个窗口关闭后 Chromium 仍会尝试重启 GPU 进程，而该平台上的重启必然失败",
      "// （gpu_process_host: GPU process launch failed error_code=1002），连续失败达到上限后",
      "// gpu_data_manager 走 FATAL 路径直接 abort —— 在 LoongArch 上表现为 SIGILL、退出码 132，",
      '// 即"应用能正常用，但每次退出都被记一次崩溃"。放开崩溃上限后重启失败只记日志，退出干净。',
      "// 仅对 loong64 生效，其他平台行为保持不变。",
      'if (process.arch === "loong64") {',
      '  app.commandLine.appendSwitch("disable-gpu-process-crash-limit");',
      "}",
    ].join("\n"),
    marker: "disable-gpu-process-crash-limit",
    note: "退出时 GPU 进程重启必败 → gpu_data_manager FATAL abort（SIGILL/退出码 132）；放开崩溃上限后退出码恢复 0",
  },
];

function apply() {
  const results = [];
  let failed = 0;

  for (const edit of EDITS) {
    const filePath = resolve(zcodeRoot, edit.file);
    const entry = { id: edit.id, file: edit.file, status: "", note: edit.note };

    if (!existsSync(filePath)) {
      entry.status = "MISSING_FILE";
      failed += 1;
      results.push(entry);
      continue;
    }

    const src = readFileSync(filePath, "utf8");
    if (src.includes(edit.marker)) {
      entry.status = "ALREADY_APPLIED";
      results.push(entry);
      continue;
    }
    if (!src.includes(edit.from)) {
      entry.status = "CONTEXT_MISMATCH";
      failed += 1;
      results.push(entry);
      continue;
    }

    const next = src.replace(edit.from, edit.to);
    if (!checkOnly) writeFileSync(filePath, next);
    entry.status = checkOnly ? "PENDING" : "APPLIED";
    results.push(entry);
  }

  const reportDir = resolve(portRoot, "report");
  mkdirSync(reportDir, { recursive: true });
  if (!checkOnly) {
    writeFileSync(
      resolve(reportDir, "patch-apply.json"),
      `${JSON.stringify({ zcodeRoot, appliedAt: new Date().toISOString(), results }, null, 2)}\n`,
    );
  }

  const width = Math.max(...results.map((r) => r.id.length));
  for (const r of results) {
    console.log(`${r.status.padEnd(17)} ${r.id.padEnd(width)}  ${r.file}`);
  }
  console.log(`\n总计 ${results.length} 条，失败 ${failed} 条${checkOnly ? "（--check 模式，未写入）" : ""}`);

  if (failed > 0) {
    console.error("\n上下文不匹配的补丁需要人工核对上游文件后更新本脚本：");
    for (const r of results.filter((x) => x.status === "CONTEXT_MISMATCH" || x.status === "MISSING_FILE")) {
      console.error(`  - ${r.id} (${r.file})`);
    }
    process.exitCode = 1;
  }
}

if (!existsSync(zcodeRoot)) {
  console.error(`源码树不存在: ${zcodeRoot}`);
  process.exit(1);
}
apply();
