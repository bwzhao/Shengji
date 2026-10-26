/** 延迟显示：到服务器一个来回的毫秒数，绿、黄、红三档 */
import { latencyLevel } from '../latency.ts';

export function Latency({ ms, className = '' }: { ms: number | null; className?: string }) {
  const level = ms === null ? '' : latencyLevel(ms);
  return (
    <span className={`latency ${level} ${className}`} title="到服务器一个来回的时间。150 毫秒以内很顺，300 毫秒以上会感觉到停顿">
      <span className="latency-dot" />{ms === null ? '— ms' : `${ms} ms`}
    </span>
  );
}
