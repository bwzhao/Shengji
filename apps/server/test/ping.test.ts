/** 延迟显示：ping 带的时间原样带回；心跳探测不带时间也照常回 pong。没发 hello 时也能 ping。 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@shengji/protocol';
import { startServer, type RunningServer } from '../src/server.ts';

let server: RunningServer;
beforeAll(async () => { server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false }); });
afterAll(async () => { await server.close(); });

function next(ws: WebSocket, t: ServerMessage['t']): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const on = (d: WebSocket.RawData) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      if (m.t === t) { ws.off('message', on); resolve(m); }
    };
    ws.on('message', on);
  });
}

it('ping 带的时间原样带回，不带就不带', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'ping', at: 1234.5 }));
  expect(await next(ws, 'pong')).toEqual({ t: 'pong', at: 1234.5 });
  ws.send(JSON.stringify({ t: 'hello', name: '测延迟' }));
  await next(ws, 'welcome');
  ws.send(JSON.stringify({ t: 'ping', at: 99 }));
  expect(await next(ws, 'pong')).toEqual({ t: 'pong', at: 99 });
  ws.send(JSON.stringify({ t: 'ping' }));
  expect(await next(ws, 'pong')).toEqual({ t: 'pong' });
  ws.close();
});
