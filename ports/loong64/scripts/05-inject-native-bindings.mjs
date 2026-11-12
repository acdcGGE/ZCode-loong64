#!/usr/bin/env node
/**
 * 把龙芯社区预编译的 NAPI-RS 绑定注入到上游包期望的位置。
 *
 * 背景：ZCode 锁定的若干 Rust 原生包（rolldown / lightningcss / oxc / oxlint / ...）
 * 上游只发布 darwin + linux x64/arm64 + win32 的 .node，没有 linux-loong64。
 * 但上游 JS 层大多已经写好了 loong64 分支，只是找不到二进制。因此最稳妥的
 * 做法是：从社区 fork 取 .node，按上游 require() 的文件名复制到包内，
 * 不改 JS 代码、不改 lockfile，且随时可用 --check 审计。
 *
 * 来源优先级：龙芯官方源（registry.loongnix.cn:5873）有与 lockfile 精确对齐的
 * 平台包时优先直取，不用社区 fork、不降级到 WASM。canvas / tailwind oxide 即属此类：
 * 此前只查 dist-tags.latest 误判为「版本不匹配」，实际二者都有工程锁定版本。
 *
 * 版本对齐很重要（实测记录）：
 *   - rolldown JS 1.0.0-rc.15 + 社区 binding 1.2.8  -> 能加载，但 onLog 回调约定不兼容，构建失败
 *   - rolldown JS 1.0.0-rc.15 + 社区 binding 1.0.3  -> 兼容，vite build 全流程通过
 * 所以下面的 version 是实测结论，不要随意升到 latest。
 *
 * 用法：
 *   node scripts/05-inject-native-bindings.mjs             # 注入 VERIFIED 项
 *   node scripts/05-inject-native-bindings.mjs --check    # 只检查落地状态
 *   node scripts/05-inject-native-bindings.mjs --all      # 连 EXPERIMENTAL 项一起注入
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, cpSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveZcodeRoot } from "./_layout.mjs";

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zcodeArg = process.argv.find((a) => a.startsWith("--zcode="));
const zcodeRoot = zcodeArg ? resolve(zcodeArg.slice("--zcode=".length)) : resolveZcodeRoot(portRoot);
const checkOnly = process.argv.includes("--check");
const includeExperimental = process.argv.includes("--all");
const registry = "https://registry.npmmirror.com";
const loongnixRegistry = "https://registry.loongnix.cn:5873";
const cacheDir = join(portRoot, "downloads", "native");

// tarball 文件名规则：<scope>/<name>/-/<name>-<version>.tgz
const BINDINGS = [
  // 必须排在第一位：先覆盖 JS 层，后面的 rolldown 项再把 .node 注入到新的 dist/shared/
  {
    id: "rolldown-js",
    type: "js-overlay",
    upstream: "rolldown 1.0.0-rc.15",
    community: "rolldown",
    version: "1.0.3",
    status: "VERIFIED",
    targetDir: "node_modules/rolldown",
    verify: "require('rolldown').VERSION === '1.0.3'",
    note: "vite 8.0.8 精确依赖 rc.15；社区龙芯 binding 最低 1.0.3。实测 rc.15 JS + 1.0.3 binding 在 6308 模块的大构建里触发 onLog 回调不兼容，把 JS 层也对齐到 1.0.3 后 web-share 构建通过",
  },
  {
    id: "rolldown",
    upstream: "rolldown",
    upstreamVersion: "1.0.0-rc.15",
    community: "@rolldown-loong64/binding-linux-loong64-gnu",
    version: "1.0.3",
    status: "VERIFIED",
    note: "1.2.8 与 rc.15 的 onLog 回调约定不兼容；1.0.3 实测 vite build 通过",
    targets: ["node_modules/rolldown/dist/shared/rolldown-binding.linux-loong64-gnu.node"],
    verify: "require('rolldown').VERSION",
  },
  {
    id: "lightningcss",
    upstream: "lightningcss",
    upstreamVersion: "1.32.0",
    community: "@loong64/lightningcss-linux-loong64-gnu",
    version: "1.33.0",
    status: "VERIFIED",
    note: "上游 node/index.js 直接 require('../lightningcss.linux-loong64-gnu.node')",
    targets: ["node_modules/lightningcss/lightningcss.linux-loong64-gnu.node"],
    verify: "require('lightningcss').transform",
  },
  // 以下社区包存在，但尚未在 ZCode 的完整构建链上验证；--all 才会注入。
  {
    id: "oxc-parser",
    upstream: "@oxc-parser/binding",
    community: "@loongdotjs/oxc-parser-binding-linux-loong64-gnu",
    version: "0.142.1",
    status: "EXPERIMENTAL",
    note: "需同时建立 @oxc-parser/binding-linux-loong64-gnu 兼容包目录",
    targets: ["node_modules/@oxc-parser/binding/oxc-parser.linux-loong64-gnu.node"],
  },
  {
    id: "oxlint",
    upstream: "@oxlint/binding",
    community: "@oxlint-loong64/binding-linux-loong64-gnu",
    version: "1.69.0",
    status: "EXPERIMENTAL",
    targets: ["node_modules/@oxlint/binding/oxlint.linux-loong64-gnu.node"],
  },
  {
    id: "oxfmt",
    upstream: "@oxfmt/binding",
    community: "@oxfmt-loong64/binding-linux-loong64-gnu",
    version: "0.54.0",
    status: "EXPERIMENTAL",
    targets: ["node_modules/@oxfmt/binding/oxfmt.linux-loong64-gnu.node"],
  },
  // ── 龙芯官方源直取：版本与 lockfile 精确对齐，不降级、不换 WASM、不改 lockfile ──
  // 上游 JS 层早就写好了 loong64 分支（oxide index.js:366 / canvas js-binding.js:284），
  // 缺的只是 .node 文件。此前只查 dist-tags.latest 误判成「版本不匹配」：
  //   canvas 源上 125 个版本含 0.1.100（lock 0.1.100）
  //   oxide 源上 11 个版本含 4.2.2（lock 4.2.2）
  {
    id: "tailwindcss-oxide-native",
    upstream: "@tailwindcss/oxide@4.2.2",
    community: "@tailwindcss/oxide-linux-loong64-gnu",
    version: "4.2.2",
    status: "VERIFIED",
    tarball: `${loongnixRegistry}/@tailwindcss%2foxide-linux-loong64-gnu/-/oxide-linux-loong64-gnu-4.2.2.tgz`,
    targets: ["node_modules/@tailwindcss/oxide/tailwindcss-oxide.linux-loong64-gnu.node"],
    verify: "require('@tailwindcss/oxide').Scanner",
    note: "index.js:366 的 loong64-gnu 分支先 require 同目录 .node，原生加载成功即不再走 WASM；Node 24 与 Electron 43 双运行时均已实测",
  },
  {
    id: "napi-rs-canvas-native",
    upstream: "@napi-rs/canvas@0.1.100",
    community: "@napi-rs/canvas-linux-loong64-gnu",
    version: "0.1.100",
    status: "VERIFIED",
    tarball: `${loongnixRegistry}/@napi-rs%2fcanvas-linux-loong64-gnu/-/canvas-linux-loong64-gnu-0.1.100.tgz`,
    targets: ["node_modules/@napi-rs/canvas/skia.linux-loong64-gnu.node"],
    patchElfAdd: ["libstdc++.so.6"],
    verify: "require('@napi-rs/canvas').createCanvas(8,8).toBuffer('image/png').length",
    note: "官方包漏声明 libstdc++ 依赖：host Node 自带该库能加载，Electron 43 不带则报 __cxxabiv1::__class_type_info 未定义，需 patchelf 补 NEEDED；verify 会真实绘制一张 PNG",
  },
  // 不是 .node，而是补装上游自带的 WASM 回退包。现在只作兜底：有原生 .node 时
  // @tailwindcss/oxide/index.js 不会走到这里，但 pnpm 的 supportedArchitectures 不含 wasm32，
  // 原生缺失时不会自动安装它，所以保留这一项做双保险。
  {
    id: "tailwindcss-oxide-wasi",
    type: "package",
    upstream: "@tailwindcss/oxide@4.2.2",
    community: "@tailwindcss/oxide-wasm32-wasi",
    version: "4.2.2",
    status: "VERIFIED",
    targetDir: "node_modules/@tailwindcss/oxide-wasm32-wasi",
    verify: "require('@tailwindcss/oxide').Scanner",
    note: "兜底路径而非主路径；原生 loong64 .node 加载优先级更高",
  },
];

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 失败: ${r.stderr?.slice(0, 400)}`);
  return r.stdout;
}

/** 龙芯官方源(verdaccio)要求 scope 里的 / 编码成 %2f，故这类包直接给完整 tarball URL */
function tarballUrl(b) {
  if (b.tarball) return b.tarball;
  const { community: pkg, version } = b;
  const name = pkg.startsWith("@") ? pkg.split("/")[1] : pkg;
  return `${b.registry ?? registry}/${pkg}/-/${name}-${version}.tgz`;
}

