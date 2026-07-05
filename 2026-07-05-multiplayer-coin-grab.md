# 多人实时抢金币游戏 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个支持最多5人同时在线、基于 WebSocket 的实时抢金币游戏，具备原子级并发锁保护的计分系统。

**Architecture:** Node.js 后端（Express + ws），前端 Vanilla HTML/CSS/JS，本机 MySQL 负责持久化游戏战绩与玩家得分，**游戏过程中所有状态保留在内存**（房间、金币、实时分数），仅在游戏结束时将结果异步写入 MySQL，不影响游戏主循环延迟。后端利用 Node.js 单线程事件循环的原子性实现互斥锁，保证同一金币不能被两人同时抢到。前端做乐观更新（动画先播）+服务端确认后更新分数。

**Tech Stack:** Node.js 18+, Express 4, ws 8, mysql2 3, dotenv 16, Vanilla HTML5/CSS3/JS ES2022, nanoid（金币 UUID 生成）

## Global Constraints

- 房间最大人数：5人（超员直接拒绝，返回 ERROR 消息）
- 游戏网格：5×5，共 25 格，坐标用 `{ row: 0-4, col: 0-4 }` 表示
- 金币出现间隔：随机 1000–3000ms，每房间同一时刻最多存在 3 枚活跃金币
- 等待倒计时：30 秒（满员立即跳至 3 秒开局倒计时）
- 开局倒计时：3、2、1 共 3 秒
- 游戏时长：60 秒
- 前端点击节流：同一金币首次点击后立即锁定，服务端判定前忽略后续点击
- 心跳：服务端每 5 秒发 PING，客户端 15 秒内未回 PONG 则踢出
- 所有 WebSocket 消息格式：`{ "type": "MSG_TYPE", "data": {...} }`
- 服务监听端口：3000
- 数据库使用本机 MySQL，默认库名 `coin_grab`，应用通过 `.env` 读取 `DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME`
- MySQL 只负责游戏结束后的结果落库，不参与抢金币实时判定；结算写入必须使用 InnoDB 事务、唯一键和幂等 upsert，避免重复结算、部分写入或并发重试导致的数据不一致

---

## 文件结构

```
coin-grab/
├── .env.example
├── package.json
├── db/
│   └── schema.sql       # 本机 MySQL 初始化脚本
├── server/
│   ├── index.js          # HTTP + WebSocket 入口，消息路由
│   ├── db.js             # MySQL 连接池与启动检查
│   ├── resultRepository.js # 游戏结束结果持久化
│   ├── roomManager.js    # 房间/玩家生命周期管理
│   ├── gameStateMachine.js  # 游戏状态机 + 倒计时调度
│   ├── coinManager.js    # 金币生成、原子抢夺、到期清理
│   └── heartbeat.js      # Ping/Pong 心跳，僵尸玩家清理
└── client/
    ├── lobby.html        # 大厅页：输入房间号和昵称
    ├── game.html         # 游戏主视图
    ├── js/
    │   ├── wsClient.js   # WebSocket 连接管理、消息收发
    │   ├── lobby.js      # 大厅逻辑：加入房间
    │   ├── game.js       # 游戏主逻辑：协调 UI 与 WS 消息
    │   ├── grid.js       # 5x5 网格渲染、金币动画
    │   └── scoreboard.js # 积分榜渲染
    └── css/
        └── style.css
```

---

## WebSocket 消息协议

### 客户端 → 服务端

| type | data | 说明 |
|------|------|------|
| `JOIN_ROOM` | `{ roomId, playerName }` | 加入房间 |
| `CLAIM_COIN` | `{ roomId, coinId }` | 抢金币 |
| `PONG` | `{ timestamp }` | 回应心跳 |

### 服务端 → 客户端

| type | data | 说明 |
|------|------|------|
| `JOIN_ACK` | `{ playerId, playerName, roomId }` | 加入成功确认 |
| `ROOM_STATE` | `{ players, state, countdown }` | 加入时同步当前全量状态 |
| `PLAYER_JOINED` | `{ player: { id, name } }` | 广播新玩家 |
| `PLAYER_LEFT` | `{ playerId }` | 广播玩家离开 |
| `COUNTDOWN_UPDATE` | `{ phase: 'WAITING'\|'STARTING', remaining }` | 倒计时滴答 |
| `GAME_START` | `{ duration: 60 }` | 游戏开始 |
| `COIN_SPAWN` | `{ coin: { id, row, col, spawnedAt } }` | 金币出现 |
| `COIN_CLAIMED` | `{ coinId, claimedBy, playerName, scores }` | 金币被抢，附带全量分数 |
| `COIN_EXPIRED` | `{ coinId }` | 金币超时消失 |
| `GAME_END` | `{ scores, winner: { id, name } }` | 游戏结束 |
| `ERROR` | `{ code, message }` | 错误（如 ROOM_FULL） |
| `PING` | `{ timestamp }` | 心跳探测 |

