/** 局域网版：找出这台电脑在局域网里的 IPv4 地址，家里和手机热点常见的私网段排在前面。 */
import type { NetworkInterfaceInfo } from 'node:os';

/** 私网地址：192.168.x.x、10.x.x.x、172.16~31.x.x */
function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 192 && b === 168 || a === 10 || (a === 172 && b >= 16 && b <= 31);
}

export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const ips: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      // 跳过本机回环和没拿到地址时系统自己配的 169.254.x.x
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      if (!ips.includes(i.address)) ips.push(i.address);
    }
  }
  return ips.sort((x, y) => Number(isPrivate(y)) - Number(isPrivate(x)));
}
