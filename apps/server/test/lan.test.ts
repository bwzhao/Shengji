/** 局域网版：找局域网地址、/api/server-info 告诉网页是不是局域网版和别人该用的地址。 */
import type { NetworkInterfaceInfo } from 'node:os';
import { afterAll, expect, it } from 'vitest';
import type { ServerInfo } from '@shengji/protocol';
import { lanAddresses } from '../src/lanAddress.ts';
import { startServer, type RunningServer } from '../src/server.ts';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo;
const v6 = (address: string) => ({ address, family: 'IPv6', internal: false }) as NetworkInterfaceInfo;

it('只要 IPv4 局域网地址：跳过回环、IPv6、没拿到地址时的 169.254，私网段排前面，去重', () => {
  expect(lanAddresses({
    lo: [v4('127.0.0.1', true)],
    utun: [v4('100.64.3.9')],
    en0: [v6('fe80::1'), v4('192.168.1.23')],
    en5: [v4('169.254.10.2')],
    eth1: [v4('10.0.0.5'), v4('192.168.1.23')],
    docker: [v4('172.17.0.1')],
  })).toEqual(['192.168.1.23', '10.0.0.5', '172.17.0.1', '100.64.3.9']);
  expect(lanAddresses({ lo: [v4('127.0.0.1', true)] })).toEqual([]);
});

const servers: RunningServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function info(lanUrls?: () => string[]): Promise<ServerInfo> {
  const server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false, lanUrls });
  servers.push(server);
  const res = await fetch(`http://127.0.0.1:${server.port}/api/server-info`);
  return await res.json() as ServerInfo;
}

it('线上版：lan 为 null', async () => {
  expect(await info()).toEqual({ lan: null });
});

it('局域网版：每次问都现查地址（换了 WiFi 会变）', async () => {
  let ips = ['http://192.168.1.23:3000'];
  const server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false, lanUrls: () => ips });
  servers.push(server);
  const get = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/server-info`)).json()) as ServerInfo;
  expect(await get()).toEqual({ lan: ['http://192.168.1.23:3000'] });
  ips = [];
  expect(await get()).toEqual({ lan: [] });
});
