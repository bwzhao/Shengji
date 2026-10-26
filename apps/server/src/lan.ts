/**
 * 局域网版的入口：双击启动脚本后用自带的 Node 运行打包好的这个文件（见 apps/server/lan）。
 * 在这台电脑上开服务器，同一个 WiFi 下的人用浏览器打开这台电脑的地址就能一起玩，不需要外网。
 * 目录结构：app/（打包后的服务端）、web/（前端）、models/（机器人的模型）、data/（存档和账号，第一次运行时建）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBeliefModels, loadValueModels } from '@shengji/engine/node';
import { lanAddresses } from './lanAddress.ts';
import { startServer } from './server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 和线上一样：手牌推断和价值网络只给四人局用
process.env.BELIEF_PLAYERS ??= '4';
process.env.VALUE_PLAYERS ??= '4';
const models = [...loadBeliefModels(), ...loadValueModels()];
if (models.length === 0) console.log('没找到机器人模型（models 目录），加强版机器人会弱一些');

/** 从 start 开始找一个没被占用的端口 */
function freePort(start: number): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => { void freePort(start + 1).then(done); });
    probe.listen(start, '0.0.0.0', () => probe.close(() => done(start)));
  });
}

function openBrowser(url: string): void {
  if (process.env.NO_BROWSER === '1') return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch { /* 打不开就让人自己打开 */ }
}

const port = Number(process.env.PORT) || await freePort(3000);
const webDir = process.env.WEB_DIR ?? join(root, 'web');
const lanUrls = () => lanAddresses(networkInterfaces()).map((ip) => `http://${ip}:${port}`);
const running = await startServer({
  port,
  snapshotDir: process.env.SNAPSHOT_DIR ?? join(root, 'data'),
  webDir: existsSync(webDir) ? webDir : undefined,
  adminUsernames: (process.env.ADMIN_USERNAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  lanUrls,
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void running.close().then(() => process.exit(0)); });
}

const urls = lanUrls();
console.log('');
console.log('  升级·找朋友 局域网版已经启动');
console.log('');
console.log(`  这台电脑：http://localhost:${port}`);
if (urls.length) {
  console.log('  同一个 WiFi 下的其他人用手机或电脑打开：');
  for (const u of urls) console.log(`    ${u}`);
  console.log('  （网页里也有二维码，扫码就能进）');
} else {
  console.log('  没找到局域网地址：检查这台电脑是不是连上了 WiFi 或网线');
}
console.log('');
console.log('  玩的时候不要关这个窗口；关掉窗口服务器就停了。');
console.log('');
openBrowser(`http://localhost:${port}`);