---

## Task 1: 项目初始化与 WebSocket 服务器骨架

**Files:**
- Create: `coin-grab/package.json`
- Create: `coin-grab/server/index.js`

**Interfaces:**
- Produces: HTTP server on port 3000，WebSocket 升级处理，消息路由框架 `handleMessage(ws, message, wss)`

- [ ] **Step 1: 初始化项目**

```bash
mkdir coin-grab && cd coin-grab
npm init -y
npm install express ws nanoid mysql2 dotenv
```

- [ ] **Step 2: 编写 `server/index.js`**

```js
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
```

- [ ] **Step 3: 更新 `package.json` 为 ESM 并添加启动脚本**

```json
{
  "type": "module",
  "scripts": {
    "start": "node server/index.js",
    "dev": "node --watch server/index.js"
  }
}
```

- [ ] **Step 4: 验证服务器启动**

```bash
npm run dev
# 预期: Server running on http://localhost:3000
# 用浏览器访问 http://localhost:3000 应返回 200（空页面）
```

- [ ] **Step 5: Commit**

```bash
git init && git add .
git commit -m "feat: project scaffold with WebSocket server"
```

---

## Task 2: 本机 MySQL 数据库初始化与持久化骨架

**Files:**
- Create: `coin-grab/.env.example`
- Create: `coin-grab/db/schema.sql`
- Create: `coin-grab/server/db.js`
- Create: `coin-grab/server/resultRepository.js`
- Modify: `coin-grab/server/index.js`

**Interfaces:**
- Produces: 本机 MySQL 数据库 `coin_grab`
- Produces: `server/db.js` 导出 `pool` 与 `testDbConnection()`
- Produces: `server/resultRepository.js` 导出 `saveGameResult(room, scores, winner)`

- [ ] **Step 1: 确认本机 MySQL 可登录**

```bash
mysql --version
mysql -u root -p -e "SELECT VERSION();"
# 预期: 输出 MySQL 版本号
```

如果本机 root 账号没有密码，可使用：

```bash
mysql -u root -e "SELECT VERSION();"
```

- [ ] **Step 2: 创建数据库初始化脚本 `db/schema.sql`**

```sql
CREATE DATABASE IF NOT EXISTS coin_grab
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE coin_grab;

CREATE TABLE IF NOT EXISTS game_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  result_key VARCHAR(128) NOT NULL,
  room_id VARCHAR(64) NOT NULL,
  winner_player_id VARCHAR(32) NULL,
  winner_player_name VARCHAR(64) NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_results_result_key (result_key),
  INDEX idx_game_results_room_id (room_id),
  INDEX idx_game_results_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS player_scores (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  game_result_id BIGINT UNSIGNED NOT NULL,
  player_id VARCHAR(32) NOT NULL,
  player_name VARCHAR(64) NOT NULL,
  score INT NOT NULL DEFAULT 0,
  rank_no INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_player_scores_game_player (game_result_id, player_id),
  INDEX idx_player_scores_player_id (player_id),
  CONSTRAINT fk_player_scores_game_result
    FOREIGN KEY (game_result_id)
    REFERENCES game_results(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 3: 执行初始化脚本**

```bash
mysql -u root -p < db/schema.sql
```

如果本机 root 账号没有密码：

```bash
mysql -u root < db/schema.sql
```

- [ ] **Step 4: 验证库和表已创建**

```bash
mysql -u root -p -e "USE coin_grab; SHOW TABLES; DESCRIBE game_results; DESCRIBE player_scores;"
# 预期: 看到 game_results 和 player_scores 两张表，以及各字段定义
```

- [ ] **Step 5: 创建 `.env.example`**

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=coin_grab
```

本地运行前复制一份真实配置：

```bash
cp .env.example .env
# 如果 root 有密码，编辑 .env 中的 DB_PASSWORD
```

- [ ] **Step 6: 编写 `server/db.js`**

```js
import 'dotenv/config';
import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'coin_grab',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  timezone: '+08:00',
});

export async function testDbConnection() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
```

- [ ] **Step 7: 编写 `server/resultRepository.js`**

