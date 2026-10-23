/**
 * 上传头像前在浏览器里处理照片：从中间裁成正方形，缩到 160×160（牌桌上头像最大 44 像素，三倍屏也够清楚），
 * 压成 WebP（浏览器不支持就用 JPEG），一般只有 5 到 15 KB。手机拍的几 MB 大照片可以直接选。
 */

/** 选的原图最多这么大，再大的解码太慢 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SIDE = 160;
/** 和服务端一致：压完要在 64 KB 以内 */
const MAX_BYTES = 64 * 1024;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图片打不开，换一张 JPG 或 PNG 试试')); };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function canvasOf(side: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持处理图片');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return [canvas, ctx];
}

/** 把选的照片处理成要上传的 base64 */
export async function avatarFromFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error('照片太大了，选一张 20 MB 以内的');
  const img = await loadImage(file);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error('这张图片打不开，换一张 JPG 或 PNG 试试');
  // 裁出中间的正方形，每次缩一半缩到接近目标大小，比一步缩到底清楚
  const crop = Math.min(w, h);
  let side = Math.max(SIDE, Math.min(crop, SIDE * 2 ** Math.floor(Math.log2(crop / SIDE))));
  const [first, ctx] = canvasOf(side);
  let canvas = first;
  // 透明的 PNG 压成 JPEG 时底色是黑的，先铺白
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(img, (w - crop) / 2, (h - crop) / 2, crop, crop, 0, 0, side, side);
  while (side > SIDE) {
    const next = Math.max(SIDE, Math.round(side / 2));
    const [smaller, smallerCtx] = canvasOf(next);
    smallerCtx.drawImage(canvas, 0, 0, side, side, 0, 0, next, next);
    canvas = smaller;
    side = next;
  }
  let blob = await toBlob(canvas, 'image/webp', 0.85);
  // Safari 不会编码 WebP，会悄悄给 PNG，改用 JPEG
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.85);
  if (!blob) throw new Error('图片处理失败，换一张试试');
  if (blob.size > MAX_BYTES) throw new Error('图片压缩后还是太大，换一张试试');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
