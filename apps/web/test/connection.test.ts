import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectSocket } from '../src/connection.ts';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: string) { this.onmessage?.({ data }); }
}
let page: EventTarget & { visibilityState: string };
let win: EventTarget;
let connection: ReturnType<typeof connectSocket>;
const connected = vi.fn();
const received = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  FakeSocket.instances = [];
  win = new EventTarget();
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', page);
  connected.mockClear(); received.mockClear();
  connection = connectSocket({ url: () => 'ws://test/ws', onConnected: connected,
    onOpen: () => { connection.send('{"t":"hello","token":"saved","name":"me"}'); },
    onMessage: received });
  vi.advanceTimersByTime(0);
});
afterEach(() => { connection.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const latest = () => FakeSocket.instances.at(-1)!;
function ready() { const ws = latest(); ws.open(); ws.message('{"t":"welcome"}'); return ws; }

it('reconnects a silently dead OPEN socket and restores the session automatically', () => {
  const old = ready();
  vi.advanceTimersByTime(20000);
  expect(old.sent.at(-1)).toBe('{"t":"ping"}');
  vi.advanceTimersByTime(10000);
  expect(connected).toHaveBeenLastCalledWith(false);
  expect(old.readyState).toBe(3);
  vi.advanceTimersByTime(500);
  const fresh = ready();
  expect(fresh).not.toBe(old);
  expect(fresh.sent[0]).toContain('"token":"saved"');
  fresh.message('{"t":"state","seq":2}');
  fresh.message('{"t":"state","seq":3}');
  expect(received).toHaveBeenLastCalledWith('{"t":"state","seq":3}');
});

it('keeps a healthy idle connection when pong or state arrives', () => {
  const ws = ready();
  vi.advanceTimersByTime(20000);
  ws.message('{"t":"pong"}');
  vi.advanceTimersByTime(20000);
  ws.message('{"t":"state"}');
  vi.advanceTimersByTime(10000);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(connected).toHaveBeenLastCalledWith(true);
});

it.each(['connecting', 'open without hello reply'])('times out %s', state => {
  if (state !== 'connecting') latest().open();
  vi.advanceTimersByTime(10500);
  expect(FakeSocket.instances).toHaveLength(2);
});

it('ignores stale socket callbacks and cancels pending retries on stop', () => {
  const old = ready();
  const staleClose = old.onclose!, staleOpen = old.onopen!, staleMessage = old.onmessage!;
  old.close();
  vi.advanceTimersByTime(500);
  ready();
  received.mockClear(); connected.mockClear();
  staleClose(); staleOpen(); staleMessage({ data: 'stale state' });
  expect(received).not.toHaveBeenCalled();
  expect(connected).not.toHaveBeenCalled();
  latest().close();
  connection.stop();
  win.dispatchEvent(new Event('online'));
  page.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(60000);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['online', 'pageshow', 'visibilitychange'])('recovers immediately on %s after a suspended page', event => {
  const old = ready();
  // Advance wall clock without running timers, as when the browser freezes a tab.
  vi.setSystemTime(Date.now() + 60000);
  (event === 'visibilitychange' ? page : win).dispatchEvent(new Event(event));
  expect(FakeSocket.instances).toHaveLength(2);
  expect(old.readyState).toBe(3);
  ready();
});

it('repeated resume events do not postpone a pending heartbeat timeout', () => {
  ready();
  win.dispatchEvent(new Event('online'));
  vi.advanceTimersByTime(9000);
  win.dispatchEvent(new Event('pageshow'));
  vi.advanceTimersByTime(1500);
  expect(FakeSocket.instances).toHaveLength(2);
});

it('does not reconnect in the background just because visibility changed', () => {
  ready();
  page.visibilityState = 'hidden';
  page.dispatchEvent(new Event('visibilitychange'));
  expect(FakeSocket.instances).toHaveLength(1);
});

it('backs off repeated failures and resets backoff only after a response', () => {
  latest().open(); latest().onerror?.();
  vi.advanceTimersByTime(500);
  latest().open(); latest().onerror?.();
  vi.advanceTimersByTime(999);
  expect(FakeSocket.instances).toHaveLength(2);
  vi.advanceTimersByTime(1);
  ready().close();
  vi.advanceTimersByTime(500);
  expect(FakeSocket.instances).toHaveLength(4);
});

it('recovers a send exception without replaying a possibly delivered game action', () => {
  const old = ready();
  old.send = () => { throw new Error('network changed'); };
  expect(connection.send('{"t":"play","cards":["S2-0"]}')).toBe(false);
  vi.advanceTimersByTime(500);
  const fresh = ready();
  expect(fresh.sent).toHaveLength(1);
  expect(fresh.sent[0]).toContain('"t":"hello"');
});

it('cleans up the initial connection timer during StrictMode setup/cleanup', () => {
  connection.stop();
  const count = FakeSocket.instances.length;
  const temporary = connectSocket({ url: () => 'ws://test/ws', onConnected: connected,
    onOpen: vi.fn(), onMessage: received });
  temporary.stop();
  vi.advanceTimersByTime(60000);
  expect(FakeSocket.instances).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});
