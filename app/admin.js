const loginPanel = document.getElementById("loginPanel");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const loginTitle = document.getElementById("loginTitle");
const loginDescription = document.getElementById("loginDescription");
const confirmPasswordField = document.getElementById("confirmPasswordField");
const confirmAdminPassword = document.getElementById("confirmAdminPassword");
const loginButton = document.getElementById("loginButton");
const dashboard = document.getElementById("dashboard");
const collectionPanel = document.getElementById("collectionPanel");
const applicationsPanel = document.getElementById("applicationsPanel");
const recordsTarget = document.getElementById("records");
const applicationsTarget = document.getElementById("applications");
const recordForm = document.getElementById("recordForm");
const editorFields = document.getElementById("editorFields");
const dashboardMessage = document.getElementById("dashboardMessage");
const globalError = document.getElementById("globalError");
const logoutButton = document.getElementById("logoutButton");
const collectionTitle = document.getElementById("collectionTitle");
const editorTitle = document.getElementById("editorTitle");
const newRecordButton = document.getElementById("newRecordButton");
const cancelEditButton = document.getElementById("cancelEditButton");

const definitions = {
  matches: {
    title: "Матчи",
    name: item => `${item.home} — ${item.away}`,
    subtitle: item => [item.date, item.time, item.status].filter(Boolean).join(" • "),
    fields: [
      ["date", "Дата", "date", true], ["time", "Время", "time"],
      ["home", "Команда 1", "text", true], ["away", "Команда 2", "text", true],
      ["score", "Счёт", "text"], ["status", "Статус", "select", false, ["Запланирован", "Идёт", "Завершён"]],
      ["event", "Турнир или событие", "text", false, null, true]
    ]
  },
  teams: {
    title: "Команды",
    name: item => item.name,
    subtitle: item => `${item.matches} матчей • ${item.wins} побед • рейтинг ${item.rating}`,
    fields: [
      ["name", "Название команды", "text", true], ["country", "Страна", "text"],
      ["matches", "Матчи", "number"], ["wins", "Победы", "number"],
      ["losses", "Поражения", "number"], ["rating", "Рейтинг", "number"]
    ]
  },
  players: {
    title: "Игроки",
    name: item => item.nickname,
    subtitle: item => `${item.team || "Без команды"} • ${item.matches} матчей • рейтинг ${item.rating}`,
    fields: [
      ["nickname", "Игровой ник", "text", true], ["team", "Команда", "text"],
      ["country", "Страна", "text"], ["rank", "Место в рейтинге", "number"],
      ["matches", "Матчи", "number"], ["rating", "Рейтинг", "number"],
      ["winRate", "Процент побед", "number"]
    ]
  },
  leagues: {
    title: "Лиги и турниры",
    name: item => item.name,
    subtitle: item => [item.date, item.status].filter(Boolean).join(" • "),
    fields: [
      ["name", "Название", "text", true], ["date", "Дата или период", "text"],
      ["status", "Статус", "select", false, ["Набор", "Идёт", "Завершена"]],
      ["description", "Описание", "textarea", false, null, true]
    ]
  }
};

