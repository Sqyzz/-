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

export function spawnCoin(coin, clockOffset = 0) {
  const cell = getCell(coin.row, coin.col);
  if (!cell) return;

  // 网络延迟补偿：若金币在服务端已存活超过 6000ms，视为陈旧金币
  // （TTL=8000ms，剩余寿命不足 2000ms），降低点击优先级
  let isStaleCoin = false;
  if (coin.spawnedAt) {
    const localNow = Date.now() + clockOffset; // 折算到服务端时钟
    const age = localNow - coin.spawnedAt;
    if (age > 6000) {
      isStaleCoin = true;
    }
  }

  cell.dataset.coinId = coin.id;
  cell.classList.add('has-coin');
  cell.innerHTML = `<span class="coin ${isStaleCoin ? 'coin-stale' : ''}">🪙</span>`;
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
  cell.classList.remove('has-coin', 'coin-claimed', 'coin-locked', 'coin-stale');
  cell.innerHTML = '';
}

function getCell(row, col) {
  return grid.querySelector(`[data-row="${row}"][data-col="${col}"]`);
}
