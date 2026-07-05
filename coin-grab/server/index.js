import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { handleMessage } from './roomManager.js';
import { startHeartbeat } from './heartbeat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(join(__dirname, '../client')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.roomId = null;
  ws.lastPong = Date.now();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'PONG') {
      ws.isAlive = true;
      ws.lastPong = Date.now();
    }
    handleMessage(ws, msg, wss);
  });

  ws.on('close', () => {
    handleMessage(ws, { type: 'DISCONNECT' }, wss);
  });
});

server.listen(3000, () => {
  startHeartbeat(wss);
  console.log('Server running on http://localhost:3000');
});
