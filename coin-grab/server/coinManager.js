import { nanoid } from 'nanoid';
import { broadcast } from './roomManager.js';

const MAX_ACTIVE_COINS = 3;
const COIN_TTL_MS = 8000; // 金币8秒后自动消失

export function startGameLoop(room, wss) {
  room._activeCoins = new Map();  // coinId → { id, row, col, spawnedAt, expireTimer }
  room._claimedCoins = new Set(); // 已被抢/已过期的金币 ID

  scheduleNextCoin(room, wss);
}

export function stopGameLoop(room) {
  clearTimeout(room._nextCoinTimer);
  // 清理所有金币的过期计时器
  if (room._activeCoins) {
    for (const coin of room._activeCoins.values()) {
      clearTimeout(coin.expireTimer);
    }
    room._activeCoins.clear();
  }
}

function scheduleNextCoin(room, wss) {
  if (room.state !== 'PLAYING') return;

  const delay = 1000 + Math.random() * 2000; // 1~3 秒随机间隔
  room._nextCoinTimer = setTimeout(() => {
    spawnCoin(room, wss);
    scheduleNextCoin(room, wss); // 生成下一枚
  }, delay);
}

function spawnCoin(room, wss) {
  if (room.state !== 'PLAYING') return;
  if (room._activeCoins.size >= MAX_ACTIVE_COINS) return;

  // 找一个没有金币的格子
  const occupied = new Set([...room._activeCoins.values()].map(c => `${c.row},${c.col}`));
  let row, col, key;
  let attempts = 0;
  do {
    row = Math.floor(Math.random() * 5);
    col = Math.floor(Math.random() * 5);
    key = `${row},${col}`;
    attempts++;
  } while (occupied.has(key) && attempts < 25);

  if (attempts >= 25) return; // 所有格子都满了（理论上不会，MAX_ACTIVE_COINS=3 << 25）

  const coinId = nanoid(12);
  const spawnedAt = Date.now();

  const expireTimer = setTimeout(() => {
    expireCoin(room, coinId, wss);
  }, COIN_TTL_MS);

  room._activeCoins.set(coinId, { id: coinId, row, col, spawnedAt, expireTimer });

  broadcast(room.id, {
    type: 'COIN_SPAWN',
    data: { coin: { id: coinId, row, col, spawnedAt } },
  }, wss);
}

function expireCoin(room, coinId, wss) {
  if (!room._activeCoins.has(coinId)) return; // 已被抢走
  room._activeCoins.delete(coinId);
  room._claimedCoins.add(coinId);
  broadcast(room.id, { type: 'COIN_EXPIRED', data: { coinId } }, wss);
}

/**
 * 原子抢夺金币
 *
 * 并发安全原因：Node.js 是单线程的，两个 WebSocket message 回调不会真正并发。
 * 在同一个同步帧内，_claimedCoins.has() → _claimedCoins.add() 是不可中断的，
 * 因此天然互斥——第一个到达的请求会把 coinId 放入 Set，
 * 后续请求执行 has() 时必然返回 true，直接拒绝。
 */
export function claimCoin(room, coinId, playerId, wss) {
  // ① 已被抢过或已过期
  if (room._claimedCoins.has(coinId)) {
    return { success: false, reason: 'ALREADY_CLAIMED' };
  }
  // ② 金币不在活跃列表
  if (!room._activeCoins.has(coinId)) {
    return { success: false, reason: 'COIN_NOT_FOUND' };
  }

  // ③ 原子占位（在单线程中这行与上面两行之间不会有其他代码插入）
  room._claimedCoins.add(coinId);
  const coin = room._activeCoins.get(coinId);
  clearTimeout(coin.expireTimer);
  room._activeCoins.delete(coinId);

  // ④ 加分
  const prev = room.scores.get(playerId) ?? 0;
  room.scores.set(playerId, prev + 1);

  const scores = Object.fromEntries(room.scores);
  const player = room.players.get(playerId);

  broadcast(room.id, {
    type: 'COIN_CLAIMED',
    data: {
      coinId,
      claimedBy: playerId,
      playerName: player?.name ?? '未知',
      scores,
    },
  }, wss);

  return { success: true };
}