```js
import { pool } from './db.js';

export async function saveGameResult(room, scores, winner) {
  const resultKey = room.resultKey ?? `${room.id}:${room.startedAt ?? Date.now()}`;
  const connection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();

    // result_key 是一局游戏的幂等键。若 endGame 被重复触发、服务端重试或并发调用，
    // MySQL 唯一索引会把多次写入收敛到同一条 game_results 记录。
    const [result] = await connection.execute(
      `INSERT INTO game_results
        (result_key, room_id, winner_player_id, winner_player_name, started_at, ended_at)
       VALUES (:resultKey, :roomId, :winnerPlayerId, :winnerPlayerName, :startedAt, NOW())
       ON DUPLICATE KEY UPDATE
         id = LAST_INSERT_ID(id),
         winner_player_id = VALUES(winner_player_id),
         winner_player_name = VALUES(winner_player_name),
         ended_at = VALUES(ended_at)`,
      {
        resultKey,
        roomId: room.id,
        winnerPlayerId: winner?.id ?? null,
        winnerPlayerName: winner?.name ?? null,
        startedAt: room.startedAt ? new Date(room.startedAt) : null,
      },
    );

    const gameResultId = result.insertId;
    const sortedPlayers = [...room.players.values()]
      .map((player) => ({
        id: player.id,
        name: player.name,
        score: scores[player.id] ?? 0,
      }))
      .sort((a, b) => b.score - a.score);

    for (const [index, player] of sortedPlayers.entries()) {
      await connection.execute(
        `INSERT INTO player_scores
          (game_result_id, player_id, player_name, score, rank_no)
         VALUES (:gameResultId, :playerId, :playerName, :score, :rankNo)
         ON DUPLICATE KEY UPDATE
           player_name = VALUES(player_name),
           score = VALUES(score),
           rank_no = VALUES(rank_no)`,
        {
          gameResultId,
          playerId: player.id,
          playerName: player.name,
          score: player.score,
          rankNo: index + 1,
        },
      );
    }

    await connection.commit();
    return gameResultId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
```

- [ ] **Step 8: 修改 `server/index.js`，启动时检查数据库连接**

在文件顶部添加：

```js
import { testDbConnection } from './db.js';
```

将 `server.listen` 改为：

```js
server.listen(3000, async () => {
  try {
    await testDbConnection();
    console.log('MySQL connected: coin_grab');
  } catch (error) {
    console.error('MySQL connection failed:', error.message);
    console.error('请确认已执行 mysql -u root -p < db/schema.sql，并正确配置 .env');
  }

  console.log('Server running on http://localhost:3000');
});
```

- [ ] **Step 9: 验证应用能连接本机 MySQL**

```bash
npm run dev
# 预期:
# MySQL connected: coin_grab
# Server running on http://localhost:3000
```

- [ ] **Step 10: 验证 MySQL 并发/重复写入不会产生脏数据**

结算持久化的并发保护点：

- 实时抢金币不走 MySQL，避免数据库锁影响游戏延迟
- `game_results.result_key` 是单局游戏唯一幂等键，重复保存同一局只会落到同一条记录
- `player_scores` 使用 `(game_result_id, player_id)` 唯一键，重复保存同一玩家分数时更新而不是插入重复行
- `game_results` 与 `player_scores` 在同一个 InnoDB 事务中写入，任一步失败都会 rollback，避免只写入对局但没有玩家分数

手动验证方法：

```bash
# 完成一局游戏后，连续查询同一个 result_key 的记录数应始终为 1
mysql -u root -p -e "SELECT result_key, COUNT(*) AS c FROM coin_grab.game_results GROUP BY result_key HAVING c > 1;"
# 预期: 空结果

# 同一局同一玩家的分数记录不应重复
mysql -u root -p -e "SELECT game_result_id, player_id, COUNT(*) AS c FROM coin_grab.player_scores GROUP BY game_result_id, player_id HAVING c > 1;"
# 预期: 空结果
```

- [ ] **Step 11: Commit**

```bash
git add .env.example db/schema.sql server/db.js server/resultRepository.js server/index.js package.json package-lock.json
git commit -m "feat: initialize local mysql persistence"
```

---

## Task 3: 房间管理器（玩家生命周期）

**Files:**
- Create: `coin-grab/server/roomManager.js`

**Interfaces:**
- Consumes: `ws`（WebSocket 连接），`msg`，`wss`（WebSocketServer）
- Produces:
  - `handleMessage(ws, msg, wss): void`
  - `broadcast(roomId, msg, wss): void`
  - `getRoom(roomId): Room | undefined`
  - `Room` 结构：`{ id, players: Map<playerId, {id, name, ws}>, state, startedAt, resultKey, scores: Map<playerId, number> }`

- [ ] **Step 1: 编写 `server/roomManager.js`**

```js
import { nanoid } from 'nanoid';
import { startCountdown } from './gameStateMachine.js';

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

function handleJoin(ws, { roomId, playerName }, wss) {
  if (!roomId || !playerName) {
    return send(ws, { type: 'ERROR', data: { code: 'INVALID_PARAMS', message: '缺少房间号或昵称' } });
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      players: new Map(),
      state: 'WAITING',
      startedAt: null,
      scores: new Map(),
    };
    rooms.set(roomId, room);
  }

  // 游戏进行中拒绝
  if (room.state === 'PLAYING') {
    return send(ws, { type: 'ERROR', data: { code: 'GAME_IN_PROGRESS', message: '游戏已开始，无法加入' } });
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

  // 回复加入确认 + 全量状态
  send(ws, { type: 'JOIN_ACK', data: { playerId, playerName, roomId } });
  send(ws, {
    type: 'ROOM_STATE',
    data: {
      players: [...room.players.values()].map(p => ({ id: p.id, name: p.name })),
      state: room.state,
      scores: Object.fromEntries(room.scores),
    },
  });

  // 广播新玩家加入（排除自身）
  const joinMsg = { type: 'PLAYER_JOINED', data: { player: { id: playerId, name: playerName } } };
  const payload = JSON.stringify(joinMsg);
  for (const p of room.players.values()) {
    if (p.id !== playerId && p.ws.readyState === 1) p.ws.send(payload);
  }

  // 触发倒计时逻辑
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
    rooms.delete(roomId);
    // 游戏循环清理在 gameStateMachine 中处理
  }
}

// 由 coinManager 调用
export function handleClaim(ws, { roomId, coinId }, wss) {
  const { claimCoin } = await import('./coinManager.js'); // 动态导入避免循环
  // 实际调用在 Task 5 完成后补充
}
```

