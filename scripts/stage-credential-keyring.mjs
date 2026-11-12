import { access, cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";

export function keyringPlatformPackage(platformKey) {
  const match = /^(darwin|linux|win32)-(x64|arm64|loong64)$/.exec(platformKey);
  if (!match) throw new Error(`Unsupported keyring platform: ${platformKey}`);
  return `@napi-rs/keyring-${platformKey}${match[1] === "linux" ? "-gnu" : match[1] === "win32" ? "-msvc" : ""}`;
}
/** dev 与打包使用同一依赖布局；原生包不能内联进 JS，也不能混入其他目标平台。 */
export async function stageCredentialKeyring({ sourceRoot, targetRoot, platformKey }) {
  const require = createRequire(resolve(sourceRoot, "package.json"));
  const nativeName = keyringPlatformPackage(platformKey);
  for (const name of ["@napi-rs/keyring", nativeName]) {
    // loong64: @napi-rs/keyring-linux-loong64-gnu 无上游/社区预编译包。
    // 运行时 systemCredentialCipher 对 import("@napi-rs/keyring") 失败已有 catch +
    // unavailable() 降级（回退文件凭据），这里跳过原生包 stage 与该降级口径一致；
    // 其余平台维持原严格行为（缺包即失败，防止漏带原生模块的包流出）。
    if (name === nativeName && platformKey.endsWith("loong64")) {
      try {
        require.resolve(`${name}/package.json`);
      } catch {
        console.warn(`[stage-credential-keyring] ${name} 不可用，loong64 跳过原生 keyring（运行时回退文件凭据）`);
        continue;
      }
    }
    const source = dirname(require.resolve(`${name}/package.json`));
    const target = resolve(targetRoot, "node_modules", name);
    if (name === nativeName) {
      const manifest = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
      await access(resolve(source, manifest.main));
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true,
      dereference: true,
      filter: (file) => !file.slice(source.length).split(sep).includes("node_modules"),
    });
  }
}
