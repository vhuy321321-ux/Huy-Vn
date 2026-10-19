import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import worker, { internals } from "../src/index.mjs";

const env = {
  GOALFLOW_LOGIN_PASSWORD: "a-long-local-test-password",
  SESSION_SIGNING_SECRET: "unit-test-session-signing-secret-32-bytes-minimum",
  NOTION_TOKEN: "mock-token-not-a-real-secret",
  GOALS_DATA_SOURCE_ID: "goals-source",
  TASKS_DATA_SOURCE_ID: "tasks-source",
  WEB_ORIGIN: "https://goalflow.example.test",
};

function database() {
  const attempts = new Map();
  const locks = new Map();
  return { prepare(query) {
    let args = [];
    return { bind(...values) { args = values; return this; }, async run() {
      if (query.startsWith("INSERT INTO login_attempts")) {
        const [key, now, threshold] = args;
        const current = attempts.get(key);
        attempts.set(key, !current || current.windowStarted <= threshold ? { windowStarted: now, attempts: 1 } : { ...current, attempts: current.attempts + 1 });
      } else if (query.startsWith("INSERT INTO sync_locks")) {
        const [token, expiresAt, now] = args;
        const current = locks.get("notion-sync");
        if (!current || current.expiresAt <= now) locks.set("notion-sync", { token, expiresAt });
      } else if (query.startsWith("DELETE FROM sync_locks")) {
        if (locks.get("notion-sync")?.token === args[0]) locks.delete("notion-sync");
      }
    }, async first() {
      if (query.includes("FROM sync_locks")) return locks.get("notion-sync");
      return attempts.get(args[0]);
    } };
  } };
}

const request = (path, { method = "GET", body, token, origin } = {}) => new Request(`https://worker.example.test${path}`, {
  method,
  headers: {
    ...(body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(origin ? { Origin: origin } : {}),
    "CF-Connecting-IP": "192.0.2.10",
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test("login rejects wrong passwords and returns a short-lived signed session without echoing credentials", async () => {
  const testEnv = { ...env, DB: database() };
  const denied = await worker.fetch(request("/api/login", { method: "POST", body: { password: "wrong" } }), testEnv);
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(await denied.json()).includes(env.GOALFLOW_LOGIN_PASSWORD), false);
  const accepted = await worker.fetch(request("/api/login", { method: "POST", body: { password: env.GOALFLOW_LOGIN_PASSWORD } }), testEnv);
  const session = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(session.expiresIn, 900);
  assert.equal(await internals.verifySession(session.token, testEnv), true);
  assert.equal(await internals.verifySession(`${session.token}x`, testEnv), false);
});

test("login rate limit fails closed and blocks attempts after the configured threshold", async () => {
  const testEnv = { ...env, DB: database() };
  let last;
  for (let i = 0; i < 6; i += 1) last = await worker.fetch(request("/api/login", { method: "POST", body: { password: "bad" } }), testEnv);
  assert.equal(last.status, 429);
  const unavailable = await worker.fetch(request("/api/login", { method: "POST", body: { password: env.GOALFLOW_LOGIN_PASSWORD } }), env);
  assert.equal(unavailable.status, 503);
});

test("sync endpoint requires a valid session and rejects browser origins outside the allowlist", async () => {
  const unauthenticated = await worker.fetch(request("/api/sync", { method: "POST", body: {} }), env);
  assert.equal(unauthenticated.status, 401);
  const options = await worker.fetch(request("/api/sync", { method: "OPTIONS", origin: "https://attacker.example" }), env);
  assert.equal(options.status, 403);
  const allowed = await worker.fetch(request("/api/health", { origin: env.WEB_ORIGIN }), env);
  assert.equal(allowed.headers.get("access-control-allow-origin"), env.WEB_ORIGIN);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
});

test("authenticated sync uses the D1 lock and returns an empty, non-destructive snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const testEnv = { ...env, DB: database() };
  const token = await internals.signSession(testEnv);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ results: [], has_more: false, next_cursor: null });
  };
  try {
    const response = await worker.fetch(request("/api/sync", {
      method: "POST", token,
      body: { local: { goals: [], tasks: [] }, base: { goals: [], tasks: [] } },
    }), testEnv);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.snapshot, { goals: [], tasks: [] });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(x => x.init.headers["notion-version"] === "2026-03-11"));
  } finally { globalThis.fetch = originalFetch; }
});

