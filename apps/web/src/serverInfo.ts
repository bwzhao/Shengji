/** 服务端信息：是不是局域网版、别人该用哪个地址进来。邀请链接和二维码用。 */
import { useEffect, useState } from 'react';
import type { ServerInfo } from '@shengji/protocol';

let request: Promise<ServerInfo> | null = null;

export function useServerInfo(): ServerInfo | null {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    request ??= fetch('/api/server-info')
      .then((r) => (r.ok ? (r.json() as Promise<ServerInfo>) : { lan: null }))
      .catch(() => ({ lan: null }));
    let alive = true;
    void request.then((i) => { if (alive) setInfo(i); });
    return () => { alive = false; };
  }, []);
  return info;
}

/**
 * 邀请链接的开头：一般就是现在的网址；局域网版的房主在自己电脑上用 localhost 打开时，
 * 别人用不了 localhost，换成这台电脑的局域网地址
 */
export function inviteOrigin(info: ServerInfo | null): string {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return local && info?.lan?.[0] ? info.lan[0] : location.origin;
}

/** 复制文字；局域网版是 http 地址，浏览器不给剪贴板接口，退回老办法 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 退回老办法 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* 复制不了 */ }
  ta.remove();
  return ok;
}
