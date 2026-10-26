/** 二维码：扫码打开链接（邀请进房、局域网版的地址） */
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function QrCode({ text, size = 148 }: { text: string; size?: number }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="qr" style={{ width: size, height: size }} role="img" aria-label={`二维码：${text}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}
