import { loadBeliefModels, loadValueModels } from '@shengji/engine/node';
import { startServer } from './server.ts';

// 线上只对四人模式启用手牌推断网络：四人有对打验证（每轮升级 0.430 对 0.369），五六人只有离线验证。
// 搜索 worker 继承这个环境变量，装同样的模型
process.env.BELIEF_PLAYERS ??= '4';
const beliefLoaded = loadBeliefModels();
// 完美信息价值网络：只有四人对家模式（阵营从开局就公开）可用；VALUE=0 关掉
process.env.VALUE_PLAYERS ??= '4';
const valueLoaded = loadValueModels();

const port = Number(process.env.PORT ?? 3000);
const snapshotDir = process.env.SNAPSHOT_DIR ?? '.data';
// 管理员的登录名，逗号分隔
const adminUsernames = (process.env.ADMIN_USERNAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const running = await startServer({ port, snapshotDir, adminUsernames }) as Awaited<ReturnType<typeof startServer>> & { staticDir: string | null };
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void running.close().then(() => process.exit(0)); });
}
console.log(`手牌推断模型：${beliefLoaded.length ? beliefLoaded.map((n) => `${n} 人`).join('、') : '无'}`);
console.log(`价值网络：${valueLoaded.length ? valueLoaded.map((n) => `${n} 人`).join('、') : '无'}`);
console.log(`服务端已启动 http://localhost:${running.port}  ws://localhost:${running.port}/ws  静态文件：${running.staticDir ?? '未构建'}`);
