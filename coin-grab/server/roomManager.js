import { nanoid } from 'nanoid';
import { startCountdown, cleanupRoomTimers } from './gameStateMachine.js';
import { claimCoin } from './coinManager.js';

const MAX_PLAYERS = 5;
const rooms = new Map(); // roomId → Room

export function getRoom(roomId) {
  return rooms.get(roomId);
}

export function broadcast(roomId, msg, wss) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const player of room.players.values()) {
    if (player.ws.readyState === 1 /* OPEN */) {
      player.ws.send(payload);
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function handleMessage(ws, msg, wss) {
  switch (msg.type) {
    case 'JOIN_ROOM':   return handleJoin(ws, msg.data, wss);
    case 'CLAIM_COIN':  return handleClaim(ws, msg.data, wss);
    case 'PONG':        return (ws.isAlive = true);
    case 'DISCONNECT':  return handleDisconnect(ws, wss);
  }
}

function handleJoin(ws, { roomId, playerName } = {}, wss) {
  if (!roomId || !playerName) {
    return send(ws, { type: 'ERROR', data: { code: 'INVALID_PARAMS', message: '缺少房间号或昵称' } });
  }

  let room = rooms.get(roomId);

  // 游戏进行中拒绝
  if (room && room.state === 'PLAYING') {
    return send(ws, { type: 'ERROR', data: { code: 'GAME_IN_PROGRESS', message: '游戏已开始，无法加入' } });
  }

  // 已开始倒计时但房间无人（上一次所有人都断开了）：清理掉，重建一个干净房间
  if (room && (room.state === 'ENDED' || room.players.size === 0)) {
    cleanupRoomTimers(room);
    rooms.delete(roomId);
    room = null;
  }

  if (!room) {
    room = {
      id: roomId,
      players: new Map(),
      state: 'WAITING',
      scores: new Map(),
    };
    rooms.set(roomId, room);
  }

  // 房间已满拒绝
  if (room.players.size >= MAX_PLAYERS) {
    return send(ws, { type: 'ERROR', data: { code: 'ROOM_FULL', message: '房间已满（最多5人）' } });
  }

  const playerId = nanoid(8);
  ws.playerId = playerId;
  ws.roomId = roomId;

  const player = { id: playerId, name: playerName, ws };
  room.players.set(playerId, player);
  room.scores.set(playerId, 0);

  // 回复加入确认 + 全量状态（附带服务端时间，用于前端计算时钟偏移）
  send(ws, { type: 'JOIN_ACK', data: { playerId, playerName, roomId, serverTime: Date.now() } });
  send(ws, {
    type: 'ROOM_STATE',
    data: {
      players: [...room.players.values()].map(p => ({ id: p.id, name: p.name })),
      state: room.state,
      countdown: null,
      scores: Object.fromEntries(room.scores),
    },
  });

  // 广播新玩家加入（排除自身）
  const joinMsg = { type: 'PLAYER_JOINED', data: { player: { id: playerId, name: playerName } } };
  const payload = JSON.stringify(joinMsg);
  for (const p of room.players.values()) {
    if (p.id !== playerId && p.ws.readyState === 1) p.ws.send(payload);
  }

  // 触发倒计时逻辑（Task 3 实现）
  startCountdown(room, wss);
}

function handleDisconnect(ws, wss) {
  const { playerId, roomId } = ws;
  if (!playerId || !roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  room.players.delete(playerId);
  room.scores.delete(playerId);

  broadcast(roomId, { type: 'PLAYER_LEFT', data: { playerId } }, wss);

  if (room.players.size === 0) {
    cleanupRoomTimers(room); // 清理倒计时/游戏定时器，避免孤儿定时器继续运行
    rooms.delete(roomId);
  }
}

// Task 4: handleClaim calls coinManager for atomic coin claiming
export function handleClaim(ws, data, wss) {
  if (!data) return;
  const { roomId, coinId } = data;
  const room = rooms.get(roomId);
  if (!room || room.state !== 'PLAYING') return;
  if (!ws.playerId) return;

  claimCoin(room, coinId, ws.playerId, wss);
  // 无论成功失败，后端不单独回复——COIN_CLAIMED 广播即为确认
  // 失败时前端依靠 COIN_CLAIMED 不到达来触发回滚
}
