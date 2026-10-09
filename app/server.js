const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } = require("node:crypto");

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.resolve(ROOT, "..", "storage");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const APPLICATIONS_FILE = path.join(DATA_DIR, "applications.json");
const ADMIN_AUTH_FILE = path.join(DATA_DIR, "admin-auth.json");
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || (process.env.RENDER_SERVICE_ID ? "0.0.0.0" : "127.0.0.1");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_PASSWORD_VALID = ADMIN_PASSWORD.length >= 12;
const LOCAL_SERVER = ["127.0.0.1", "::1", "localhost"].includes(HOST);
const MAX_BODY_BYTES = 16 * 1024;
const applicationRates = new Map();
const adminLoginRates = new Map();
const adminSessions = new Map();
let fileWriteQueue = Promise.resolve();
const APPLICATION_STATUSES = new Set(["new", "accepted", "rejected"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Запрос слишком большой.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Не удалось прочитать форму. Заполните её заново.");
    error.statusCode = 400;
    throw error;
  }
}

async function readJsonFile(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function enqueueFileOperation(operation) {
  const queued = fileWriteQueue.then(operation);
  fileWriteQueue = queued.catch(() => {});
  return queued;
}

async function writeJsonAtomically(filename, value) {
  const temporaryFile = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporaryFile, filename);
  } finally {
    try {
      await fs.unlink(temporaryFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function initializeDataDirectory() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const initialData = await readJsonFile(path.join(ROOT, "data.json"), {
      players: [],
      teams: [],
      matches: [],
      leagues: []
    });
    if (!initialData || !["players", "teams", "matches", "leagues"].every(key => Array.isArray(initialData[key]))) {
      throw new Error("Начальные игровые данные имеют неверный формат.");
    }
    await writeJsonAtomically(DATA_FILE, initialData);
  }
}

function updateJsonFile(filename, fallback, update) {
  const queued = enqueueFileOperation(async () => {
    const current = await readJsonFile(filename, fallback);
    const result = await update(current);
    await writeJsonAtomically(filename, current);
    return result;
  });
  return queued;
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

function getAdminSession(request) {
  const cookies = (request.headers.cookie || "").split(";").map(value => value.trim());
  const token = cookies.find(value => value.startsWith("nexhltv_admin="))?.slice("nexhltv_admin=".length);
  if (!token) return false;
  const expiresAt = adminSessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function isLocalAdminRequest(request) {
  return LOCAL_SERVER && isLoopbackAddress(request.socket.remoteAddress);
}

function passwordRecordMatches(password, record) {
  if (!record || typeof record.salt !== "string" || typeof record.hash !== "string") return false;
  const expected = Buffer.from(record.hash, "hex");
  if (expected.length !== 64) return false;
  const actual = scryptSync(password, record.salt, 64);
  return timingSafeEqual(actual, expected);
}

function setAdminSession(response, request) {
  const token = randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
  response.setHeader("Set-Cookie", `nexhltv_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=43200${secure ? "; Secure" : ""}`);
}

function requireAdmin(request, response) {
  if (getAdminSession(request)) return true;
  sendJson(response, ADMIN_PASSWORD && !ADMIN_PASSWORD_VALID ? 503 : 401, {
    error: ADMIN_PASSWORD && !ADMIN_PASSWORD_VALID
      ? "Пароль ADMIN_PASSWORD должен содержать не менее 12 символов."
      : "Войдите в админ-панель."
  });
  return false;
}

function verifySameOrigin(request, response) {
  const origin = request.headers.origin;
  try {
    const scheme = request.headers["x-forwarded-proto"]?.split(",")[0] || (request.socket.encrypted ? "https" : "http");
    if (origin && new URL(origin).origin === `${scheme}://${request.headers.host}`) return true;
  } catch {
    // Invalid Origin headers are rejected below.
  }
  sendJson(response, 403, { error: "Запрос должен быть отправлен с сайта Nexhltv." });
  return false;
}

function checkAdminLoginLimit(request) {
  const ip = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (adminLoginRates.get(ip) || []).filter(timestamp => now - timestamp < 15 * 60 * 1000);
  if (recent.length >= 5) return false;
  recent.push(now);
  adminLoginRates.set(ip, recent);
  return true;
}

function passwordsMatch(candidate, expected) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function validateAdminRecord(collection, input, existing = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("Данные записи имеют неверный формат.");
    error.statusCode = 400;
    throw error;
  }
  const text = (key, fallback = "", required = false, limit = 160) => {
    const value = input[key] === undefined ? existing[key] ?? fallback : input[key];
    if (typeof value !== "string" || value.length > limit) {
      const error = new Error(`Поле «${key}» имеет неверный формат или слишком длинное.`);
      error.statusCode = 400;
      throw error;
    }
    const trimmed = value.trim();
    if (required && !trimmed) {
      const error = new Error(`Заполните поле «${key}».`);
      error.statusCode = 400;
      throw error;
    }
    return trimmed;
  };
  const number = (key, fallback = 0, { integer = false, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const value = input[key] === undefined ? existing[key] ?? fallback : input[key];
    if (value === "" || value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > max || (integer && !Number.isInteger(parsed))) {
      const error = new Error(`Поле «${key}» должно быть ${integer ? "целым " : ""}неотрицательным числом.`);
      error.statusCode = 400;
      throw error;
    }
    return parsed;
  };

  if (collection === "teams") {
    return {
      name: text("name", "", true),
      country: text("country", "", false, 80),
      matches: number("matches", 0, { integer: true }),
      wins: number("wins", 0, { integer: true }),
      losses: number("losses", 0, { integer: true }),
      rating: number("rating")
    };
  }
  if (collection === "players") {
    return {
      nickname: text("nickname", "", true),
      team: text("team"),
      country: text("country", "", false, 80),
      rank: number("rank", 0, { integer: true }),
      matches: number("matches", 0, { integer: true }),
      rating: number("rating"),
      winRate: number("winRate", 0, { max: 100 })
    };
  }
  if (collection === "matches") {
    return {
      date: text("date", "", true, 40),
      time: text("time", "", false, 40),
      home: text("home", "", true),
      away: text("away", "", true),
      status: text("status", "Запланирован", false, 80),
      event: text("event"),
      score: text("score", "", false, 40)
    };
  }
  return {
    name: text("name", "", true),
    date: text("date", "", false, 40),
    status: text("status", "Набор", false, 80),
    description: text("description", "", false, 1000)
  };
}

function checkApplicationLimit(request) {
  const ip = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (applicationRates.get(ip) || []).filter(timestamp => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 3) return false;
  recent.push(now);
  applicationRates.set(ip, recent);
  return true;
}

function validateApplication(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("Данные заявки имеют неверный формат.");
    error.statusCode = 400;
    throw error;
  }
  const fields = {
    team: typeof input.team === "string" ? input.team.trim() : "",
    captain: typeof input.captain === "string" ? input.captain.trim() : "",
    email: typeof input.email === "string" ? input.email.trim() : "",
    contact: typeof input.contact === "string" ? input.contact.trim() : "",
    roster: typeof input.roster === "string" ? input.roster.trim() : "",
    message: typeof input.message === "string" ? input.message.trim() : ""
  };
  if (Object.values(fields).some(value => value.length > 2000)) {
    const error = new Error("Одно из полей слишком длинное.");
    error.statusCode = 400;
    throw error;
  }
  if (!fields.team || !fields.captain || !fields.email || !fields.contact || !fields.roster) {
    const error = new Error("Заполните название команды, капитана, email, контакт и состав.");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
    const error = new Error("Укажите корректный email.");
    error.statusCode = 400;
    throw error;
  }
  return fields;
}

async function serveFile(response, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (!relative || relative.includes("\0")) {
    response.writeHead(400).end("Bad request");
    return;
  }
  const filename = path.resolve(ROOT, relative);
  if (!filename.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  const protectedPath = path.relative(ROOT, filename).toLowerCase();
  if (protectedPath === "applications.json"
    || protectedPath === "admin-auth.json"
    || protectedPath === "admin-password.txt"
    || protectedPath.endsWith(".tmp")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Файл не найден.");
    return;
  }
  try {
    const contents = await fs.readFile(filename);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Файл не найден.");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/api/data") {
      sendJson(response, 200, JSON.parse(await fs.readFile(DATA_FILE, "utf8")));
      return;
    }
    if (url.pathname === "/api/admin/session" && request.method === "GET") {
      if (ADMIN_PASSWORD && !ADMIN_PASSWORD_VALID) {
        sendJson(response, 503, { error: "Пароль ADMIN_PASSWORD должен содержать не менее 12 символов." });
        return;
      }
      const localAuth = ADMIN_PASSWORD_VALID ? null : await readJsonFile(ADMIN_AUTH_FILE, null);
      if (!ADMIN_PASSWORD_VALID && !LOCAL_SERVER) {
        sendJson(response, 503, { error: "Админ-панель отключена. Настройте ADMIN_PASSWORD." });
        return;
      }
      sendJson(response, 200, {
        authenticated: getAdminSession(request),
        setupRequired: !ADMIN_PASSWORD_VALID && !localAuth,
        authConfigured: ADMIN_PASSWORD_VALID || Boolean(localAuth),
        instance: "nexhltv"
      });
      return;
    }
    if (url.pathname === "/api/admin/setup" && request.method === "POST") {
      if (!verifySameOrigin(request, response)) return;
      if (!isLocalAdminRequest(request) || ADMIN_PASSWORD) {
        sendJson(response, 403, { error: "Создать пароль можно только при первом запуске на этом компьютере." });
        return;
      }
      if (!checkAdminLoginLimit(request)) {
        sendJson(response, 429, { error: "Слишком много попыток. Попробуйте через 15 минут." });
        return;
      }
      const body = await readJson(request);
      if (typeof body?.password !== "string" || body.password.length < 12 || body.password.length > 128) {
        sendJson(response, 400, { error: "Пароль должен содержать от 12 до 128 символов." });
        return;
      }
      if (body.password !== body.confirmPassword) {
        sendJson(response, 400, { error: "Пароли не совпадают." });
        return;
      }
      const saved = await enqueueFileOperation(async () => {
        const existing = await readJsonFile(ADMIN_AUTH_FILE, null);
        if (existing) return false;
        const salt = randomBytes(16).toString("hex");
        const hash = scryptSync(body.password, salt, 64).toString("hex");
        await writeJsonAtomically(ADMIN_AUTH_FILE, { salt, hash });
        return true;
      });
      if (!saved) {
        sendJson(response, 409, { error: "Пароль уже создан. Войдите с ним." });
        return;
      }
      setAdminSession(response, request);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      if (ADMIN_PASSWORD && !ADMIN_PASSWORD_VALID) {
        sendJson(response, 503, { error: "Пароль ADMIN_PASSWORD должен содержать не менее 12 символов." });
        return;
      }
      if (!ADMIN_PASSWORD_VALID && !LOCAL_SERVER) {
        sendJson(response, 503, { error: "Настройте ADMIN_PASSWORD в переменных окружения сервера." });
        return;
      }
      if (!verifySameOrigin(request, response)) return;
      if (!checkAdminLoginLimit(request)) {
        sendJson(response, 429, { error: "Слишком много попыток входа. Попробуйте через 15 минут." });
        return;
      }
      const body = await readJson(request);
      const localAuth = ADMIN_PASSWORD_VALID ? null : await readJsonFile(ADMIN_AUTH_FILE, null);
      const authenticated = typeof body?.password === "string" && (
        ADMIN_PASSWORD_VALID
          ? passwordsMatch(body.password, ADMIN_PASSWORD)
          : passwordRecordMatches(body.password, localAuth)
      );
      if (!authenticated) {
        sendJson(response, 401, { error: "Неверный пароль." });
        return;
      }
      setAdminSession(response, request);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/admin/logout" && request.method === "POST") {
      if (!verifySameOrigin(request, response)) return;
      const cookies = (request.headers.cookie || "").split(";").map(value => value.trim());
      const token = cookies.find(value => value.startsWith("nexhltv_admin="))?.slice("nexhltv_admin=".length);
      if (token) adminSessions.delete(token);
      response.setHeader("Set-Cookie", "nexhltv_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0");
      sendJson(response, 200, { ok: true });
      return;
    }
    const adminApplicationMatch = url.pathname.match(/^\/api\/admin\/applications(?:\/([^/]+))?$/);
    if (adminApplicationMatch) {
      if (!requireAdmin(request, response)) return;
      if (request.method === "GET" && !adminApplicationMatch[1]) {
        const applications = await readJsonFile(APPLICATIONS_FILE, []);
        if (!Array.isArray(applications)) throw new Error("Хранилище заявок имеет неверный формат.");
        sendJson(response, 200, applications.map(application => ({ ...application, status: application.status || "new" })));
        return;
      }
      if (!verifySameOrigin(request, response)) return;
      const applicationId = adminApplicationMatch[1] ? decodeURIComponent(adminApplicationMatch[1]) : "";
      if (request.method === "PATCH" && applicationId) {
        const body = await readJson(request);
        if (!APPLICATION_STATUSES.has(body?.status)) {
          sendJson(response, 400, { error: "Выберите корректный статус заявки." });
          return;
        }
        const updated = await updateJsonFile(APPLICATIONS_FILE, [], applications => {
          if (!Array.isArray(applications)) throw new Error("Хранилище заявок имеет неверный формат.");
          const application = applications.find(item => item.id === applicationId);
          if (!application) return false;
          application.status = body.status;
          return true;
        });
        if (!updated) {
          sendJson(response, 404, { error: "Заявка не найдена." });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "DELETE" && applicationId) {
        const deleted = await updateJsonFile(APPLICATIONS_FILE, [], applications => {
          if (!Array.isArray(applications)) throw new Error("Хранилище заявок имеет неверный формат.");
          const index = applications.findIndex(item => item.id === applicationId);
          if (index === -1) return false;
          applications.splice(index, 1);
          return true;
        });
        if (!deleted) {
          sendJson(response, 404, { error: "Заявка не найдена." });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      response.writeHead(405, { Allow: "GET, PATCH, DELETE" }).end();
      return;
    }
    const adminCollectionMatch = url.pathname.match(/^\/api\/admin\/(players|teams|matches|leagues)(?:\/([^/]+))?$/);
    if (adminCollectionMatch) {
      if (!requireAdmin(request, response)) return;
      const [, collection, encodedId] = adminCollectionMatch;
      const recordId = encodedId ? decodeURIComponent(encodedId) : "";
      if (request.method === "GET" && !recordId) {
        const data = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
        sendJson(response, 200, data[collection]);
        return;
      }
      if (!verifySameOrigin(request, response)) return;
      if (request.method === "POST" && !recordId) {
        const record = { id: randomUUID(), ...validateAdminRecord(collection, await readJson(request)) };
        await updateJsonFile(DATA_FILE, null, data => {
          if (!data || !Array.isArray(data[collection])) throw new Error(`Коллекция ${collection} отсутствует в data.json.`);
          data[collection].push(record);
        });
        sendJson(response, 201, record);
        return;
      }
      if (request.method === "PUT" && recordId) {
        const input = await readJson(request);
        const updated = await updateJsonFile(DATA_FILE, null, data => {
          if (!data || !Array.isArray(data[collection])) throw new Error(`Коллекция ${collection} отсутствует в data.json.`);
          const index = data[collection].findIndex(item => item.id === recordId);
          if (index === -1) return null;
          data[collection][index] = {
            id: recordId,
            ...validateAdminRecord(collection, input, data[collection][index])
          };
          return data[collection][index];
        });
        if (!updated) {
          sendJson(response, 404, { error: "Запись не найдена." });
          return;
        }
        sendJson(response, 200, updated);
        return;
      }
      if (request.method === "DELETE" && recordId) {
        const deleted = await updateJsonFile(DATA_FILE, null, data => {
          if (!data || !Array.isArray(data[collection])) throw new Error(`Коллекция ${collection} отсутствует в data.json.`);
          const index = data[collection].findIndex(item => item.id === recordId);
          if (index === -1) return false;
          data[collection].splice(index, 1);
          return true;
        });
        if (!deleted) {
          sendJson(response, 404, { error: "Запись не найдена." });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      response.writeHead(405, { Allow: "GET, POST, PUT, DELETE" }).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/applications") {
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        sendJson(response, 403, { error: "Отправляйте заявку с сайта Nexhltv." });
        return;
      }
      if (!checkApplicationLimit(request)) {
        sendJson(response, 429, { error: "Слишком много заявок. Попробуйте позже." });
        return;
      }
      const application = {
        id: randomUUID(),
        submittedAt: new Date().toISOString(),
        ...validateApplication(await readJson(request))
      };
      await updateJsonFile(APPLICATIONS_FILE, [], applications => {
        if (!Array.isArray(applications)) throw new Error("Хранилище заявок имеет неверный формат.");
        applications.push(application);
      });
      sendJson(response, 201, { ok: true, id: application.id });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD, POST" }).end();
      return;
    }
    await serveFile(response, url.pathname);
  } catch (error) {
    console.error(`[${request.method} ${url.pathname}]`, error);
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 500, {
        error: error.statusCode ? error.message : "Ошибка сервера. Повторите попытку позже."
      });
    } else {
      response.destroy(error);
    }
  }
});

server.listen(PORT, HOST, async () => {
  try {
    await initializeDataDirectory();
  } catch (error) {
    console.error(`Не удалось подготовить папку для данных ${DATA_DIR}:`, error);
    server.close();
    return;
  }
  console.log(`Nexhltv доступен: http://${HOST}:${PORT}`);
  if (ADMIN_PASSWORD && !ADMIN_PASSWORD_VALID) {
    console.warn("Админ-панель отключена: ADMIN_PASSWORD должен содержать не менее 12 символов.");
  } else if (!ADMIN_PASSWORD_VALID && !LOCAL_SERVER) {
    console.warn("Админ-панель отключена: задайте ADMIN_PASSWORD в переменных окружения.");
  } else if (!ADMIN_PASSWORD_VALID) {
    console.log("При первом открытии админ-панели создайте собственный пароль.");
  }
});
