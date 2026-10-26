/**
 * 并行搜索：把采样分给多个 worker 线程同时跑，主线程负责候选生成、逐轮淘汰和选优。
 * worker 起不来时自动退回单线程。
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  chooseBest, dealerCandidates, playCandidates, pruneCandidates, runSearchBatch,
  type Action, type GameState, type Rng, type SearchBatchJob, type SearchBatchResult, type SearchOptions, type Seat,
} from '@shengji/engine';

interface Pending { resolve: (r: SearchBatchResult) => void; reject: (e: Error) => void }

export interface ParallelSearchResult {
  readonly action: Action;
  readonly samples: number;
  readonly candidates: number;
  readonly elapsedMs: number;
  readonly workers: number;
}

export class SearchPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private rr = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      try {
        // 平时用 tsx 直接跑 .ts；局域网版打包后 worker 是旁边的 searchWorker.mjs
        const w = new Worker(new URL(import.meta.url.endsWith('.ts') ? './searchWorker.ts' : './searchWorker.mjs', import.meta.url));
        w.on('message', (m: { id: number; result?: SearchBatchResult; error?: string }) => {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.result) p.resolve(m.result);
          else p.reject(new Error(m.error ?? 'worker 未返回结果'));
        });
        w.on('error', (err) => {
          console.error('搜索 worker 出错：', err.message);
          for (const [id, p] of this.pending) { p.reject(err); this.pending.delete(id); }
        });
        w.unref();
        this.workers.push(w);
      } catch (err) {
        console.error('搜索 worker 启动失败，退回单线程：', (err as Error).message);
        break;
      }
    }
  }

  get size(): number {
    return this.workers.length;
  }

  private dispatch(job: SearchBatchJob): Promise<SearchBatchResult> {
    const w = this.workers[this.rr++ % this.workers.length];
    if (!w) return Promise.resolve(runSearchBatch(job));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, job });
    });
  }

  /**
   * 对一组候选动作做并行采样推演。每一轮给每个 worker 派 perWorker 个种子，
   * 合并后逐轮淘汰，直到预算用完。
   */
  async search(state: GameState, seat: Seat, actions: readonly Action[], tieBreak: readonly number[], rng: Rng, opts: SearchOptions): Promise<ParallelSearchResult> {
    const t0 = Date.now();
    const n = actions.length;
    if (n <= 1) return { action: actions[0] as Action, samples: 0, candidates: n, elapsedMs: 0, workers: this.size };
    const sums = new Array<number>(n).fill(0);
    const counts = new Array<number>(n).fill(0);
    let alive = actions.map((_, i) => i);
    let samples = 0;
    const lanes = Math.max(1, this.size);
    // 每轮给每个 worker 派几个种子：采样慢时 2 个，采样快（有价值网络）时逐轮加倍，摊薄线程间收发消息的开销
    let perWorker = 2;
    while (samples < opts.maxSamples && (samples < opts.minSamples || Date.now() - t0 <= opts.timeBudgetMs)) {
      const roundStart = Date.now();
      const jobs: SearchBatchJob[] = [];
      for (let w = 0; w < lanes && samples + jobs.length * perWorker < opts.maxSamples; w++) {
        const seeds = Array.from({ length: perWorker }, () => `${rng.next()}`);
        jobs.push({ state, seat, actions, alive, seeds });
      }
      let results: SearchBatchResult[];
      try {
        results = await Promise.all(jobs.map((j) => this.dispatch(j)));
      } catch {
        results = jobs.map((j) => runSearchBatch(j));
      }
      for (const r of results) {
        for (let i = 0; i < n; i++) { sums[i]! += r.sums[i]!; counts[i]! += r.counts[i]!; }
        samples += r.samples;
      }
      alive = pruneCandidates(alive, sums, counts, samples, tieBreak);
      if (alive.length === 1) break;
      const roundMs = Date.now() - roundStart;
      if (roundMs < 40 && perWorker < 64) perWorker *= 2;
    }
    const best = chooseBest(alive, sums, counts, tieBreak);
    return { action: actions[best] as Action, samples, candidates: n, elapsedMs: Date.now() - t0, workers: this.size };
  }

  /** 出牌 */
  searchPlay(state: GameState, seat: Seat, rng: Rng, opts: SearchOptions): Promise<ParallelSearchResult> {
    const { actions, heuristics } = playCandidates(state, seat, rng, opts.maxCandidates);
    return this.search(state, seat, actions, heuristics, rng, opts);
  }

  /** 扣底或叫朋友 */
  searchDealer(state: GameState, seat: Seat, rng: Rng, opts: SearchOptions): Promise<ParallelSearchResult> {
    const actions = dealerCandidates(state, seat);
    const tie = actions.map((_, i) => -i); // 第二版排序靠前的优先
    return this.search(state, seat, actions, tie, rng, opts);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
  }
}

export function defaultPoolSize(): number {
  const env = Number(process.env.SEARCH_WORKERS);
  if (Number.isFinite(env) && env >= 0) return env;
  return Math.max(1, availableParallelism() - 1);
}

let shared: SearchPool | null = null;

/** 进程内共享一个线程池 */
export function getSearchPool(): SearchPool {
  if (!shared) {
    shared = new SearchPool(defaultPoolSize());
    console.log(`搜索线程池：${shared.size} 个 worker`);
  }
  return shared;
}

export async function closeSearchPool(): Promise<void> {
  if (shared) { await shared.close(); shared = null; }
}
