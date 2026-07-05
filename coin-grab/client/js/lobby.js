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
