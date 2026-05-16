const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '.env');

if (fs.existsSync(ENV_FILE)) {
  const envLines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);

  envLines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'http://127.0.0.1:3000';
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:3000,http://localhost:3000')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const AUTH_USERS_FILE = path.join(__dirname, 'data', 'users.json');
const ACTIVITIES_FILE = path.join(__dirname, 'data', 'activities.json');
const GOOGLE_TOKENS_FILE = path.join(__dirname, 'data', 'google-refresh-tokens.json');

const AUTH_SESSION_COOKIE = 'clearup_session';

function ensureDataFile(filePath, fallback) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
  }
}

function loadJson(filePath, fallback) {
  ensureDataFile(filePath, fallback);

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, value) {
  ensureDataFile(filePath, value);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sanitizeSession(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
  };
}

function parseCookies(header) {
  const entries = {};

  if (!header) {
    return entries;
  }

  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) {
      return;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    entries[key] = decodeURIComponent(value);
  });

  return entries;
}

function readSession(request) {
  const cookies = parseCookies(request.headers.cookie || '');
  const raw = cookies[AUTH_SESSION_COOKIE];

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cookieOptions(maxAge) {
  const parts = [
    'Path=/',
    'HttpOnly',
    `SameSite=${IS_PRODUCTION ? 'None' : 'Lax'}`,
    `Max-Age=${maxAge}`,
  ];

  if (IS_PRODUCTION) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function setJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(request, response) {
  const origin = request.headers.origin;

  if (origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.length === 0)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
  }

  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS');
  response.setHeader('Vary', 'Origin');
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

function normalizeActivities(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const validTypes = new Set(['assignment', 'exam', 'project']);
  const validPriorities = new Set(['high', 'medium', 'low']);
  const validStatuses = new Set(['pending', 'inProgress', 'completed']);

  return value
    .map((activity) => {
      if (!activity || typeof activity !== 'object') {
        return null;
      }

      const subtasks = Array.isArray(activity.subtasks)
        ? activity.subtasks
            .map((subtask) => {
              if (!subtask || typeof subtask !== 'object') {
                return null;
              }

              const id = Number(subtask.id);
              const title = typeof subtask.title === 'string' ? subtask.title.trim() : '';

              if (!Number.isFinite(id) || !title) {
                return null;
              }

              return {
                id,
                title,
                done: Boolean(subtask.done),
              };
            })
            .filter(Boolean)
        : [];

      const normalized = {
        id: Number(activity.id),
        title: typeof activity.title === 'string' ? activity.title.trim() : '',
        course: typeof activity.course === 'string' ? activity.course.trim() : '',
        type: typeof activity.type === 'string' ? activity.type : '',
        dueDate: typeof activity.dueDate === 'string' ? activity.dueDate : '',
        priority: typeof activity.priority === 'string' ? activity.priority : '',
        status: typeof activity.status === 'string' ? activity.status : '',
        reminder: typeof activity.reminder === 'string' ? activity.reminder : '',
        progress: Math.max(0, Math.min(100, Number(activity.progress) || 0)),
        subtasks,
      };

      if (
        !Number.isFinite(normalized.id) ||
        !normalized.title ||
        !validTypes.has(normalized.type) ||
        !validPriorities.has(normalized.priority) ||
        !validStatuses.has(normalized.status)
      ) {
        return null;
      }

      return normalized;
    })
    .filter(Boolean);
}

function getUsers() {
  const users = loadJson(AUTH_USERS_FILE, []);
  return Array.isArray(users) ? users : [];
}

function saveUsers(users) {
  saveJson(AUTH_USERS_FILE, users);
}

function getActivitiesMap() {
  const activities = loadJson(ACTIVITIES_FILE, {});
  return activities && typeof activities === 'object' ? activities : {};
}

function saveActivitiesMap(activitiesMap) {
  saveJson(ACTIVITIES_FILE, activitiesMap);
}

function getGoogleTokens() {
  const tokens = loadJson(GOOGLE_TOKENS_FILE, {});
  return tokens && typeof tokens === 'object' ? tokens : {};
}

function saveGoogleTokens(tokens) {
  saveJson(GOOGLE_TOKENS_FILE, tokens);
}

async function handleAuthSession(request, response) {
  const session = readSession(request);

  if (!session) {
    setJson(response, 401, { error: 'No hay sesión activa de ClearUp.' });
    return;
  }

  setJson(response, 200, { user: session });
}

async function handleSignUp(request, response) {
  const body = await readBody(request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!name || !email || password.length < 6) {
    setJson(response, 400, { error: 'Completa nombre, correo y una contraseña de al menos 6 caracteres.' });
    return;
  }

  const users = getUsers();
  if (users.some((user) => user.email === email)) {
    setJson(response, 409, { error: 'Ya existe una cuenta con ese correo.' });
    return;
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: sha256(password),
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  saveUsers(users);

  const session = sanitizeSession(user);
  setJson(
    response,
    200,
    { ok: true, user: session },
    { 'Set-Cookie': `${AUTH_SESSION_COOKIE}=${encodeURIComponent(JSON.stringify(session))}; ${cookieOptions(60 * 60 * 24 * 7)}` },
  );
}

async function handleSignIn(request, response) {
  const body = await readBody(request);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!email || !password) {
    setJson(response, 400, { error: 'Ingresa tu correo y contraseña.' });
    return;
  }

  const users = getUsers();
  const passwordHash = sha256(password);
  const user = users.find((candidate) => candidate.email === email && candidate.passwordHash === passwordHash);

  if (!user) {
    setJson(response, 401, { error: 'Correo o contraseña incorrectos.' });
    return;
  }

  const session = sanitizeSession(user);
  setJson(
    response,
    200,
    { ok: true, user: session },
    { 'Set-Cookie': `${AUTH_SESSION_COOKIE}=${encodeURIComponent(JSON.stringify(session))}; ${cookieOptions(60 * 60 * 24 * 7)}` },
  );
}

async function handleSignOut(_request, response) {
  setJson(
    response,
    200,
    { ok: true },
    { 'Set-Cookie': `${AUTH_SESSION_COOKIE}=; ${cookieOptions(0)}` },
  );
}

async function handleProfileGet(request, response) {
  const session = readSession(request);

  if (!session) {
    setJson(response, 401, { error: 'No hay sesión activa de ClearUp.' });
    return;
  }

  setJson(response, 200, { user: session });
}

async function handleProfilePatch(request, response) {
  const session = readSession(request);

  if (!session) {
    setJson(response, 401, { error: 'Tu sesión ya no está activa.' });
    return;
  }

  const body = await readBody(request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!name || !email) {
    setJson(response, 400, { error: 'Completa tu nombre y correo.' });
    return;
  }

  if (password && password.length < 6) {
    setJson(response, 400, { error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    return;
  }

  const users = getUsers();
  const existingByEmail = users.find((user) => user.email === email && user.id !== session.id);
  if (existingByEmail) {
    setJson(response, 409, { error: 'Ya existe otra cuenta con ese correo.' });
    return;
  }

  const index = users.findIndex((user) => user.id === session.id);
  if (index === -1) {
    setJson(response, 404, { error: 'No se encontró tu cuenta actual.' });
    return;
  }

  const nextUser = {
    ...users[index],
    name,
    email,
    passwordHash: password ? sha256(password) : users[index].passwordHash,
  };

  users[index] = nextUser;
  saveUsers(users);

  const nextSession = sanitizeSession(nextUser);
  setJson(
    response,
    200,
    { ok: true, user: nextSession },
    { 'Set-Cookie': `${AUTH_SESSION_COOKIE}=${encodeURIComponent(JSON.stringify(nextSession))}; ${cookieOptions(60 * 60 * 24 * 7)}` },
  );
}

async function handleActivitiesGet(request, response) {
  const session = readSession(request);

  if (!session) {
    setJson(response, 401, { error: 'No hay sesión activa de ClearUp.' });
    return;
  }

  const activitiesMap = getActivitiesMap();
  setJson(response, 200, { activities: normalizeActivities(activitiesMap[session.id] || []) });
}

async function handleActivitiesPut(request, response) {
  const session = readSession(request);

  if (!session) {
    setJson(response, 401, { error: 'No hay sesión activa de ClearUp.' });
    return;
  }

  const body = await readBody(request);
  const activities = normalizeActivities(body?.activities);
  const activitiesMap = getActivitiesMap();
  activitiesMap[session.id] = activities;
  saveActivitiesMap(activitiesMap);

  setJson(response, 200, { ok: true, activities });
}

async function handleGoogleConnect(request, response, url) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const locale = url.searchParams.get('locale') || 'es';

  if (!clientId || !redirectUri) {
    setJson(response, 500, { error: 'Faltan variables GOOGLE_CLIENT_ID o GOOGLE_REDIRECT_URI.' });
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    include_granted_scopes: 'true',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    prompt: 'consent',
    state: JSON.stringify({ locale }),
  });

  response.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  response.end();
}

async function handleGoogleCallback(request, response, url) {
  const session = readSession(request);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    setJson(response, 400, { error });
    return;
  }

  if (!session) {
    setJson(response, 401, { error: 'No hay sesión activa de ClearUp para vincular Google Calendar.' });
    return;
  }

  if (!code) {
    setJson(response, 400, { error: 'Missing authorization code' });
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    setJson(response, 500, { error: 'Faltan variables GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o GOOGLE_REDIRECT_URI.' });
    return;
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    setJson(response, 500, { error: 'Error intercambiando el código por tokens', details: await tokenResponse.text() });
    return;
  }

  const tokenJson = await tokenResponse.json();
  if (!tokenJson.refresh_token) {
    setJson(response, 500, { error: 'Google no devolvió refresh_token.' });
    return;
  }

  const tokens = getGoogleTokens();
  tokens[session.id] = tokenJson.refresh_token;
  saveGoogleTokens(tokens);

  let locale = 'es';
  if (stateParam) {
    try {
      const parsed = JSON.parse(stateParam);
      if (parsed.locale) {
        locale = parsed.locale;
      }
    } catch {
      // ignore
    }
  }

  response.writeHead(302, { Location: `${FRONTEND_BASE_URL}/${locale}/calendar` });
  response.end();
}

async function refreshGoogleAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Faltan variables GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET.');
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(await tokenResponse.text());
  }

  const payload = await tokenResponse.json();
  return payload.access_token;
}

