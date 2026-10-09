const form = document.getElementById("applicationForm");
const formStatus = document.getElementById("formStatus");
const menuToggle = document.getElementById("menuToggle");
const navigation = document.getElementById("navigation");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function emptyMessage(message) {
  return `<div class="empty-card">${escapeHtml(message)}</div>`;
}

function renderMatches(matches) {
  const target = document.getElementById("matchList");
  if (!matches.length) {
    target.innerHTML = emptyMessage("Будущие матчи и результаты появятся здесь.");
    return;
  }
  target.innerHTML = matches.map(match => `
    <article class="match-card">
      <div class="match-date"><strong>${escapeHtml(match.date || "—")}</strong><span>${escapeHtml(match.time || "")}</span></div>
      <div class="match-teams"><strong>${escapeHtml(match.home || "Команда 1")}</strong><span>${escapeHtml(match.score || "VS")}</span><strong>${escapeHtml(match.away || "Команда 2")}</strong></div>
      <span class="match-status">${escapeHtml(match.status || "Запланирован")}</span>
      <span class="match-event">${escapeHtml(match.event || "")}</span>
    </article>`).join("");
}

function renderLeagues(leagues) {
  const target = document.getElementById("leagueList");
  if (!leagues.length) {
    target.innerHTML = emptyMessage("Лиги и турниры появятся здесь.");
    return;
  }
  target.innerHTML = leagues.map(league => `
    <article class="competition-card">
      <div class="competition-card-top"><span>${escapeHtml(league.date || "Событие")}</span><b>${escapeHtml(league.status || "Набор")}</b></div>
      <h3>${escapeHtml(league.name || "Лига")}</h3>
      ${league.description ? `<p>${escapeHtml(league.description)}</p>` : ""}
    </article>`).join("");
}

function renderTeams(teams) {
  const target = document.getElementById("teamList");
  if (!teams.length) {
    target.innerHTML = emptyMessage("Командная статистика появится после добавления официальных результатов.");
    return;
  }
  target.innerHTML = teams.map((team, index) => `
    <article class="team-card">
      <div class="team-card-top"><span class="team-rank">#${String(index + 1).padStart(2, "0")}</span></div>
      <h3>${escapeHtml(team.name || "Команда")}</h3>
      ${team.country ? `<p class="team-country">${escapeHtml(team.country)}</p>` : ""}
      <div class="team-stats">
        <div><span>МАТЧИ</span><b>${Number(team.matches) || 0}</b></div>
        <div><span>ПОБЕДЫ</span><b>${Number(team.wins) || 0}</b></div>
        <div><span>ПОРАЖЕНИЯ</span><b>${Number(team.losses) || 0}</b></div>
        <div><span>РЕЙТИНГ</span><b>${Number(team.rating) || 0}</b></div>
      </div>
    </article>`).join("");
}

function renderPlayers(players) {
  const target = document.getElementById("playerList");
  if (!players.length) {
    target.innerHTML = emptyMessage("Статистика игроков появится после публикации матчей.");
    return;
  }
  target.innerHTML = players.map(player => `
    <article class="player-card">
      <div class="player-card-top"><span class="player-avatar">${escapeHtml((player.nickname || "?").slice(0, 1).toUpperCase())}</span><span class="player-rank">#${escapeHtml(player.rank || "—")}</span></div>
      <h3>${escapeHtml(player.nickname || "Игрок")}</h3>
      <p>${escapeHtml([player.team || "Без команды", player.country].filter(Boolean).join(" • "))}</p>
      <div class="player-stats">
        <span>МАТЧИ<b>${Number(player.matches) || 0}</b></span>
        <span>РЕЙТИНГ<b>${Number(player.rating) || 0}</b></span>
        <span>ВИНРЕЙТ<b>${Number(player.winRate) || 0}%</b></span>
      </div>
    </article>`).join("");
}

async function loadData() {
  const response = await fetch("/api/data");
  if (!response.ok) throw new Error(`Не удалось загрузить данные (${response.status}).`);
  const data = await response.json();
  const players = Array.isArray(data.players) ? data.players : [];
  const teams = Array.isArray(data.teams) ? data.teams : [];
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const leagues = Array.isArray(data.leagues) ? data.leagues : [];
  renderMatches(matches);
  renderLeagues(leagues);
  renderTeams(teams);
  renderPlayers(players);
}

menuToggle.addEventListener("click", () => {
  const isOpen = navigation.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(isOpen));
});

navigation.addEventListener("click", event => {
  if (event.target.closest("a")) navigation.classList.remove("open");
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  formStatus.textContent = "";
  formStatus.classList.remove("visible", "error");
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form).entries());
    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Не удалось отправить заявку (${response.status}).`);
    form.reset();
    formStatus.textContent = "Заявка отправлена. Сохрани номер: " + result.id;
    formStatus.classList.add("visible");
  } catch (error) {
    formStatus.textContent = error.message || "Ошибка соединения. Попробуй ещё раз.";
    formStatus.classList.add("visible", "error");
  } finally {
    submitButton.disabled = false;
  }
});

loadData().catch(error => {
  console.error(error);
  document.getElementById("matchList").innerHTML = emptyMessage("Не удалось загрузить данные сайта. Обнови страницу позже.");
});
