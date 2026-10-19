const NOTION_VERSION = "2026-03-11";
const NOTION_API = "https://api.notion.com/v1";
const SESSION_SECONDS = 15 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 5;
const MAX_NOTION_PAGES_PER_SOURCE = 8;
const MAX_WRITES_PER_SYNC = 8;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

async function readJsonBounded(request, limitBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limitBytes) {
      await reader.cancel();
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("INVALID_JSON"); }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== env.WEB_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "vary": "Origin",
  };
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    difference |= (left[i] || 0) ^ (right[i] || 0);
  }
  return difference === 0;
}

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromBase64url = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signSession(env, now = Date.now()) {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    sub: "goalflow-user", iss: "goalflow-worker", aud: "goalflow-client",
    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + SESSION_SECONDS,
  })));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SIGNING_SECRET), new TextEncoder().encode(input));
  return `${input}.${base64url(signature)}`;
}

async function verifySession(token, env, now = Date.now()) {
  const pieces = token.split(".");
  if (pieces.length !== 3) return false;
  try {
    const input = `${pieces[0]}.${pieces[1]}`;
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SIGNING_SECRET), fromBase64url(pieces[2]), new TextEncoder().encode(input));
    if (!valid) return false;
    const header = JSON.parse(new TextDecoder().decode(fromBase64url(pieces[0])));
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(pieces[1])));
    return header.alg === "HS256" && claims.sub === "goalflow-user" && claims.iss === "goalflow-worker" && claims.aud === "goalflow-client" && claims.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

async function rateLimitKey(request, env) {
  const address = request.headers.get("CF-Connecting-IP");
  if (!address) throw new Error("LOGIN_RATE_LIMIT_UNAVAILABLE");
  const key = await hmacKey(env.SESSION_SIGNING_SECRET);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(address));
  return base64url(digest);
}

async function allowLogin(request, env, now = Math.floor(Date.now() / 1000)) {
  if (!env.DB) throw new Error("LOGIN_RATE_LIMIT_UNAVAILABLE");
  const key = await rateLimitKey(request, env);
  await env.DB.prepare(`INSERT INTO login_attempts (ip_hash, window_started, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      attempts = CASE WHEN window_started <= ? THEN 1 ELSE attempts + 1 END,
      window_started = CASE WHEN window_started <= ? THEN excluded.window_started ELSE window_started END`)
    .bind(key, now, now - LOGIN_WINDOW_SECONDS, now - LOGIN_WINDOW_SECONDS).run();
  const row = await env.DB.prepare("SELECT attempts FROM login_attempts WHERE ip_hash = ?").bind(key).first();
  return Number(row?.attempts || 0) <= LOGIN_MAX_ATTEMPTS;
}

function normalizeEntity(entity, kind) {
  if (!entity || typeof entity.id !== "string" || !entity.id || typeof entity.title !== "string") throw new Error("INVALID_ENTITY");
  if (kind === "goal") {
    return { id: entity.id, title: entity.title, deadline: entity.deadline || "", progress: Number.isFinite(entity.progress) ? Math.max(0, Math.min(100, entity.progress)) : 0 };
  }
  return {
    id: entity.id, title: entity.title, deadline: entity.deadline || "",
    done: entity.done === true, goalId: entity.goalId || "", parentTaskId: entity.parentTaskId || "",
  };
}

function stable(value) { return JSON.stringify(value); }
function richText(value) { return [{ type: "text", text: { content: value } }]; }
function propertyText(properties, name) {
  const p = properties?.[name];
  if (p?.type === "title") return p.title?.map(x => x.plain_text || x.text?.content || "").join("") || "";
  if (p?.type === "rich_text") return p.rich_text?.map(x => x.plain_text || x.text?.content || "").join("") || "";
  return "";
}

function fromNotion(page, kind, relatedPages = new Map(), properties = page.properties || {}) {
  const id = propertyText(properties, "GoalFlow ID");
  if (!id) return null;
  if (kind === "goal") {
    return normalizeEntity({
      id, title: propertyText(properties, "Name"),
      deadline: properties.Deadline?.date?.start || "", progress: properties.Progress?.number ?? 0,
    }, kind);
  }
  const relations = (name) => properties[name]?.relation?.map(x => x.id) || [];
  const goalRelations = relations("Goal");
  const parentRelations = relations("Parent Task");
  if (goalRelations.length !== 1) throw new Error("NOTION_GOAL_RELATION_REQUIRED");
  if (goalRelations.length > 1 || parentRelations.length > 1) throw new Error("NOTION_RELATION_NOT_UNIQUE");
  if ((goalRelations.length && !relatedPages.has(goalRelations[0])) || (parentRelations.length && !relatedPages.has(parentRelations[0]))) throw new Error("NOTION_RELATION_OUTSIDE_SYNC");
  return normalizeEntity({
    id, title: propertyText(properties, "Name"), deadline: properties["Due Date"]?.date?.start || "",
    done: properties.Status?.status?.name === "Done" || properties.Status?.select?.name === "Done",
    goalId: relatedPages.get(goalRelations[0]) || "",
    parentTaskId: relatedPages.get(parentRelations[0]) || "",
  }, kind);
}

