/** One active socket, bounded reconnects, and detection of silently dead connections. */
export function connectSocket(options: {
  url: () => string;
  onConnected: (connected: boolean) => void;
  onOpen: () => void;
  onMessage: (data: string) => void;
}) {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry = 500;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;

  const current = (ws: WebSocket) => !stopped && socket === ws;
  const clearTimers = () => {
    clearTimeout(deadline);
    clearTimeout(heartbeat);
    deadline = heartbeat = undefined;
  };
  const retire = () => {
    clearTimers();
    const previous = socket;
    socket = null;
    if (previous) {
      previous.onopen = previous.onclose = previous.onerror = previous.onmessage = null;
      previous.close();
    }
    options.onConnected(false);
  };
  const failed = () => {
    if (stopped) return;
    retire();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
  const send = (data: string): boolean => {
    if (stopped || socket?.readyState !== WebSocket.OPEN) return false;
    try { socket.send(data); return true; }
    catch { failed(); return false; }
  };
  const probe = (timeoutMs = 10000) => {
    // A pending deadline means a handshake or an earlier probe is already being timed.
    if (!socket || deadline !== undefined) return;
    // CLOSING or CLOSED before onclose fired: don't wait for the browser to report it.
    if (socket.readyState !== WebSocket.OPEN) { failed(); return; }
    clearTimeout(heartbeat);
    heartbeat = undefined;
    // Any server message proves the connection is alive; silence until the deadline does not.
    deadline = setTimeout(failed, timeoutMs);
    send(JSON.stringify({ t: 'ping' }));
  };
  function connect() {
    retryTimer = undefined;
    if (stopped) return;
    try {
      const ws = new WebSocket(options.url());
      socket = ws;
      // Covers both a stalled HTTP upgrade and an open socket with no hello reply.
      deadline = setTimeout(failed, 10000);
      ws.onopen = () => {
        if (!current(ws)) return;
        options.onConnected(true);
        options.onOpen();
      };
      ws.onmessage = ev => {
        if (!current(ws)) return;
        retry = 500;
        clearTimers();
        heartbeat = setTimeout(probe, 20000);
        options.onMessage(String(ev.data));
      };
      ws.onclose = ws.onerror = () => { if (current(ws)) failed(); };
    } catch { failed(); }
  }
  const resume = () => {
    if (stopped) return;
    // Waiting out a retry backoff: the page or network is back, so try now.
    if (!socket) {
      clearTimeout(retryTimer);
      connect();
      return;
    }
    // Never close a socket that may still be healthy: the server unseats a lobby player
    // whose socket closes. Ask instead, and reconnect only if no reply comes back.
    probe(5000);
  };
  const visible = () => { if (document.visibilityState === 'visible') resume(); };
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', visible);
  // Defer to let the owner store the controller before onOpen uses send().
  retryTimer = setTimeout(connect, 0);
  return {
    send,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      retire();
      window.removeEventListener('online', resume);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', visible);
    },
  };
}