> **并发说明（重要）：** Node.js 运行在单线程事件循环中，两个 WebSocket `message` 事件的回调不会真正并发执行。因此 `Map.has()` + `Map.set()` 在同一个同步代码块中天然是原子操作，无需额外锁。这是 Task 5 的核心实现依据。

- [ ] **Step 2: 手动测试——用两个 wscat 客户端连接验证加入/满员逻辑**

```bash
# 终端1（需 npm install -g wscat）
wscat -c ws://localhost:3000
# 发送: {"type":"JOIN_ROOM","data":{"roomId":"room1","playerName":"Alice"}}
# 预期收到: JOIN_ACK + ROOM_STATE

# 终端2
wscat -c ws://localhost:3000
# 发送: {"type":"JOIN_ROOM","data":{"roomId":"room1","playerName":"Bob"}}
# 预期: Alice 收到 PLAYER_JOINED，Bob 收到 JOIN_ACK + ROOM_STATE（含两人）
```

- [ ] **Step 3: Commit**

```bash
git add server/roomManager.js
git commit -m "feat: room manager with player join/leave lifecycle"
```

---

## Task 4: 游戏状态机与倒计时逻辑

**Files:**
- Create: `coin-grab/server/gameStateMachine.js`

**Interfaces:**
- Consumes: `Room`，`wss`
- Produces:
  - `startCountdown(room, wss): void` — 首个玩家加入时调用，幂等（只启动一次）
  - `room.state` 枚举：`'WAITING' | 'STARTING' | 'PLAYING' | 'ENDED'`
  - `room._waitingTimer`，`room._startingTimer`（内部定时器 ref，供清理使用）

- [ ] **Step 1: 编写 `server/gameStateMachine.js`**

```js
import { broadcast } from './roomManager.js';
import { startGameLoop, stopGameLoop } from './coinManager.js';
import { saveGameResult } from './resultRepository.js';

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
    broadcast(room.id, {
      type: 'COUNTDOWN_UPDATE',
      data: { phase: 'STARTING', remaining: count },
    }, wss);

    if (count <= 0) {
      enterPlaying(room, wss);
      return;
    }
    count--;
    room._startingTimer = setTimeout(tick, 1000);
  };
  tick();
}

function enterPlaying(room, wss) {
  room.state = 'PLAYING';
  room.startedAt = Date.now();
  room.resultKey = `${room.id}:${room.startedAt}`;
  broadcast(room.id, { type: 'GAME_START', data: { duration: GAME_DURATION } }, wss);

  startGameLoop(room, wss);

  room._gameTimer = setTimeout(() => {
    endGame(room, wss);
  }, GAME_DURATION * 1000);
}

export function endGame(room, wss) {
  if (room.state === 'ENDED') return;
  room.state = 'ENDED';

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

  // 持久化不阻塞 GAME_END 广播；失败只记录日志，不影响玩家结算体验。
  // MySQL 侧通过 result_key 唯一索引 + 事务 + upsert 防止重复结算造成脏数据。
  saveGameResult(room, scores, winner)
    .then((gameResultId) => {
      console.log(`Saved game result ${gameResultId} for room ${room.id}`);
    })
    .catch((error) => {
      console.error(`Failed to save game result for room ${room.id}:`, error);
    });
}
```

- [ ] **Step 2: 验证状态机流转**

```bash
# 用 wscat 加入 room1，观察每秒收到的 COUNTDOWN_UPDATE{ phase:'WAITING', remaining:29..0 }
# 30秒后应收到 COUNTDOWN_UPDATE{ phase:'STARTING', remaining:3 } 再到 GAME_START
# 游戏结束后查询 MySQL，应看到 game_results 和 player_scores 新增记录:
mysql -u root -p -e "SELECT * FROM coin_grab.game_results ORDER BY id DESC LIMIT 1; SELECT * FROM coin_grab.player_scores ORDER BY id DESC LIMIT 5;"
```

- [ ] **Step 3: Commit**

```bash
git add server/gameStateMachine.js
git commit -m "feat: game state machine with waiting/starting/playing/ended transitions"
```

---

## Task 5: 金币管理器与并发原子锁（核心）

