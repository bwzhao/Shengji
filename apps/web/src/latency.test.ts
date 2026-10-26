import { describe, expect, it } from 'vitest';
import { latencyLevel, medianLatency } from './latency.ts';

describe('延迟显示', () => {
  it('取中位数，一次抖动不影响', () => {
    expect(medianLatency([])).toBeNull();
    expect(medianLatency([210.4])).toBe(210);
    expect(medianLatency([200, 1500, 220])).toBe(220);
    expect(medianLatency([100, 300])).toBe(200);
  });

  it('按毫秒分好、一般、差', () => {
    expect(latencyLevel(80)).toBe('good');
    expect(latencyLevel(150)).toBe('ok');
    expect(latencyLevel(299)).toBe('ok');
    expect(latencyLevel(300)).toBe('bad');
  });
});
