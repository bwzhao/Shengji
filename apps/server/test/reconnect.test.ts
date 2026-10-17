import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@shengji/protocol';
import { createGame, defaultConfig } from '@shengji/engine';
import { startServer, type RunningServer } from '../src/server.ts';

let server: RunningServer | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await server?.close();
});

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
  clients.push(ws);
  const inbox: ServerMessage[] = [];
  ws.on('message', data => inbox.push(JSON.parse(data.toString()) as ServerMessage));
  await new Promise<void>(resolve => ws.once('open', resolve));
  return { ws, inbox, send: (msg: unknown) => ws.send(JSON.stringify(msg)) };
}

it.each([false, true])('late old-socket close preserves replacement connection (started=%s)', async started => {
  server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false,
    roomOptions: { dealIntervalMs: 100000, declareGraceMs: 100000, botDelayMs: 100000, searchBudgetMs: 5 } });
  const old = await connect();
  old.send({ t: 'hello', name: 'reconnecting' });
  await expect.poll(() => old.inbox.some(m => m.t === 'welcome')).toBe(true);
  const welcome = old.inbox.find(m => m.t === 'welcome')!;
  if (welcome.t !== 'welcome') throw new Error('missing welcome');
  old.send({ t: 'createRoom', players: 4 });
  await expect.poll(() => server!.registry.rooms.size).toBe(1);
  const room = [...server.registry.rooms.values()][0]!;
  if (started) room.state = createGame(defaultConfig(4), 'reconnect');
  const fresh = await connect();
  fresh.send({ t: 'hello', name: 'reconnecting', token: welcome.token });
  await expect.poll(() => fresh.inbox.some(m => m.t === 'room' && m.room?.you === 0)).toBe(true);
  const replacement = room.members.get(welcome.token)!.socket;
  const closed = new Promise<void>(resolve => old.ws.once('close', resolve));
  old.ws.close();
  await closed;
  // A ping round trip orders this assertion after the old close has reached the server.
  fresh.send({ t: 'ping' });
  await expect.poll(() => fresh.inbox.some(m => m.t === 'pong')).toBe(true);
  expect(room.members.get(welcome.token)!.socket === replacement).toBe(true);
  expect(room.seatOf(welcome.token)).toBe(0);
  fresh.inbox.length = 0;
  if (started) {
    // Two successive state changes must arrive after reconnection, without refresh.
    room.restartRound(welcome.token);
    room.restartRound(welcome.token);
    await expect.poll(() => fresh.inbox.filter(m => m.t === 'state').length).toBe(2);
  } else {
    room.addBot(welcome.token, 1);
    await expect.poll(() => fresh.inbox.some(m => m.t === 'room' && m.room?.seats[1]?.isBot)).toBe(true);
  }
  const freshClosed = new Promise<void>(resolve => fresh.ws.once('close', resolve));
  fresh.ws.close();
  await freshClosed;
  await expect.poll(() => room.members.get(welcome.token)!.socket).toBeNull();
  expect(room.seatOf(welcome.token)).toBe(started ? 0 : null);
});

it('answers heartbeat before login without creating a session', async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false });
  const client = await connect();
  client.send({ t: 'ping' });
  await expect.poll(() => client.inbox.some(m => m.t === 'pong')).toBe(true);
  expect(server.registry.sessions.size).toBe(0);
  expect(client.inbox.some(m => m.t === 'error')).toBe(false);
});

it('two of four players reconnect while all four keep receiving live deals', async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false,
    roomOptions: { dealIntervalMs: 30, declareGraceMs: 100000, botDelayMs: 100000, searchBudgetMs: 5 } });
  const original = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const tokens: string[] = [];
  for (const [seat, client] of original.entries()) {
    client.send({ t: 'hello', name: `player-${seat}` });
    await expect.poll(() => client.inbox.some(m => m.t === 'welcome')).toBe(true);
    const welcome = client.inbox.find(m => m.t === 'welcome')!;
    if (welcome.t !== 'welcome') throw new Error('missing welcome');
    tokens.push(welcome.token);
  }
  original[0]!.send({ t: 'createRoom', players: 4 });
  await expect.poll(() => server!.registry.rooms.size).toBe(1);
  const room = [...server.registry.rooms.values()][0]!;
  for (let seat = 1; seat < 4; seat++) {
    original[seat]!.send({ t: 'joinRoom', code: room.code });
    original[seat]!.send({ t: 'sit', seat });
  }
  await expect.poll(() => room.seats.every(Boolean)).toBe(true);
  original[0]!.send({ t: 'start' });
  await expect.poll(() => original.every(c => c.inbox.some(m => m.t === 'state' && m.events.some(e => e.type === 'cardDealt')))).toBe(true);

  const resumed = await Promise.all([connect(), connect()]);
  for (const [i, client] of resumed.entries()) client.send({ t: 'hello', name: `player-${i + 1}`, token: tokens[i + 1] });
  await expect.poll(() => resumed.every(c => c.inbox.some(m => m.t === 'state'))).toBe(true);
  const sockets = [1, 2].map(seat => room.members.get(tokens[seat]!)!.socket);
  await Promise.all([1, 2].map(seat => new Promise<void>(resolve => {
    original[seat]!.ws.once('close', resolve);
    original[seat]!.ws.close();
  })));
  for (const client of resumed) client.send({ t: 'ping' });
  await expect.poll(() => resumed.every(c => c.inbox.some(m => m.t === 'pong'))).toBe(true);
  expect([1, 2].every((seat, i) => room.members.get(tokens[seat]!)!.socket === sockets[i])).toBe(true);

  const live = [original[0]!, ...resumed, original[3]!];
  for (const client of live) client.inbox.length = 0;
  await expect.poll(() => live.every(c => c.inbox.filter(m => m.t === 'state' && m.events.some(e => e.type === 'cardDealt')).length >= 3)).toBe(true);
  for (let seat = 0; seat < 4; seat++) expect(room.seatOf(tokens[seat]!)).toBe(seat);
});
