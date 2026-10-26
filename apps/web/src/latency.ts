/** 延迟显示：每隔几秒量一次到服务器一个来回的时间，取最近几次的中位数，免得一次抖动就跳。 */

/** 留几次结果算中位数 */
export const LATENCY_SAMPLES = 3;
/** 隔多久量一次 */
export const LATENCY_INTERVAL_MS = 5000;

export function medianLatency(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** 好、一般、差：打牌一来回 150 毫秒以内感觉不到，300 毫秒以上能感觉到停顿 */
export function latencyLevel(ms: number): 'good' | 'ok' | 'bad' {
  return ms < 150 ? 'good' : ms < 300 ? 'ok' : 'bad';
}
