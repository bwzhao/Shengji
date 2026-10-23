/**
 * 上传头像的检查：浏览器已经裁成正方形、缩到 160×160 再压成 WebP 或 JPEG，服务端不信它，
 * 只认文件头是 JPEG / PNG / WebP 的图，限制字节数和宽高（防止小文件解码成超大图卡住别人的浏览器）。
 */

/** 存下来的头像最多这么大；160×160 的 WebP 一般 5 到 15 KB */
export const AVATAR_MAX_BYTES = 64 * 1024;
/** 宽高都不能超过这么多像素 */
export const AVATAR_MAX_SIDE = 512;

export type AvatarType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface SniffedImage {
  readonly type: AvatarType;
  readonly ext: 'jpg' | 'png' | 'webp';
  readonly width: number;
  readonly height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 从文件头认出图片格式和宽高；认不出返回 null */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length >= 24 && PNG_SIG.every((b, i) => buf[i] === b) && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const size = webpSize(buf);
    return size ? { type: 'image/webp', ext: 'webp', ...size } : null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const size = jpegSize(buf);
    return size ? { type: 'image/jpeg', ext: 'jpg', ...size } : null;
  }
  return null;
}

function webpSize(buf: Buffer): { width: number; height: number } | null {
  switch (buf.toString('latin1', 12, 16)) {
    case 'VP8 ': // 有损：关键帧起始码后面是 14 位宽高
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    case 'VP8L': { // 无损：签名 0x2f 后面是两个 14 位的「宽减一、高减一」
      if (buf[20] !== 0x2f) return null;
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X': // 扩展格式：24 位的「宽减一、高减一」
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

/** 顺着 JPEG 的段往后找帧头（SOF），宽高在里面 */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1] as number;
    if (marker === 0xff) { i++; continue; }
    // SOF0..SOF15，除了 DHT(C4)、JPG(C8)、DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    // 没有长度的标记：RST0..7、TEM
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    // 图像数据开始了还没见到帧头
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** 检查上传的头像，合格返回格式，不合格返回提示 */
export function checkAvatar(buf: Buffer): SniffedImage | string {
  if (buf.length === 0) return '没收到图片';
  if (buf.length > AVATAR_MAX_BYTES) return `头像太大了，压缩后要在 ${AVATAR_MAX_BYTES / 1024} KB 以内`;
  const img = sniffImage(buf);
  if (!img) return '只支持 JPG、PNG、WebP 格式的图片';
  if (img.width < 1 || img.height < 1 || img.width > AVATAR_MAX_SIDE || img.height > AVATAR_MAX_SIDE) {
    return `头像宽高要在 ${AVATAR_MAX_SIDE} 像素以内`;
  }
  return img;
}
