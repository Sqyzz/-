import * as ws from './wsClient.js';
import { initGrid, spawnCoin, removeCoin, lockCoin, unlockCoin } from './grid.js';
import { renderScoreboard } from './scoreboard.js';

const playerId = sessionStorage.getItem('playerId');
const playerName = sessionStorage.getItem('playerName');
const roomId = sessionStorage.getItem('roomId');

if (!playerId || !roomId) location.href = 'lobby.html';

// 本地状态
let players = [];
let scores = {};
let clockOffset = 0; // 服务端时钟 - 本地时钟，用于网络延迟补偿
const activeCoinMap = new Map(); // coinId → { row, col }
const lockedCoins = new Set();   // 已发出请求、等待服务端确认的金币
let gameCountdownTimer = null;

const phaseLabel = document.getElementById('phaseLabel');
const countdownEl = document.getElementById('countdown');
const overlay = document.getElementById('overlay');

// ── 初始化 ──────────────────────────────────────────────────────
initGrid(handleCellClick);

(async () => {
  await ws.connect(`ws://${location.host}`);
  ws.send({ type: 'JOIN_ROOM', data: { roomId, playerName } });
})();

// ── 消息处理 ────────────────────────────────────────────────────
ws.on('JOIN_ACK', ({ serverTime }) => {
  // 记录服务端与本地时钟的偏移：serverTime - localTime
  // 后续 localTime + clockOffset ≈ serverTime
  clockOffset = serverTime - Date.now();
}); // 已加入，等待 ROOM_STATE

ws.on('ROOM_STATE', ({ players: ps, scores: sc }) => {
  players = ps;
  scores = sc;
  renderScoreboard(players, scores, playerId);
});

ws.on('PLAYER_JOINED', ({ player }) => {
  players.push(player);
  scores[player.id] = 0;
  renderScoreboard(players, scores, playerId);
});

ws.on('PLAYER_LEFT', ({ playerId: pid }) => {
  players = players.filter(p => p.id !== pid);
  renderScoreboard(players, scores, playerId);
});

ws.on('COUNTDOWN_UPDATE', ({ phase, remaining }) => {
  if (phase === 'WAITING') {
    phaseLabel.textContent = `等待玩家加入（${players.length}/5）`;
    countdownEl.textContent = remaining;
  } else {
    phaseLabel.textContent = '游戏即将开始';
    countdownEl.textContent = remaining || 'GO!';
  }
});

ws.on('GAME_START', ({ duration }) => {
  phaseLabel.textContent = '抢金币！';
  clearInterval(gameCountdownTimer);
  let t = duration;
  gameCountdownTimer = setInterval(() => {
    countdownEl.textContent = t--;
    if (t < 0) { clearInterval(gameCountdownTimer); gameCountdownTimer = null; }
  }, 1000);
});

ws.on('COIN_SPAWN', ({ coin }) => {
  activeCoinMap.set(coin.id, coin);
  spawnCoin(coin, clockOffset);
});

ws.on('COIN_CLAIMED', ({ coinId, claimedBy, scores: newScores }) => {
  activeCoinMap.delete(coinId);
  lockedCoins.delete(coinId);
  // 计分以服务端为准
  scores = newScores;
  renderScoreboard(players, scores, playerId);
  // 动画：自己抢到→飞出，别人抢到→消失
  removeCoin(coinId, claimedBy === playerId);
});

ws.on('COIN_EXPIRED', ({ coinId }) => {
  activeCoinMap.delete(coinId);
  lockedCoins.delete(coinId);
  removeCoin(coinId, false);
});

ws.on('GAME_END', ({ scores: finalScores, winner }) => {
  overlay.hidden = false;
  document.getElementById('overlayTitle').textContent =
    winner ? `🏆 ${winner.name} 获胜！` : '平局！';
  document.getElementById('finalScores').innerHTML = players
    .sort((a, b) => (finalScores[b.id] ?? 0) - (finalScores[a.id] ?? 0))
    .map(p => `<li>${p.name}：${finalScores[p.id] ?? 0} 分</li>`)
    .join('');
});

// ── 点击处理（节流 + 乐观更新）──────────────────────────────────
function handleCellClick(row, col) {
  // 找出该格子上的金币
  let targetCoin = null;
  for (const coin of activeCoinMap.values()) {
    if (coin.row === row && coin.col === col) { targetCoin = coin; break; }
  }
  if (!targetCoin) return;

  // 节流：该金币已锁定（已发出请求），忽略后续点击
  if (lockedCoins.has(targetCoin.id)) return;
  lockedCoins.add(targetCoin.id);

  // 乐观更新：立即在 UI 上锁定金币（视觉反馈）
  lockCoin(targetCoin.id);

  ws.send({ type: 'CLAIM_COIN', data: { roomId, coinId: targetCoin.id } });

  // 超时回滚：若 3 秒内未收到服务端确认，解锁金币
  setTimeout(() => {
    if (lockedCoins.has(targetCoin.id)) {
      lockedCoins.delete(targetCoin.id);
      unlockCoin(targetCoin.id);
    }
  }, 3000);
}
