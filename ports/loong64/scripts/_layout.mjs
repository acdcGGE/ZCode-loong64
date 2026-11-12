/**
 * 移植层的布局探测（供各 mjs 脚本 import）。
 *
 * 支持两种摆放方式，无需调用方设置 ZCODE_ROOT：
 *   A 独立目录：<workdir>/zcode-loong64-port/   源码树在 <workdir>/ZCode/
 *   B 仓库内  ：<repo>/ports/loong64/           源码树就是 <repo>/ 本身
 * 判定依据：布局 B 的「上两级」就是仓库根，含 packages/desktop。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveZcodeRoot(portRoot) {
  if (process.env.ZCODE_ROOT) return resolve(process.env.ZCODE_ROOT);
  const repoRoot = resolve(portRoot, "..", "..");
  if (existsSync(join(repoRoot, "packages", "desktop"))) return repoRoot;
  return resolve(portRoot, "..", "ZCode");
}