let activePanel = "matches";
let editingId = "";
let applicationCache = [];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Ошибка запроса (${response.status}).`);
  return payload;
}

function showError(error) {
  globalError.textContent = error.message || "Не удалось выполнить действие.";
  window.clearTimeout(showError.timer);
  showError.timer = window.setTimeout(() => { globalError.textContent = ""; }, 6000);
}

function renderField([name, label, type = "text", required = false, options, wide = false], value = "") {
  const classes = wide ? ' class="wide"' : "";
  const requiredAttribute = required ? " required" : "";
  let control;
  if (type === "textarea") {
    control = `<textarea name="${name}"${requiredAttribute}>${escapeHtml(value)}</textarea>`;
  } else if (type === "select") {
    control = `<select name="${name}"${requiredAttribute}>${options.map(option =>
      `<option value="${escapeHtml(option)}"${value === option ? " selected" : ""}>${escapeHtml(option)}</option>`
    ).join("")}</select>`;
  } else {
    const step = type === "number" ? ' step="any" min="0"' : "";
    control = `<input name="${name}" type="${type}"${step}${requiredAttribute} value="${escapeHtml(value)}">`;
  }
  return `<label${classes}>${escapeHtml(label)}${control}</label>`;
}

function resetEditor() {
  editingId = "";
  recordForm.reset();
  const definition = definitions[activePanel];
  editorTitle.textContent = "Новая запись";
  editorFields.innerHTML = definition.fields.map(field => renderField(field)).join("");
}

function renderRecords(records) {
  if (!records.length) {
    recordsTarget.innerHTML = '<div class="empty-state">Записей пока нет.<br>Нажмите «Добавить», чтобы создать первую.</div>';
    return;
  }
  const definition = definitions[activePanel];
  recordsTarget.innerHTML = records.map(item => `
    <article class="record-item">
      <div class="record-name">${escapeHtml(definition.name(item) || "Без названия")}
        <span class="record-subtitle">${escapeHtml(definition.subtitle(item))}</span>
      </div>
      <div class="record-actions">
        <button class="button" type="button" data-action="edit" data-id="${escapeHtml(item.id)}">Изменить</button>
        <button class="button delete-button" type="button" data-action="delete" data-id="${escapeHtml(item.id)}">Удалить</button>
      </div>
    </article>`).join("");
}

async function loadRecords() {
  const records = await api(`/api/admin/${activePanel}`);
  renderRecords(records);
}

function renderApplications(applications) {
  applicationCache = applications;
  if (!applications.length) {
    applicationsTarget.innerHTML = '<div class="empty-state">Новых заявок пока нет.</div>';
    return;
  }
  applicationsTarget.innerHTML = applications.map(item => `
    <article class="record-item application-item">
      <div class="application-details">
        <strong>${escapeHtml(item.team)}</strong> • ${escapeHtml(item.captain)}<br>
        ${escapeHtml(item.email)} • ${escapeHtml(item.contact)}<br>
        <b>Состав:</b><pre>${escapeHtml(item.roster)}</pre>
        ${item.message ? `<b>Комментарий:</b> ${escapeHtml(item.message)}<br>` : ""}
        <span class="record-subtitle">Получена: ${escapeHtml(item.submittedAt || "—")} • № ${escapeHtml(item.id)}</span>
      </div>
      <div class="record-actions">
        <select class="status-select" aria-label="Статус заявки" data-action="application-status" data-id="${escapeHtml(item.id)}">
          <option value="new"${(item.status || "new") === "new" ? " selected" : ""}>Новая</option>
          <option value="accepted"${item.status === "accepted" ? " selected" : ""}>Принята</option>
          <option value="rejected"${item.status === "rejected" ? " selected" : ""}>Отклонена</option>
        </select>
        <button class="button delete-button" type="button" data-action="delete-application" data-id="${escapeHtml(item.id)}">Удалить</button>
      </div>
    </article>`).join("");
}

async function loadApplications() {
  renderApplications(await api("/api/admin/applications"));
}

async function selectPanel(panel) {
  activePanel = panel;
  const isApplications = panel === "applications";
  collectionPanel.hidden = isApplications;
  applicationsPanel.hidden = !isApplications;
  dashboardMessage.textContent = "";
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.panel === panel));
  if (isApplications) {
    await loadApplications();
    return;
  }
  collectionTitle.textContent = definitions[panel].title;
  resetEditor();
  await loadRecords();
}

async function start() {
  try {
    const session = await api("/api/admin/session");
    if (session.authenticated) {
      dashboard.hidden = false;
      loginPanel.hidden = true;
      logoutButton.hidden = false;
      await selectPanel(activePanel);
    } else {
      loginPanel.hidden = false;
      if (session.setupRequired) {
        loginTitle.textContent = "Создайте пароль администратора";
        loginDescription.textContent = "Придумайте пароль длиной не менее 12 символов. Он сохранится на этом компьютере в зашифрованном виде.";
        confirmPasswordField.hidden = false;
        confirmAdminPassword.required = true;
        confirmAdminPassword.minLength = 12;
        document.getElementById("adminPassword").minLength = 12;
        document.getElementById("adminPassword").autocomplete = "new-password";
        loginButton.textContent = "Создать пароль";
        loginForm.dataset.mode = "setup";
      }
    }
  } catch (error) {
    loginPanel.hidden = true;
    showError(error);
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  loginMessage.textContent = "";
  const button = loginForm.querySelector("button");
  button.disabled = true;
  try {
    const settingUp = loginForm.dataset.mode === "setup";
    await api(settingUp ? "/api/admin/setup" : "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        password: new FormData(loginForm).get("password"),
        ...(settingUp ? { confirmPassword: new FormData(loginForm).get("confirmPassword") } : {})
      })
    });
    if (settingUp) {
      loginForm.dataset.mode = "";
      confirmPasswordField.hidden = true;
      confirmAdminPassword.required = false;
      loginTitle.textContent = "Вход в админ-панель";
      loginDescription.textContent = "Введите пароль администратора.";
      loginButton.textContent = "Войти";
    }
    loginForm.reset();
    loginPanel.hidden = true;
    dashboard.hidden = false;
    logoutButton.hidden = false;
    await selectPanel(activePanel);
  } catch (error) {
    loginMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector(".tabs").addEventListener("click", async event => {
  const button = event.target.closest("[data-panel]");
  if (!button) return;
  try {
    await selectPanel(button.dataset.panel);
  } catch (error) {
    showError(error);
  }
});

newRecordButton.addEventListener("click", () => resetEditor());
cancelEditButton.addEventListener("click", () => resetEditor());

recordsTarget.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  try {
    const record = (await api(`/api/admin/${activePanel}`)).find(item => item.id === button.dataset.id);
    if (!record) {
      showError(new Error("Запись не найдена. Обновите список."));
      return;
    }
    if (button.dataset.action === "edit") {
      editingId = record.id;
      editorTitle.textContent = `Изменить: ${definitions[activePanel].name(record)}`;
      editorFields.innerHTML = definitions[activePanel].fields.map(field =>
        renderField(field, record[field[0]] ?? "")
      ).join("");
      return;
    }
    if (button.dataset.action === "delete" && window.confirm(`Удалить «${definitions[activePanel].name(record)}»?`)) {
      await api(`/api/admin/${activePanel}/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
      if (editingId === button.dataset.id) resetEditor();
      await loadRecords();
    }
  } catch (error) {
    showError(error);
  }
});

