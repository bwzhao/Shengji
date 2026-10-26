/**
 * 打包局域网版：把服务端打成两个 .mjs（主程序和搜索 worker），连同前端、机器人模型、启动脚本放进一个目录。
 * 再放进对应平台的 Node 可执行文件，压成 zip，别人解压后双击启动脚本就能用。
 *
 *   node apps/server/lan/build.mjs --out <目录> [--platform mac|win|linux] [--node <node 可执行文件>]
 *
 * 先要 pnpm build 打好前端。不传 --node 时不带 Node（自己机器上用 node app/lan.mjs 试跑）。
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const { values } = parseArgs({ options: { out: { type: 'string' }, platform: { type: 'string' }, node: { type: 'string' } } });
if (!values.out) throw new Error('要指定 --out');
const out = resolve(values.out);
const platform = values.platform ?? (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux');
const webDist = join(repo, 'apps/web/dist');
if (!existsSync(join(webDist, 'index.html'))) throw new Error('前端还没打包：先运行 pnpm build');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 服务端和 worker 各打成一个 ESM 文件；依赖里的 CommonJS 包要用 require，补一个
await build({
  entryPoints: { lan: join(repo, 'apps/server/src/lan.ts'), searchWorker: join(repo, 'apps/server/src/searchWorker.ts') },
  outdir: join(out, 'app'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws 的可选加速包，没装也能用
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

cpSync(webDist, join(out, 'web'), { recursive: true });
cpSync(join(repo, 'packages/engine/models'), join(out, 'models'), { recursive: true });
copyFileSync(join(here, 'README.txt'), join(out, 'README.txt'));

const script = { mac: 'Start.command', win: 'Start.bat', linux: 'start.sh' }[platform];
if (!script) throw new Error(`不认识的平台：${platform}`);
copyFileSync(join(here, script), join(out, script));
if (platform !== 'win') chmodSync(join(out, script), 0o755);

if (values.node) {
  const name = platform === 'win' ? 'node.exe' : 'node';
  mkdirSync(join(out, 'node'));
  copyFileSync(values.node, join(out, 'node', name));
  if (platform !== 'win') chmodSync(join(out, 'node', name), 0o755);
}
console.log(`局域网版打好了：${out}`);
