import { broadcast } from './roomManager.js';
import { startGameLoop, stopGameLoop } from './coinManager.js';

const MAX_PLAYERS = 5;
const WAITING_SECONDS = 30;
const STARTING_SECONDS = 3;
const GAME_DURATION = 60;

export function startCountdown(room, wss) {
  // 幂等：只在第一个玩家加入时启动
  if (room._waitingTimer || room.state !== 'WAITING') return;

  let remaining = WAITING_SECONDS;

  room._waitingTimer = setInterval(() => {
    // 房间已满：立即跳到开局倒计时
    if (room.players.size >= MAX_PLAYERS) {
      clearInterval(room._waitingTimer);
      room._waitingTimer = null;
      enterStarting(room, wss);
      return;
    }

    remaining--;
    broadcast(room.id, {
      type: 'COUNTDOWN_UPDATE',
      data: { phase: 'WAITING', remaining },
    }, wss);

    if (remaining <= 0) {
      clearInterval(room._waitingTimer);
      room._waitingTimer = null;
      // 无论几人都直接进入开局倒计时
      enterStarting(room, wss);
    }
  }, 1000);
}

function enterStarting(room, wss) {
  room.state = 'STARTING';
  let count = STARTING_SECONDS;

  const tick = () => {
    if (count <= 0) {
      enterPlaying(room, wss);
      return;
    }
    broadcast(room.id, {
      type: 'COUNTDOWN_UPDATE',
      data: { phase: 'STARTING', remaining: count },
    }, wss);
    count--;
    room._startingTimer = setTimeout(tick, 1000);
  };
  tick();
}

function enterPlaying(room, wss) {
  room.state = 'PLAYING';
  broadcast(room.id, { type: 'GAME_START', data: { duration: GAME_DURATION } }, wss);

  startGameLoop(room, wss);

  room._gameTimer = setTimeout(() => {
    endGame(room, wss);
  }, GAME_DURATION * 1000);
}

export function endGame(room, wss) {
  if (room.state === 'ENDED') return;
  room.state = 'ENDED';

  clearInterval(room._waitingTimer); room._waitingTimer = null;
  clearTimeout(room._startingTimer); room._startingTimer = null;
  clearTimeout(room._gameTimer);
  stopGameLoop(room);

  const scores = Object.fromEntries(room.scores);
  let winner = null;
  let maxScore = -1;
  for (const [id, score] of room.scores) {
    if (score > maxScore) {
      maxScore = score;
      winner = { id, name: room.players.get(id)?.name ?? '已离开' };
    }
  }

  broadcast(room.id, { type: 'GAME_END', data: { scores, winner } }, wss);
}
