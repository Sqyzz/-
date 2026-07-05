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