**Files:**
- Create: `coin-grab/server/coinManager.js`

**Interfaces:**
- Consumes: `Room`，`wss`
- Produces:
  - `startGameLoop(room, wss): void`
  - `stopGameLoop(room): void`
  - `claimCoin(room, coinId, playerId): { success: boolean, reason?: string }`

- [ ] **Step 1: 编写 `server/coinManager.js`**

```js
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
```

- [ ] **Step 2: 将 `handleClaim` 在 `roomManager.js` 中补全**

修改 `server/roomManager.js` 中的 `handleClaim` 函数：

```js
import { claimCoin } from './coinManager.js';

// 替换 Task 3 中的占位函数
function handleClaim(ws, { roomId, coinId }, wss) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'PLAYING') return;
  if (!ws.playerId) return;

  claimCoin(room, coinId, ws.playerId, wss);
  // 无论成功失败，后端不单独回复——COIN_CLAIMED 广播即为确认
  // 失败时前端依靠 COIN_CLAIMED 不到达来触发回滚
}
```

同时在 `handleMessage` 中删除 `await import` 改为直接调用：

```js
case 'CLAIM_COIN': return handleClaim(ws, msg.data, wss);
```

- [ ] **Step 3: 验证并发抢夺**

用两个终端同时发送同一 coinId 的 `CLAIM_COIN`：

```bash
# 两个终端几乎同时发:
{"type":"CLAIM_COIN","data":{"roomId":"room1","coinId":"<同一coinId>"}}
# 预期: 只有一个 COIN_CLAIMED 广播，scores 只加一次
```

- [ ] **Step 4: Commit**

```bash
git add server/coinManager.js server/roomManager.js
git commit -m "feat: coin manager with atomic claim lock and game loop"
```

---

## Task 6: 心跳保活与僵尸玩家清理

**Files:**
- Create: `coin-grab/server/heartbeat.js`
- Modify: `coin-grab/server/index.js`

**Interfaces:**
- Consumes: `wss`，`handleMessage`
- Produces: 每 5 秒向全体客户端发 PING，15 秒未响应则关闭连接

- [ ] **Step 1: 编写 `server/heartbeat.js`**

```js
const PING_INTERVAL_MS = 5000;
const TIMEOUT_MS = 15000;

export function startHeartbeat(wss) {
  setInterval(() => {
    const now = Date.now();
    wss.clients.forEach((ws) => {
      if (!ws.isAlive || (ws.lastPong && now - ws.lastPong > TIMEOUT_MS)) {
        ws.terminate(); // 触发 close 事件 → handleDisconnect
        return;
      }
      ws.isAlive = false; // 下一轮若未收到 PONG 则判为死亡
      ws.send(JSON.stringify({ type: 'PING', data: { timestamp: now } }));
    });
  }, PING_INTERVAL_MS);
}
```

- [ ] **Step 2: 修改 `server/index.js`，启动心跳**

在 `wss.on('connection')` 中添加：

```js
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
```

在文件顶部添加导入并在服务器启动后调用：

```js
import { startHeartbeat } from './heartbeat.js';
// 在 server.listen 回调中:
server.listen(3000, () => {
  startHeartbeat(wss);
  console.log('Server running on http://localhost:3000');
});
```

- [ ] **Step 3: 验证心跳**

```bash
# wscat 连接后停止手动响应（或关掉终端）
# 观察服务端日志，15秒后应触发 close 事件并打印玩家离开
```

- [ ] **Step 4: Commit**

```bash
git add server/heartbeat.js server/index.js
git commit -m "feat: heartbeat with 15s zombie player cleanup"
```

---

## Task 7: 前端大厅页面

**Files:**
- Create: `coin-grab/client/lobby.html`
- Create: `coin-grab/client/js/wsClient.js`
- Create: `coin-grab/client/js/lobby.js`
- Create: `coin-grab/client/css/style.css`（基础样式，后续 Task 8 扩展）

**Interfaces:**
- Produces:
  - `wsClient.js` 导出 `{ connect(url), send(msg), on(type, handler), off(type, handler) }`
  - `lobby.js` 读取表单，调用 `wsClient.connect`，成功后跳转到 `game.html?room=&player=`

- [ ] **Step 1: 编写 `client/js/wsClient.js`**

```js
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
```

- [ ] **Step 2: 编写 `client/lobby.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>抢金币 - 大厅</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <div class="lobby-container">
    <h1>🪙 多人抢金币</h1>
    <form id="joinForm">
      <input id="roomId" type="text" placeholder="房间号" maxlength="20" required>
      <input id="playerName" type="text" placeholder="你的昵称" maxlength="12" required>
      <button type="submit">加入房间</button>
    </form>
    <p id="errorMsg" class="error" hidden></p>
  </div>
  <script type="module" src="js/lobby.js"></script>
</body>
</html>
```

- [ ] **Step 3: 编写 `client/js/lobby.js`**