async function notionRequest(env, path, init = {}, attempt = 0) {
  const response = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.NOTION_TOKEN}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const method = (init.method || "GET").toUpperCase();
  const retryableRequest = method !== "POST" || path.endsWith("/query");
  if ((response.status === 429 || (response.status >= 500 && retryableRequest)) && attempt < 3) {
    const retryValue = response.headers.get("Retry-After");
    const seconds = Number(retryValue);
    const retryDate = retryValue && !Number.isFinite(seconds) ? Date.parse(retryValue) : NaN;
    const delay = retryValue
      ? (Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, retryDate - Date.now()))
      : 250 * (2 ** attempt);
    await response.body?.cancel();
    if (delay > 10_000) throw new Error("NOTION_RETRY_LATER");
    await new Promise(resolve => setTimeout(resolve, delay));
    return notionRequest(env, path, init, attempt + 1);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`NOTION_${response.status}_${body.code || "API_ERROR"}`);
  }
  return response.json();
}

async function listNotionEntities(env, kind, related = new Map()) {
  const dataSource = kind === "goal" ? env.GOALS_DATA_SOURCE_ID : env.TASKS_DATA_SOURCE_ID;
  const entities = new Map();
  const pageRows = [];
  let cursor;
  let pages = 0;
  do {
    if (++pages > MAX_NOTION_PAGES_PER_SOURCE) throw new Error("SYNC_PAGE_LIMIT");
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const result = await notionRequest(env, `/data_sources/${encodeURIComponent(dataSource)}/query`, { method: "POST", body: JSON.stringify(body) });
    if (!Array.isArray(result.results) || (result.has_more && !result.next_cursor) || result.request_status?.type === "incomplete") throw new Error("NOTION_INCOMPLETE_PAGE");
    pageRows.push(...(result.results || []));
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  const pageToStableId = new Map([...related.values()].map(x => [x.pageId, x.entity.id]));
  if (kind === "task") {
    for (const page of pageRows) {
      const id = propertyText(page.properties, "GoalFlow ID");
      if (id) pageToStableId.set(page.id, id);
    }
  }
  for (const page of pageRows) {
    const entity = fromNotion(page, kind, pageToStableId);
    if (entity) {
      if (entities.has(entity.id)) throw new Error("NOTION_DUPLICATE_GOALFLOW_ID");
      entities.set(entity.id, { entity, pageId: page.id, edited: page.last_edited_time });
    }
  }
  return entities;
}

function relationId(snapshot, entityId, kind) {
  if (!entityId) return undefined;
  const record = snapshot.get(entityId);
  return record?.pageId || undefined;
}

function notionProperties(entity, kind, goals, tasks) {
  if (kind === "goal") {
    return {
      "Name": { title: richText(entity.title) },
      "GoalFlow ID": { rich_text: richText(entity.id) },
      "Deadline": { date: entity.deadline ? { start: entity.deadline } : null },
      "Progress": { number: entity.progress },
    };
  }
  const goalPageId = relationId(goals, entity.goalId, "goal");
  const parentPageId = relationId(tasks, entity.parentTaskId, "task");
  return {
    "Name": { title: richText(entity.title) },
    "GoalFlow ID": { rich_text: richText(entity.id) },
    "Due Date": { date: entity.deadline ? { start: entity.deadline } : null },
    "Status": { select: { name: entity.done ? "Done" : "Todo" } },
    "Goal": { relation: goalPageId ? [{ id: goalPageId }] : [] },
    "Parent Task": { relation: parentPageId ? [{ id: parentPageId }] : [] },
  };
}

function mergedEntities(localList, baseList, remoteMap, kind, conflicts) {
  const uniqueMap = (list) => {
    const map = new Map();
    for (const value of list) {
      const entity = normalizeEntity(value, kind);
      if (map.has(entity.id)) throw new Error("DUPLICATE_LOCAL_ID");
      map.set(entity.id, entity);
    }
    return map;
  };
  const local = uniqueMap(localList);
  const base = uniqueMap(baseList);
  const merged = new Map();
  const toWrite = [];
  const ids = new Set([...local.keys(), ...base.keys(), ...remoteMap.keys()]);
  for (const id of ids) {
    const l = local.get(id), b = base.get(id), remoteRecord = remoteMap.get(id), r = remoteRecord?.entity;
    if (!l && !r) continue;
    if (!l) { merged.set(id, r); continue; } // Local absence never means delete.
    if (!r) {
      if (b) { merged.set(id, l); continue; } // A missing remote row is ambiguous; never recreate/delete automatically.
      merged.set(id, l); toWrite.push(l); continue;
    }
    if (!b) {
      if (stable(l) !== stable(r)) conflicts.push({ kind, id, local: l, notion: r, reason: "both-created" });
      else merged.set(id, r);
      if (stable(l) === stable(r)) merged.set(id, r);
      continue;
    }
    const localChanged = stable(l) !== stable(b), remoteChanged = stable(r) !== stable(b);
    if (localChanged && remoteChanged && stable(l) !== stable(r)) {
      conflicts.push({ kind, id, local: l, notion: r, reason: "both-changed" });
      merged.set(id, b);
    } else if (localChanged && !remoteChanged) {
      merged.set(id, l); toWrite.push(l);
    } else {
      merged.set(id, r);
    }
  }
  return { merged, toWrite };
}

async function writeEntity(env, entity, kind, goals, tasks) {
  const source = kind === "goal" ? env.GOALS_DATA_SOURCE_ID : env.TASKS_DATA_SOURCE_ID;
  const properties = notionProperties(entity, kind, goals, tasks);
  const existing = (kind === "goal" ? goals : tasks).get(entity.id);
  if (existing) {
    // Re-read before update. Notion has no conditional-write API; this narrows but cannot eliminate races.
    const latest = await notionRequest(env, `/pages/${encodeURIComponent(existing.pageId)}`);
    if (latest.last_edited_time !== existing.edited) throw new Error("NOTION_CHANGED_DURING_SYNC");
    return notionRequest(env, `/pages/${encodeURIComponent(existing.pageId)}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  }
  return notionRequest(env, "/pages", { method: "POST", body: JSON.stringify({ parent: { type: "data_source_id", data_source_id: source }, properties }) });
}

async function synchronize(body, env) {
  if (!body || !body.local || !body.base || !Array.isArray(body.local.goals) || !Array.isArray(body.local.tasks) || !Array.isArray(body.base.goals) || !Array.isArray(body.base.tasks)) throw new Error("INVALID_SYNC_PAYLOAD");
  const remoteGoals = await listNotionEntities(env, "goal");
  const remoteTasks = await listNotionEntities(env, "task", remoteGoals);
  const conflicts = [];
  const goals = mergedEntities(body.local.goals, body.base.goals, remoteGoals, "goal", conflicts);
  const tasks = mergedEntities(body.local.tasks, body.base.tasks, remoteTasks, "task", conflicts);
  if (conflicts.length) return { status: "conflict", conflicts, snapshot: { goals: body.local.goals, tasks: body.local.tasks } };
  if (goals.toWrite.length + tasks.toWrite.length > MAX_WRITES_PER_SYNC) throw new Error("SYNC_WRITE_LIMIT");

  for (const task of tasks.merged.values()) {
    if (!task.goalId || !goals.merged.has(task.goalId)) throw new Error("TASK_GOAL_MISSING");
    if (task.parentTaskId) {
      const parent = tasks.merged.get(task.parentTaskId);
      if (!parent || parent.goalId !== task.goalId || parent.id === task.id) throw new Error("TASK_PARENT_INVALID");
    }
  }
  const checked = new Set();
  const visiting = new Set();
  const validateTaskTree = (task) => {
    if (checked.has(task.id)) return;
    if (visiting.has(task.id)) throw new Error("TASK_PARENT_CYCLE");
    visiting.add(task.id);
    const parent = task.parentTaskId ? tasks.merged.get(task.parentTaskId) : undefined;
    if (parent) validateTaskTree(parent);
    visiting.delete(task.id);
    checked.add(task.id);
  };
  for (const task of tasks.merged.values()) validateTaskTree(task);
  const availableGoalIds = new Set([...remoteGoals.keys(), ...goals.toWrite.map(x => x.id)]);
  const availableTaskIds = new Set([...remoteTasks.keys(), ...tasks.toWrite.map(x => x.id)]);
  for (const task of tasks.toWrite) {
    if (!availableGoalIds.has(task.goalId)) throw new Error("TASK_RELATION_TARGET_MISSING");
    if (task.parentTaskId && !availableTaskIds.has(task.parentTaskId)) throw new Error("TASK_RELATION_TARGET_MISSING");
  }

  // Resolve relations against the merged goal/task sets; parent tasks are created before children.
  for (const entity of goals.toWrite) {
    const page = await writeEntity(env, entity, "goal", remoteGoals, remoteTasks);
    remoteGoals.set(entity.id, { entity, pageId: page.id || remoteGoals.get(entity.id)?.pageId, edited: page.last_edited_time });
  }
  const taskDepth = (task, seen = new Set()) => {
    if (!task.parentTaskId) return 0;
    if (seen.has(task.id)) throw new Error("TASK_PARENT_CYCLE");
    seen.add(task.id);
    const parent = tasks.merged.get(task.parentTaskId);
    return parent ? 1 + taskDepth(parent, seen) : 0;
  };
  for (const task of tasks.toWrite.sort((a, b) => taskDepth(a) - taskDepth(b))) {
    const page = await writeEntity(env, task, "task", remoteGoals, remoteTasks);
    remoteTasks.set(task.id, { entity: task, pageId: page.id || remoteTasks.get(task.id)?.pageId, edited: page.last_edited_time });
  }

  // The local ID and relation values are canonical; avoid a second full scan and its partial-write risk.
  const returnedGoals = [...goals.merged.values()];
  const returnedTasks = [...tasks.merged.values()];
  return { status: "ok", snapshot: { goals: returnedGoals, tasks: returnedTasks } };
}

async function acquireSyncLock(env) {
  if (!env.DB) throw new Error("SYNC_LOCK_UNAVAILABLE");
  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO sync_locks (lock_id, token, expires_at) VALUES ('notion-sync', ?, ?)
    ON CONFLICT(lock_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    WHERE sync_locks.expires_at <= ?`).bind(token, now + 120, now).run();
  const row = await env.DB.prepare("SELECT token FROM sync_locks WHERE lock_id = 'notion-sync'").first();
  return row?.token === token ? token : null;
}

async function releaseSyncLock(env, token) {
  await env.DB.prepare("DELETE FROM sync_locks WHERE lock_id = 'notion-sync' AND token = ?").bind(token).run();
}

async function authenticated(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  return match ? verifySession(match[1], env) : false;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (!origin || origin !== env.WEB_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true }, 200, cors);
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        if (!env.GOALFLOW_LOGIN_PASSWORD || env.GOALFLOW_LOGIN_PASSWORD.length < 16 || !env.SESSION_SIGNING_SECRET || env.SESSION_SIGNING_SECRET.length < 32 || !env.DB || !env.NOTION_TOKEN) return json({ error: "service_not_configured" }, 503, cors);
        if (!await allowLogin(request, env)) return json({ error: "login_rate_limited" }, 429, cors);
        const body = await readJsonBounded(request, 8_192);
        if (typeof body.password !== "string" || !timingSafeEqual(body.password, env.GOALFLOW_LOGIN_PASSWORD)) return json({ error: "unauthorized" }, 401, cors);
        return json({ token: await signSession(env), expiresIn: SESSION_SECONDS }, 200, cors);
      } catch (error) {
        if (error.message === "LOGIN_RATE_LIMIT_UNAVAILABLE") return json({ error: "login_unavailable" }, 503, cors);
        if (error.message === "PAYLOAD_TOO_LARGE") return json({ error: "payload_too_large" }, 413, cors);
        if (error.message === "INVALID_JSON") return json({ error: "invalid_json" }, 400, cors);
        return json({ error: "login_failed" }, 503, cors);
      }
    }
    if (url.pathname === "/api/sync" && request.method === "POST") {
      if (!await authenticated(request, env)) return json({ error: "unauthorized" }, 401, cors);
      if (!env.NOTION_TOKEN || !env.GOALS_DATA_SOURCE_ID || !env.TASKS_DATA_SOURCE_ID) return json({ error: "sync_not_configured" }, 503, cors);
      let lock;
      try {
        lock = await acquireSyncLock(env);
        if (!lock) return json({ error: "sync_in_progress" }, 409, cors);
        const result = await synchronize(await readJsonBounded(request, 1_000_000), env);
        return json(result, 200, cors);
      } catch (error) {
        const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : "SYNC_FAILED";
        const status = code === "PAYLOAD_TOO_LARGE" ? 413 : code === "INVALID_JSON" || code === "INVALID_SYNC_PAYLOAD" ? 400 : ["NOTION_CHANGED_DURING_SYNC", "SYNC_WRITE_LIMIT", "TASK_PARENT_CYCLE", "TASK_PARENT_INVALID", "TASK_GOAL_MISSING", "TASK_RELATION_TARGET_MISSING"].includes(code) ? 409 : 502;
        return json({ error: code }, status, cors);
      } finally {
        if (lock) await releaseSyncLock(env, lock).catch(() => {});
      }
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "not_found" }, 404, cors);
  },
};

export const internals = { timingSafeEqual, signSession, verifySession, mergedEntities, listNotionEntities, notionRequest, normalizeEntity, notionProperties, synchronize, NOTION_VERSION };