test("three-way merge imports remote-only edits and reports simultaneous edits as conflicts", () => {
  const base = [{ id: "t1", title: "Old", deadline: "", done: false, goalId: "g1", parentTaskId: "" }];
  const remote = new Map([["t1", { entity: { ...base[0], title: "Remote" }, pageId: "page-1", edited: "2026-01-01" }]]);
  const remoteWins = internals.mergedEntities(base, base, remote, "task", []);
  assert.equal(remoteWins.merged.get("t1").title, "Remote");
  const conflicts = [];
  internals.mergedEntities([{ ...base[0], title: "Local" }], base, remote, "task", conflicts);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, "both-changed");
});

test("pagination follows Notion cursors and sends the pinned Notion version", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const page = calls.length === 1
      ? { results: [{ id: "p1", last_edited_time: "t1", properties: { "GoalFlow ID": { type: "rich_text", rich_text: [{ plain_text: "g1" }] }, Name: { type: "title", title: [{ plain_text: "Goal" }] } } }], has_more: true, next_cursor: "cursor-next" }
      : { results: [{ id: "p2", last_edited_time: "t2", properties: { "GoalFlow ID": { type: "rich_text", rich_text: [{ plain_text: "g2" }] }, Name: { type: "title", title: [{ plain_text: "Goal 2" }] } } }], has_more: false, next_cursor: null };
    return Response.json(page);
  };
  try {
    const results = await internals.listNotionEntities({ ...env }, "goal");
    assert.deepEqual([...results.keys()], ["g1", "g2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers["notion-version"], "2026-03-11");
    assert.equal(JSON.parse(calls[1].init.body).start_cursor, "cursor-next");
  } finally { globalThis.fetch = originalFetch; }
});

test("Notion incomplete query results fail closed before they can be treated as deletions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ results: [], has_more: false, request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" } });
  try {
    await assert.rejects(internals.listNotionEntities(env, "goal"), /NOTION_INCOMPLETE_PAGE/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Notion retries honor Retry-After and never expose its token in errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    assert.equal(init.headers.authorization, `Bearer ${env.NOTION_TOKEN}`);
    if (calls === 1) return new Response(JSON.stringify({ code: "rate_limited" }), { status: 429, headers: { "Retry-After": "0.001" } });
    return Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await internals.notionRequest(env, "/test"), { ok: true });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("Notion retries safe reads after 5xx but does not retry ambiguous page creation", async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0, creates = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/pages")) { creates += 1; return Response.json({ code: "internal_error" }, { status: 500 }); }
    reads += 1;
    return reads === 1 ? Response.json({ code: "internal_error" }, { status: 500 }) : Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await internals.notionRequest(env, "/data_sources/source/query", { method: "POST", body: "{}" }), { ok: true });
    assert.equal(reads, 2);
    await assert.rejects(internals.notionRequest(env, "/pages", { method: "POST", body: "{}" }), /NOTION_500_internal_error/);
    assert.equal(creates, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("entity mapping preserves goal, parent task, and subtask links", () => {
  const goals = new Map([["goal-1", { pageId: "notion-goal-1" }]]);
  const tasks = new Map([["task-1", { pageId: "notion-task-1" }]]);
  const properties = internals.notionProperties({ id: "sub-1", title: "Subtask", deadline: "2026-10-20", done: true, goalId: "goal-1", parentTaskId: "task-1" }, "task", goals, tasks);
  assert.equal(properties["GoalFlow ID"].rich_text[0].text.content, "sub-1");
  assert.deepEqual(properties.Goal.relation, [{ id: "notion-goal-1" }]);
  assert.deepEqual(properties["Parent Task"].relation, [{ id: "notion-task-1" }]);
  assert.equal(properties.Status.select.name, "Done");
  assert.equal(properties["Due Date"].date.start, "2026-10-20");
});

test("Notion API failures do not become deletion instructions", () => {
  const conflicts = [];
  const base = [{ id: "t1", title: "Task", deadline: "", done: false, goalId: "", parentTaskId: "" }];
  const merged = internals.mergedEntities(base, base, new Map(), "task", conflicts);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.merged.get("t1").title, "Task");
  assert.equal(merged.toWrite.length, 0);
});

test("duplicate client IDs fail closed instead of silently dropping a record", () => {
  const duplicate = { id: "same-id", title: "Task", deadline: "", done: false, goalId: "goal-1", parentTaskId: "" };
  assert.throws(() => internals.mergedEntities([duplicate, { ...duplicate, title: "Other" }], [], new Map(), "task", []), /DUPLICATE_LOCAL_ID/);
});

test("full sync creates parent tasks before subtasks and preserves stable relation IDs", async () => {
  const originalFetch = globalThis.fetch;
  const pages = new Map();
  let nextId = 0;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const data = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, data, headers: init.headers });
    if (path.endsWith("/query")) {
      const sourceId = path.includes("goals-source") ? "goals-source" : "tasks-source";
      return Response.json({ results: [...pages.values()].filter(x => x.source === sourceId).map(x => x.page), has_more: false, next_cursor: null });
    }
    if (path === "/v1/pages" && init.method === "POST") {
      const source = data.parent.data_source_id;
      const page = { id: `page-${++nextId}`, last_edited_time: `edit-${nextId}`, properties: { ...data.properties } };
      for (const [key, value] of Object.entries(page.properties)) {
        if (value.title) page.properties[key] = { type: "title", ...value };
        else if (value.rich_text) page.properties[key] = { type: "rich_text", ...value };
      }
      pages.set(page.id, { source, page });
      return Response.json(page);
    }
    throw new Error(`Unexpected mock request ${path}`);
  };
  try {
    const payload = {
      base: { goals: [], tasks: [] },
      local: {
        goals: [{ id: "goal-stable", title: "Learn", deadline: "2026-12-01", progress: 0 }],
        tasks: [
          { id: "parent-stable", title: "Study", deadline: "", done: false, goalId: "goal-stable", parentTaskId: "" },
          { id: "child-stable", title: "Read chapter", deadline: "2026-10-20", done: true, goalId: "goal-stable", parentTaskId: "parent-stable" },
        ],
      },
    };
    const result = await internals.synchronize(payload, env);
    assert.equal(result.status, "ok");
    assert.equal(result.snapshot.tasks.find(x => x.id === "child-stable").parentTaskId, "parent-stable");
    const childCreate = calls.find(x => x.path === "/v1/pages" && x.data.properties["GoalFlow ID"]?.rich_text?.[0]?.text?.content === "child-stable");
    assert.deepEqual(childCreate.data.properties["Parent Task"].relation, [{ id: "page-2" }]);
    assert.deepEqual(childCreate.data.properties.Goal.relation, [{ id: "page-1" }]);
    assert.ok(calls.every(x => x.headers["notion-version"] === "2026-03-11"));
    const second = await internals.synchronize({ local: result.snapshot, base: result.snapshot }, env);
    assert.equal(second.status, "ok");
    assert.equal(calls.filter(x => x.path === "/v1/pages").length, 3, "second unchanged sync makes no duplicate pages");
  } finally { globalThis.fetch = originalFetch; }
});