```js
import * as ws from './wsClient.js';

const form = document.getElementById('joinForm');
const errorMsg = document.getElementById('errorMsg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const roomId = document.getElementById('roomId').value.trim();
  const playerName = document.getElementById('playerName').value.trim();

  try {
    await ws.connect(`ws://${location.host}`);
  } catch {
    showError('连接服务器失败，请刷新重试');
    return;
  }

  ws.on('JOIN_ACK', ({ playerId }) => {
    // 将关键信息存入 sessionStorage 供 game.html 使用
    sessionStorage.setItem('playerId', playerId);
    sessionStorage.setItem('playerName', playerName);
    sessionStorage.setItem('roomId', roomId);
    location.href = `game.html`;
  });

  ws.on('ERROR', ({ code, message }) => showError(message));

  ws.send({ type: 'JOIN_ROOM', data: { roomId, playerName } });
});

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}
```

> **注意：** 跳转到 game.html 后，WebSocket 连接会断开（页面刷新）。game.html 需要重新建立连接并重新发送 JOIN_ROOM。这是简单可靠的方案，避免跨页面共享 WebSocket 对象的复杂性。

- [ ] **Step 4: 编写基础 `client/css/style.css`**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Segoe UI', system-ui, sans-serif;
  background: #1a1a2e;
  color: #eee;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lobby-container {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
}

h1 { font-size: 2.5rem; }

input, button {
  display: block;
  width: 280px;
  margin: 0 auto;
  padding: 0.8rem 1rem;
  font-size: 1rem;
  border-radius: 8px;
  border: none;
}

button {
  background: #f5a623;
  color: #1a1a2e;
  font-weight: bold;
  cursor: pointer;
  margin-top: 0.4rem;
}
button:hover { background: #e09415; }

.error { color: #ff6b6b; font-size: 0.9rem; }
```

- [ ] **Step 5: 验证大厅——在浏览器打开，填写信息后应跳转到 game.html（此时 game.html 还未创建，404 即可）**

- [ ] **Step 6: Commit**

```bash
git add client/
git commit -m "feat: lobby page with WebSocket join flow"
```

---

## Task 8: 前端游戏主视图

**Files:**
- Create: `coin-grab/client/game.html`
- Create: `coin-grab/client/js/game.js`
- Create: `coin-grab/client/js/grid.js`
- Create: `coin-grab/client/js/scoreboard.js`
- Modify: `coin-grab/client/css/style.css`（追加游戏样式）

**Interfaces:**
- Consumes: `wsClient.js`，`sessionStorage` 中的 `playerId / playerName / roomId`
- Produces: 渲染 5x5 网格、左侧积分榜、顶部倒计时，响应服务端所有消息

- [ ] **Step 1: 编写 `client/game.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>抢金币</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body class="game-layout">
  <header>
    <div id="phaseLabel" class="phase-label">等待玩家加入...</div>
    <div id="countdown" class="countdown">--</div>
  </header>

  <aside id="scoreboard">
    <h2>积分榜</h2>
    <ul id="scoreList"></ul>
  </aside>

  <main>
    <div id="grid" class="grid"></div>
  </main>

  <div id="overlay" class="overlay" hidden>
    <div class="overlay-content">
      <h2 id="overlayTitle"></h2>
      <ul id="finalScores"></ul>
      <button onclick="location.href='lobby.html'">返回大厅</button>
    </div>
  </div>

  <script type="module" src="js/game.js"></script>
</body>
</html>
```

- [ ] **Step 2: 编写 `client/js/grid.js`**

```js
const grid = document.getElementById('grid');

// 构建 25 个格子
export function initGrid(onCellClick) {
  grid.innerHTML = '';
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.addEventListener('click', () => onCellClick(r, c));
      grid.appendChild(cell);
    }
  }
}

export function spawnCoin(coin) {
  const cell = getCell(coin.row, coin.col);
  if (!cell) return;
  cell.dataset.coinId = coin.id;
  cell.classList.add('has-coin');
  cell.innerHTML = `<span class="coin">🪙</span>`;
}

export function removeCoin(coinId, claimed = false) {
  const cell = document.querySelector(`[data-coin-id="${coinId}"]`);
  if (!cell) return;

  if (claimed) {
    // 乐观动画：硬币飞出
    cell.classList.add('coin-claimed');
    setTimeout(() => clearCell(cell), 600);
  } else {
    clearCell(cell);
  }
}

export function lockCoin(coinId) {
  const cell = document.querySelector(`[data-coin-id="${coinId}"]`);
  cell?.classList.add('coin-locked');
}

export function unlockCoin(coinId) {
  const cell = document.querySelector(`[data-coin-id="${coinId}"]`);
  cell?.classList.remove('coin-locked');
}

function clearCell(cell) {
  delete cell.dataset.coinId;
  cell.classList.remove('has-coin', 'coin-claimed', 'coin-locked');
  cell.innerHTML = '';
}

function getCell(row, col) {
  return grid.querySelector(`[data-row="${row}"][data-col="${col}"]`);
}
```

