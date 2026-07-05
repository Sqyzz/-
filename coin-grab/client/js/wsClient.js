let ws = null;
const handlers = new Map(); // type → Set<handler>

export function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);

    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);

    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      // 心跳自动回应
      if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', data: { timestamp: msg.data.timestamp } }));
        return;
      }

      const set = handlers.get(msg.type);
      if (set) set.forEach(fn => fn(msg.data));
    };

    ws.onclose = () => {
      const set = handlers.get('CLOSE');
      if (set) set.forEach(fn => fn());
    };
  });
}

export function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function on(type, handler) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(handler);
}

export function off(type, handler) {
  handlers.get(type)?.delete(handler);
}
