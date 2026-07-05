import pool from './db.js';

/**
 * 游戏结束后异步写入战绩。
 * result_key 保证幂等：同一局游戏重复调用只插入一次。
 */
export async function saveGameResult({ resultKey, roomId, startedAt, endedAt, winner, scores, players }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      `INSERT IGNORE INTO game_results
         (result_key, room_id, winner_player_id, winner_player_name, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        resultKey,
        roomId,
        winner?.id   ?? null,
        winner?.name ?? null,
        startedAt ? new Date(startedAt) : null,
        new Date(endedAt),
      ],
    );

    // insertId === 0 表示 IGNORE 生效（已存在），跳过明细插入
    if (rows.insertId > 0) {
      const gameResultId = rows.insertId;

      // 按得分排序，计算名次
      const sorted = [...players]
        .map(p => ({ ...p, score: scores[p.id] ?? 0 }))
        .sort((a, b) => b.score - a.score);

      for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        await conn.execute(
          `INSERT INTO player_scores
             (game_result_id, player_id, player_name, score, rank_no)
           VALUES (?, ?, ?, ?, ?)`,
          [gameResultId, p.id, p.name, p.score, i + 1],
        );
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('[resultRepository] 写库失败:', err.message);
  } finally {
    conn.release();
  }
}