- [ ] **Step 3: 编写 `client/js/scoreboard.js`**

```js
const scoreList = document.getElementById('scoreList');

// players: [{ id, name }], scores: { id: number }
export function renderScoreboard(players, scores, myPlayerId) {
  const sorted = [...players].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0));

  scoreList.innerHTML = sorted.map((p, i) => `
    <li class="${p.id === myPlayerId ? 'me' : ''}">
      <span class="rank">${i + 1}</span>
      <span class="name">${p.name}</span>
      <span class="score">${scores[p.id] ?? 0}</span>
    </li>
  `).join('');
}
```

- [ ] **Step 4: 编写 `client/js/game.js`**

```js
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
const activeCoinMap = new Map(); // coinId → { row, col }
const lockedCoins = new Set();   // 已发出请求、等待服务端确认的金币

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
ws.on('JOIN_ACK', () => {}); // 已加入，等待 ROOM_STATE

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
  let t = duration;
  const timer = setInterval(() => {
    countdownEl.textContent = t--;
    if (t < 0) clearInterval(timer);
  }, 1000);
});

ws.on('COIN_SPAWN', ({ coin }) => {
  activeCoinMap.set(coin.id, coin);
  spawnCoin(coin);
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
```

- [ ] **Step 5: 追加游戏样式到 `client/css/style.css`**

```css
/* 游戏布局 */
body.game-layout {
  display: grid;
  grid-template-areas: "header header" "aside main";
  grid-template-columns: 200px 1fr;
  grid-template-rows: auto 1fr;
  align-items: start;
  gap: 1rem;
  padding: 1rem;
  min-height: 100vh;
}

header {
  grid-area: header;
  display: flex;
  align-items: center;
  gap: 2rem;
  padding: 0.5rem 1rem;
  background: #16213e;
  border-radius: 8px;
}
.phase-label { flex: 1; font-size: 1.1rem; }
.countdown { font-size: 2rem; font-weight: bold; color: #f5a623; min-width: 3ch; text-align: right; }

aside { grid-area: aside; background: #16213e; border-radius: 8px; padding: 1rem; }
aside h2 { margin-bottom: 0.8rem; }
#scoreList { list-style: none; display: flex; flex-direction: column; gap: 0.4rem; }
#scoreList li { display: flex; gap: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 4px; }
#scoreList li.me { background: #f5a62330; }
.rank { color: #888; width: 1.2rem; }
.name { flex: 1; }
.score { font-weight: bold; color: #f5a623; }

/* 5x5 网格 */
.grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  max-width: 500px;
  margin: 0 auto;
}
.cell {
  aspect-ratio: 1;
  background: #16213e;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
  transition: background 0.15s;
  font-size: 2rem;
  user-select: none;
}
.cell.has-coin { cursor: pointer; background: #0f3460; }
.cell.has-coin:hover { background: #1a4a7a; }
.cell.coin-locked { opacity: 0.5; cursor: not-allowed; }

@keyframes coinPop { 0% { transform: scale(1); } 50% { transform: scale(1.5); opacity: 0.5; } 100% { transform: scale(0); opacity: 0; } }
.cell.coin-claimed .coin { display: inline-block; animation: coinPop 0.6s ease forwards; }

/* 结算遮罩 */
.overlay {
  position: fixed; inset: 0;
  background: #000a;
  display: flex; align-items: center; justify-content: center;
}
.overlay-content {
  background: #16213e;
  border-radius: 16px;
  padding: 2rem 3rem;
  text-align: center;
  display: flex; flex-direction: column; gap: 1rem;
}
```

- [ ] **Step 6: 端到端手动测试**

打开两个浏览器标签，都进入相同房间。等待30秒后游戏开始，验证：
- 金币在格子中随机出现
- 点击金币后格子变灰（乐观更新）
- 两个标签的积分榜同步更新
- 60秒后出现结算弹窗

- [ ] **Step 7: Commit**

```bash
git add client/
git commit -m "feat: game UI with grid, scoreboard, countdown and overlay"
```

---

## Task 9: 网络延迟补偿——时间对齐

**Files:**
- Modify: `coin-grab/client/js/game.js`（追加时钟同步逻辑）
- Modify: `coin-grab/client/js/grid.js`（追加金币"新鲜度"视觉）

> **背景：** 后端 `COIN_SPAWN` 消息携带 `spawnedAt`（服务端时间戳），但客户端收到消息时已过去了若干毫秒的网络延迟。若客户端时钟与服务端时钟不同步，金币显示的"存活时间"会不准确。

**处理策略（简洁有效版本）：**
1. 客户端在 `JOIN_ACK` 时记录 `clientReceiveTime` 与消息中的 `serverTime`，估算偏移量 `clockOffset = serverTime - clientReceiveTime`。
2. 金币被展示时，基于 `Date.now() + clockOffset - spawnedAt` 计算已过去时间，若金币已在服务端存活超过 6 秒（TTL 的 75%），则显示为橙色警告（"快到期了"）。

