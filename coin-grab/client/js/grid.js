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