async function handleGoogleEvents(request, response, url) {
  const session = readSession(request);

  if (!session) {
    setJson(response, 401, { error: 'No hay sesión activa de ClearUp.' });
    return;
  }

  const timeMin = url.searchParams.get('timeMin');
  const timeMax = url.searchParams.get('timeMax');

  if (!timeMin || !timeMax) {
    setJson(response, 400, { error: 'Debes enviar timeMin y timeMax en formato ISO.' });
    return;
  }

  const tokens = getGoogleTokens();
  const refreshToken = tokens[session.id];

  if (!refreshToken) {
    setJson(response, 401, { error: 'No hay sesión de Google Calendar activa.' });
    return;
  }

  try {
    const accessToken = await refreshGoogleAccessToken(refreshToken);
    const googleUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    googleUrl.searchParams.set('timeMin', timeMin);
    googleUrl.searchParams.set('timeMax', timeMax);
    googleUrl.searchParams.set('singleEvents', 'true');
    googleUrl.searchParams.set('orderBy', 'startTime');

    const eventsResponse = await fetch(googleUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!eventsResponse.ok) {
      setJson(response, 500, { error: 'Error obteniendo eventos de Google Calendar', details: await eventsResponse.text() });
      return;
    }

    const payload = await eventsResponse.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const events = items.map((event) => ({
      id: event.id,
      title: event.summary || '(Sin título)',
      start: event.start?.dateTime || event.start?.date || null,
      end: event.end?.dateTime || event.end?.date || null,
      source: 'google',
    }));

    setJson(response, 200, { events });
  } catch (error) {
    setJson(response, 500, { error: 'Error al obtener eventos desde Google Calendar', details: error.message });
  }
}

const server = http.createServer(async (request, response) => {
  setCorsHeaders(request, response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    setJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/session') {
    await handleAuthSession(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/sign-up') {
    await handleSignUp(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/sign-in') {
    await handleSignIn(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/sign-out') {
    await handleSignOut(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/profile') {
    await handleProfileGet(request, response);
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/auth/profile') {
    await handleProfilePatch(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/activities') {
    await handleActivitiesGet(request, response);
    return;
  }

  if (request.method === 'PUT' && url.pathname === '/api/activities') {
    await handleActivitiesPut(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/google-calendar/connect') {
    await handleGoogleConnect(request, response, url);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/google-calendar/callback') {
    await handleGoogleCallback(request, response, url);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/google-calendar/events') {
    await handleGoogleEvents(request, response, url);
    return;
  }

  setJson(response, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`ClearUp backend listening on http://127.0.0.1:${PORT}`);
});
