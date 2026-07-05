const PING_INTERVAL_MS = 5000;
const TIMEOUT_MS = 15000;

export function startHeartbeat(wss) {
  setInterval(() => {
    const now = Date.now();
    wss.clients.forEach((ws) => {
      if (ws.lastPong && now - ws.lastPong > TIMEOUT_MS) {
        ws.terminate(); // 触发 close 事件 → handleDisconnect
        return;
      }
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'PING', data: { timestamp: now } }));
      }
    });
  }, PING_INTERVAL_MS);
}
