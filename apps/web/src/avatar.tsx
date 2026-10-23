/**
 * 头像：注册用户可以上传自己的照片（src）；机器人用电影明星的名字，照片文件放在 public/avatars 里（来源与授权见同目录 CREDITS.md）；
 * 其他名字和真人玩家显示名字首字的圆形色块。
 */
import { useState } from 'react';
import files from './avatarFiles.json';

const AVATARS = files as Record<string, string>;

export function avatarUrl(name: string): string | null {
  const file = AVATARS[name];
  return file ? `/avatars/${encodeURIComponent(file)}` : null;
}

const HUES = [14, 36, 92, 160, 200, 250, 290, 330];
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length] as number;
}

export function Avatar({ name, isBot, src, size = 28 }: { name: string; isBot: boolean; src?: string | null; size?: number }) {
  const url = src ?? (isBot ? avatarUrl(name) : null);
  // 头像刚被删掉、网址失效时退回名字首字
  const [broken, setBroken] = useState<string | null>(null);
  const style: React.CSSProperties = { width: size, height: size, fontSize: Math.round(size * 0.46) };
  if (url && url !== broken) return <img className="avatar" src={url} alt={name} style={style} loading="lazy" onError={() => setBroken(url)} />;
  return <span className="avatar avatar-text" style={{ ...style, background: `hsl(${hueOf(name)} 40% 38%)` }}>{name.slice(0, 1)}</span>;
}
