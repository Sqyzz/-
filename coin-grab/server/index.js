import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { handleMessage } from './roomManager.js';

const app = express();
app.use(express.static('../client'));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg, wss);
  });

  ws.on('close', () => {
    handleMessage(ws, { type: 'DISCONNECT' }, wss);
  });
});

server.listen(3000, () => console.log('Server running on http://localhost:3000'));