function findNodeFile(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const found = findNodeFile(p);
      if (found) return found;
    } else if (e.name.endsWith(".node")) return p;
  }
  return null;
}

/** 整包/JS 层注入：用于 WASM 回退包，以及把 rolldown JS 对齐到龙芯 binding 的版本 */
function injectPackageDir(b) {
  const destRoot = resolve(zcodeRoot, b.targetDir ?? `node_modules/${b.community}`);
  const result = { id: b.id, status: b.status, community: `${b.community}@${b.version}`, targets: [] };
  if (checkOnly) {
    result.targets.push({ path: b.targetDir, landed: existsSync(join(destRoot, "package.json")) });
    result.state = "CHECKED";
    return result;
  }
  const tgz = join(cacheDir, `${b.id}-${b.version}.tgz`);
  const unpack = join(cacheDir, `${b.id}-${b.version}-unpack`);
  if (!existsSync(tgz)) {
    mkdirSync(cacheDir, { recursive: true });
    console.log(`[download] ${b.community}@${b.version}`);
    sh("curl", ["-fsSL", "-m", "180", "-o", tgz, tarballUrl(b)]);
  }
  if (!existsSync(unpack)) {
    mkdirSync(unpack, { recursive: true });
    sh("tar", ["-xzf", tgz, "-C", unpack]);
  }
  const src = join(unpack, "package");
  mkdirSync(destRoot, { recursive: true });
  if (b.type === "js-overlay") {
    cpSync(join(src, "dist"), join(destRoot, "dist"), { recursive: true, force: true });
    copyFileSync(join(src, "package.json"), join(destRoot, "package.json"));
  } else {
    cpSync(src, destRoot, { recursive: true, force: true });
  }
  result.targets.push({ path: b.targetDir, landed: existsSync(join(destRoot, "package.json")) });
  if (b.verify) {
    const r = spawnSync(process.execPath, ["-e", `const m=${b.verify}; if(!m) process.exit(1); console.log('load-ok')`], {
      cwd: zcodeRoot, encoding: "utf8",
    });
    // js-overlay 在 .node 注入前加载会失败，属预期，交由后续注入项补齐
    result.loadTest = b.type === "js-overlay" ? "DEFERRED" : r.status === 0 ? "PASS" : `FAIL: ${r.stderr?.slice(0, 200)}`;
  }
  result.state = "INJECTED";
  return result;
}