recordForm.addEventListener("submit", async event => {
  event.preventDefault();
  dashboardMessage.textContent = "";
  const values = Object.fromEntries(new FormData(recordForm).entries());
  for (const field of definitions[activePanel].fields) {
    if (field[2] === "number") values[field[0]] = values[field[0]] === "" ? 0 : Number(values[field[0]]);
  }
  const url = `/api/admin/${activePanel}${editingId ? `/${encodeURIComponent(editingId)}` : ""}`;
  try {
    await api(url, {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify(values)
    });
    resetEditor();
    await loadRecords();
    dashboardMessage.textContent = "Изменения сохранены.";
  } catch (error) {
    dashboardMessage.textContent = error.message;
  }
});

applicationsTarget.addEventListener("change", async event => {
  const control = event.target.closest('[data-action="application-status"]');
  if (!control) return;
  try {
    await api(`/api/admin/applications/${encodeURIComponent(control.dataset.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: control.value })
    });
    dashboardMessage.textContent = "Статус заявки обновлён.";
    await loadApplications();
  } catch (error) {
    showError(error);
  }
});

applicationsTarget.addEventListener("click", async event => {
  const button = event.target.closest('[data-action="delete-application"]');
  if (!button) return;
  const application = applicationCache.find(item => item.id === button.dataset.id);
  if (!window.confirm(`Удалить заявку команды «${application?.team || ""}»?`)) return;
  try {
    await api(`/api/admin/applications/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
    await loadApplications();
  } catch (error) {
    showError(error);
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    dashboard.hidden = true;
    logoutButton.hidden = true;
    loginPanel.hidden = false;
  } catch (error) {
    showError(error);
  }
});

start();