- [ ] **Step 1: 修改服务端，在 `JOIN_ACK` 中附带服务端时间**

在 `server/roomManager.js` 的 `handleJoin` 中，修改 JOIN_ACK：

```js
send(ws, { type: 'JOIN_ACK', data: { playerId, playerName, roomId, serverTime: Date.now() } });
```

- [ ] **Step 2: 在 `game.js` 顶部追加时钟同步**

```js
let clockOffset = 0; // 毫秒，serverTime - clientTime

ws.on('JOIN_ACK', ({ serverTime }) => {
  clockOffset = serverTime - Date.now();
});
```

- [ ] **Step 3: 修改 `grid.js` 的 `spawnCoin`，展示金币新鲜度**

```js
export function spawnCoin(coin, clockOffset = 0) {
  const cell = getCell(coin.row, coin.col);
  if (!cell) return;
  cell.dataset.coinId = coin.id;
  cell.classList.add('has-coin');

  const alreadyAliveMs = Date.now() + clockOffset - coin.spawnedAt;
  const isStaleCoin = alreadyAliveMs > 6000; // 超过6秒存活则标橙

  cell.innerHTML = `<span class="coin ${isStaleCoin ? 'coin-stale' : ''}">🪙</span>`;
}
```

在 `game.js` 中修改调用：

```js
ws.on('COIN_SPAWN', ({ coin }) => {
  activeCoinMap.set(coin.id, coin);
  spawnCoin(coin, clockOffset); // 传入时钟偏移
});
```

- [ ] **Step 4: 追加 `.coin-stale` 样式到 `style.css`**

```css
.coin-stale { filter: sepia(0.8) hue-rotate(-20deg); }
```

- [ ] **Step 5: Commit**

```bash
git add server/roomManager.js client/js/game.js client/js/grid.js client/css/style.css
git commit -m "feat: clock offset sync for network latency compensation"
```

---

## 自检清单

在交付前逐项核对：

### 功能覆盖

- [ ] 大厅：输入房间号+昵称，加入成功后进入游戏页
- [ ] 满员（5人）立即跳过等待倒计时，进入3秒开局倒计时
- [ ] 未满员30秒到期，以当前人数直接开局
- [ ] 第6位玩家收到 `ROOM_FULL` 错误，无法加入
- [ ] 游戏进行中不允许新玩家加入（`GAME_IN_PROGRESS`）
- [ ] 金币随机出现，1-3秒间隔，同时最多3枚
- [ ] 同一格同时点击：只有一人加分（并发锁验证）
- [ ] 点击后前端立即锁定金币（乐观更新），分数以服务端为准
- [ ] 服务端3秒内无确认，前端自动解锁金币（回滚）
- [ ] 60秒游戏结束，展示结算弹窗
- [ ] 游戏结束后，`game_results` 写入一条对局记录
- [ ] 游戏结束后，`player_scores` 写入本局所有玩家得分和排名
- [ ] 重复触发或重试结算时，`game_results.result_key` 不重复，`player_scores` 不产生同局同玩家重复记录
- [ ] 关掉标签页15秒内，其他玩家收到该玩家离开通知
- [ ] 金币8秒无人抢自动消失

### 并发安全说明（应在 README 或注释中明确）

> Node.js 单线程事件循环保证：`claimedCoins.has(coinId)` 到 `claimedCoins.add(coinId)` 之间不会有其他消息处理器插入执行，因此这段同步代码天然是原子操作，无需 Redis 或外部锁。如果将来迁移到多进程（cluster/PM2 多实例），则需要改用 Redis SETNX。

### MySQL 一致性说明（应在 README 或注释中明确）

> MySQL 不参与游戏中的金币抢夺判定，只在游戏结束后保存最终结果。结算落库使用 InnoDB 事务保证 `game_results` 与 `player_scores` 同写同回滚；`game_results.result_key` 唯一键保证同一局不会重复插入；`player_scores(game_result_id, player_id)` 唯一键配合 upsert 保证同一局同一玩家只有一条最终分数记录。

### 延迟补偿说明（应能口头表述）

> 前端显示的金币出现时间和后端实际生成时间存在网络延迟差（通常 10~100ms）。通过 `JOIN_ACK` 携带服务端时间戳，前端估算时钟偏移量，用于判断金币是否即将过期并给出视觉提示，避免玩家点击一枚"看起来新鲜"但实际即将消失的金币。

---

## 运行方式

```bash
cd coin-grab
npm install
cp .env.example .env
mysql -u root -p < db/schema.sql
npm run dev
# 预期看到: MySQL connected: coin_grab
# 浏览器打开 http://localhost:3000/lobby.html
# 多开标签页模拟多玩家
```

如果本机 MySQL root 账号没有密码，初始化命令改为：

```bash
mysql -u root < db/schema.sql
```