function inject(b) {
  const result = { id: b.id, status: b.status, community: `${b.community}@${b.version}`, targets: [] };
  // --check 只关心产物是否落地，不依赖下载缓存
  if (checkOnly) {
    for (const target of b.targets) {
      const dest = resolve(zcodeRoot, target);
      result.targets.push({ path: target, landed: existsSync(dest) && statSync(dest).size > 0 });
    }
    result.state = "CHECKED";
    return result;
  }
  const tgz = join(cacheDir, `${b.id}-${b.version}.tgz`);
  const unpack = join(cacheDir, `${b.id}-${b.version}`);

  if (!existsSync(tgz)) {
    if (checkOnly) { result.state = "MISSING_TARBALL"; return result; }
    mkdirSync(cacheDir, { recursive: true });
    console.log(`[download] ${b.community}@${b.version}`);
    sh("curl", ["-fsSL", "-m", "180", "-o", tgz, tarballUrl(b)]);
  }
  if (!existsSync(unpack)) {
    if (checkOnly) { result.state = "NOT_UNPACKED"; return result; }
    mkdirSync(unpack, { recursive: true });
    sh("tar", ["-xzf", tgz, "-C", unpack]);
  }
  const nodeFile = findNodeFile(unpack);
  if (!nodeFile) throw new Error(`${b.id}: tarball 中没有 .node 文件`);
  result.sourceFile = basename(nodeFile);
  result.sizeBytes = statSync(nodeFile).size;

  for (const target of b.targets) {
    const dest = resolve(zcodeRoot, target);
    const landed = existsSync(dest) && statSync(dest).size > 0;
    if (checkOnly) {
      result.targets.push({ path: target, landed });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(nodeFile, dest);
    // 部分龙芯官方包漏声明 libstdc++：Node 主进程自带该库所以能加载，
    // Electron 二进制不带则 dlopen 报 __cxxabiv1 符号未定义。补 NEEDED 即可，
    // 用 --print-needed 做幂等判断，重复注入不会叠加依赖。
    if (b.patchElfAdd?.length) {
      const listed = spawnSync("patchelf", ["--print-needed", dest], { encoding: "utf8" });
      const needed = listed.status === 0 ? listed.stdout.split("\n").map((s) => s.trim()) : [];
      for (const lib of b.patchElfAdd) {
        if (needed.includes(lib)) continue;
        const r = spawnSync("patchelf", ["--add-needed", lib, dest], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${b.id}: patchelf 补 ${lib} 失败: ${r.stderr?.slice(0, 200)}`);
        result.patchElf = [...(result.patchElf ?? []), lib];
      }
    }
    result.targets.push({ path: target, landed: true, bytes: statSync(dest).size });
  }

  if (b.verify && !checkOnly) {
    const r = spawnSync(process.execPath, ["-e", `const m=${b.verify}; if(!m) process.exit(1); console.log('load-ok')`], {
      cwd: zcodeRoot, encoding: "utf8",
    });
    result.loadTest = r.status === 0 ? "PASS" : `FAIL: ${r.stderr?.slice(0, 200)}`;
  }
  result.state = checkOnly ? "CHECKED" : "INJECTED";
  return result;
}

if (!existsSync(zcodeRoot)) {
  console.error(`源码树不存在: ${zcodeRoot}`);
  process.exit(1);
}

const selected = BINDINGS.filter((b) => includeExperimental || b.status === "VERIFIED");
const results = [];
let failed = 0;
for (const b of selected) {
  try {
    const r = (b.type === "package" || b.type === "js-overlay") ? injectPackageDir(b) : inject(b);
    results.push(r);
    const landed = r.targets.filter((t) => t.landed).length;
    const total = (b.targets ?? r.targets).length;
    console.log(`${r.state.padEnd(12)} ${b.id.padEnd(14)} ${landed}/${total} 目标  ${r.loadTest ?? ""}  ${b.community}@${b.version}`);
    if (r.loadTest?.startsWith("FAIL")) failed += 1;
  } catch (e) {
    results.push({ id: b.id, state: "ERROR", error: String(e.message) });
    console.log(`ERROR         ${b.id.padEnd(14)} ${e.message}`);
    failed += 1;
  }
}

mkdirSync(resolve(portRoot, "report"), { recursive: true });
if (!checkOnly) {
  writeFileSync(
    join(portRoot, "report", "native-injections.json"),
    `${JSON.stringify({ zcodeRoot, injectedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
}
console.log(`\n共 ${selected.length} 项，失败 ${failed} 项${checkOnly ? "（--check 未写入）" : ""}`);
if (failed) process.exitCode = 1;
