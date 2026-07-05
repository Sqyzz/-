const form = document.getElementById('joinForm');
const errorMsg = document.getElementById('errorMsg');

// 如果从 game.html 带着错误跳回来（房间满、游戏已开始、连接失败等），展示出来
const pendingError = sessionStorage.getItem('lobbyError');
if (pendingError) {
  showError(pendingError);
  sessionStorage.removeItem('lobbyError');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const roomId = document.getElementById('roomId').value.trim();
  const playerName = document.getElementById('playerName').value.trim();

  if (!roomId || !playerName) {
    showError('请输入房间号和昵称');
    return;
  }

  // 仅在大厅保存房间/昵称信息，不在此处连接 WebSocket 或发送 JOIN_ROOM。
  // 原因：跳转后 WebSocket 会断开，服务端会"创建→删除"一次孤儿房间，
  // 导致 game.html 再次 JOIN 时可能踩到残留房间的坑。
  // 真正的加入由 game.html 完成，避免双重 JOIN 带来的所有副作用。
  sessionStorage.setItem('playerName', playerName);
  sessionStorage.setItem('roomId', roomId);
  sessionStorage.removeItem('playerId'); // 旧值清掉，等 game.html 重连后由服务端分配
  sessionStorage.removeItem('lobbyError');
  location.href = 'game.html';
});

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}
