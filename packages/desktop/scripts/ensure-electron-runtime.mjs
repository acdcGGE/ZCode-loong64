import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

async function installedBinary(packageRoot) {
  try {
    const relativePath = (await readFile(join(packageRoot, "path.txt"), "utf8")).trim();
    if (!relativePath) return null;
    const binary = join(packageRoot, "dist", relativePath);
    await access(binary);
    return binary;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function installRuntime(packageRoot) {
  // loong64: 官方与 npmmirror 均无 linux-loong64 的 Electron zip，install.js 会直连
  // GitHub 下载 139MB 并在弱网下 terminated（postinstall exit 1）。移植层已用
  // 00-fetch-runtime.sh 下载并校验过同版本 dist，ELECTRON_OVERRIDE_DIST_PATH 指向它；
  // 直接硬链/复制到 electron 包期望的 dist 并写 path.txt，让 installedBinary 命中，零下载。
  const { cpSync, writeFileSync: writeTxt } = require("node:fs");
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH?.trim();
  if (override && require("node:fs").existsSync(join(override, "electron"))) {
    cpSync(override, join(packageRoot, "dist"), { recursive: true, force: true });
    writeTxt(join(packageRoot, "path.txt"), "electron\n");
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    // 新安装入口未配置镜像时会直连 GitHub；仅给安装子进程补既有镜像，避免影响 builder 辅助包下载。
    const env = {
      ...process.env,
      ELECTRON_MIRROR:
        process.env.ELECTRON_MIRROR?.trim() || "https://npmmirror.com/mirrors/electron/",
    };
    const child = spawn(process.execPath, [join(packageRoot, "install.js")], {
      cwd: packageRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Electron installation failed (${code ?? signal})`));
    });
  });
}

export async function ensureElectronRuntime({
  packageRoot = dirname(require.resolve("electron/package.json")),
  installRuntime: install = installRuntime,
} = {}) {
  const existing = await installedBinary(packageRoot);
  if (existing) return existing;
  // Electron 42 起不再 postinstall 下载；dev 直接启动 dist，必须先等待官方安装完成。
  await install(packageRoot);
  const binary = await installedBinary(packageRoot);
  if (!binary) throw new Error("Electron binary unavailable after installation");
  return binary;
}