test("new tasks are not written with a missing Notion Goal relation target", async () => {
  const originalFetch = globalThis.fetch;
  let creates = 0;
  globalThis.fetch = async () => { creates += 1; return Response.json({ results: [], has_more: false, next_cursor: null }); };
  try {
    await assert.rejects(internals.synchronize({
      base: { goals: [{ id: "goal-1", title: "Goal", deadline: "", progress: 0 }], tasks: [] },
      local: { goals: [{ id: "goal-1", title: "Goal", deadline: "", progress: 0 }], tasks: [{ id: "task-1", title: "Task", deadline: "", done: false, goalId: "goal-1", parentTaskId: "" }] },
    }, env), /TASK_RELATION_TARGET_MISSING/);
    assert.equal(creates, 2, "only read-only data source queries ran; no page was created");
  } finally { globalThis.fetch = originalFetch; }
});

function zipEntry(buffer, entryName) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, "ZIP end-of-central-directory marker exists");
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (name === entryName) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(start, start + compressedSize);
      return method === 0 ? compressed : inflateRawSync(compressed);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry missing: ${entryName}`);
}

test("reviewed Android sources match their bundled ZIP entries", async () => {
  const archive = await readFile(new URL("../../GoalFlow-Android-WebView-MVP.zip", import.meta.url));
  const mappings = [
    ["GoalFlowAndroid-WebView/app/src/main/assets/index.html", "../public/index.html"],
    ["GoalFlowAndroid-WebView/app/src/main/AndroidManifest.xml", "../android-src/app/src/main/AndroidManifest.xml"],
    ["GoalFlowAndroid-WebView/app/src/main/java/com/goalflow/app/MainActivity.kt", "../android-src/app/src/main/java/com/goalflow/app/MainActivity.kt"],
    ["GoalFlowAndroid-WebView/app/src/main/java/com/goalflow/app/GoalData.kt", "../android-src/app/src/main/java/com/goalflow/app/GoalData.kt"],
    ["GoalFlowAndroid-WebView/app/src/main/java/com/goalflow/app/GoalWidgetProvider.kt", "../android-src/app/src/main/java/com/goalflow/app/GoalWidgetProvider.kt"],
  ];
  for (const [entry, sourcePath] of mappings) {
    assert.deepEqual(zipEntry(archive, entry), await readFile(new URL(sourcePath, import.meta.url)), entry);
  }
});
