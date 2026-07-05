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
  INDEX idx_player_scores_rank (game_result_id, rank_no),
  CONSTRAINT fk_player_scores_game_result
    FOREIGN KEY (game_result_id)
    REFERENCES game_results(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional sanity checks after running this file:
-- SHOW TABLES;
-- DESCRIBE game_results;
-- DESCRIBE player_scores;
