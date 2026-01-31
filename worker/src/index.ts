export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  UPTIME_TARGETS?: string;
  GITHUB_USER?: string;
  POSTS_FEED_URL?: string;
}

type MetricLatestRecord = {
  key: string;
  value_json: string;
  updated_at: number;
};

type UptimeTargetResult = {
  target: string;
  status: number | null;
  latency_ms: number | null;
  ok: boolean;
  checked_at: number;
};

type UptimeSummary = {
  targets: UptimeTargetResult[];
  status: "ok" | "warn" | "down";
  checked_at: number;
};

type PerformanceSummary = {
  response_ms: number | null;
  rolling_avg_ms: number | null;
  checked_at: number;
};

type GithubEvent = {
  type: string;
  repo: string;
  message: string;
  url: string;
  time: number;
};

type GithubSummary = {
  user: string;
  items: GithubEvent[];
  checked_at: number;
};

type PostsSummary = {
  items: { title: string; url: string; published_at: number | null }[];
  checked_at: number;
  source: string;
};

type NowSummary = {
  text: string;
  updated_at: number;
};

const DEFAULT_TARGET = "https://madisonsadler.com/";
const DEFAULT_GITHUB_USER = "madsad87";
const DEFAULT_NOW_TEXT = "Tuning the signal and sipping something warm.";
const UPDATE_FREQUENCY_SECONDS = 60 * 5;

function toEpochSeconds(date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

async function getLatest(env: Env, key: string): Promise<MetricLatestRecord | null> {
  const result = await env.DB.prepare(
    "SELECT key, value_json, updated_at FROM metric_latest WHERE key = ?"
  )
    .bind(key)
    .first<MetricLatestRecord>();
  return result ?? null;
}

async function setLatest(
  env: Env,
  key: string,
  value: unknown,
  updatedAt: number
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO metric_latest (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at"
  )
    .bind(key, JSON.stringify(value), updatedAt)
    .run();
}

async function addHistory(
  env: Env,
  key: string,
  value: unknown,
  recordedAt: number
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO metric_history (key, value_json, recorded_at) VALUES (?, ?, ?)"
  )
    .bind(key, JSON.stringify(value), recordedAt)
    .run();
}

async function wasUpdatedRecently(
  env: Env,
  key: string,
  maxAgeSeconds: number
): Promise<boolean> {
  const latest = await getLatest(env, key);
  if (!latest) return false;
  const now = toEpochSeconds();
  return now - latest.updated_at < maxAgeSeconds;
}

function parseTargets(env: Env): string[] {
  const raw = env.UPTIME_TARGETS?.trim();
  if (!raw) return [DEFAULT_TARGET];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function fetchWithTiming(url: string): Promise<{ status: number | null; latency_ms: number | null }>{
  const start = Date.now();
  try {
    const response = await fetch(url, { method: "GET" });
    const latency = Date.now() - start;
    return { status: response.status, latency_ms: latency };
  } catch (error) {
    return { status: null, latency_ms: null };
  }
}

async function updateIncidentLog(
  env: Env,
  target: string,
  isDown: boolean,
  details: Record<string, unknown> | null,
  now: number
): Promise<void> {
  const openIncident = await env.DB.prepare(
    "SELECT id FROM incident_log WHERE target = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
  )
    .bind(target)
    .first<{ id: number }>();

  if (isDown && !openIncident) {
    await env.DB.prepare(
      "INSERT INTO incident_log (target, status, details_json, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)"
    )
      .bind(target, "down", details ? JSON.stringify(details) : null, now)
      .run();
  }

  if (!isDown && openIncident) {
    await env.DB.prepare("UPDATE incident_log SET ended_at = ? WHERE id = ?")
      .bind(now, openIncident.id)
      .run();
  }
}

async function fetchUptime(env: Env, force: boolean): Promise<UptimeSummary | null> {
  if (!force && (await wasUpdatedRecently(env, "uptime:site", UPDATE_FREQUENCY_SECONDS))) {
    const latest = await getLatest(env, "uptime:site");
    return latest ? (JSON.parse(latest.value_json) as UptimeSummary) : null;
  }

  const targets = parseTargets(env);
  const now = toEpochSeconds();
  const results: UptimeTargetResult[] = [];

  for (const target of targets) {
    const { status, latency_ms } = await fetchWithTiming(target);
    const ok = status !== null && status < 400;
    const result: UptimeTargetResult = {
      target,
      status,
      latency_ms,
      ok,
      checked_at: now,
    };
    results.push(result);

    await updateIncidentLog(
      env,
      target,
      !ok,
      { status, latency_ms },
      now
    );
  }

  const status: UptimeSummary["status"] = results.every((item) => item.ok)
    ? "ok"
    : results.some((item) => item.ok)
      ? "warn"
      : "down";

  const summary: UptimeSummary = {
    targets: results,
    status,
    checked_at: now,
  };

  await setLatest(env, "uptime:site", summary, now);
  await addHistory(env, "uptime:site", summary, now);

  return summary;
}

async function fetchPerformance(env: Env, force: boolean): Promise<PerformanceSummary | null> {
  if (!force && (await wasUpdatedRecently(env, "perf:site", UPDATE_FREQUENCY_SECONDS))) {
    const latest = await getLatest(env, "perf:site");
    return latest ? (JSON.parse(latest.value_json) as PerformanceSummary) : null;
  }

  const target = parseTargets(env)[0] ?? DEFAULT_TARGET;
  const now = toEpochSeconds();
  const { latency_ms } = await fetchWithTiming(target);

  const history = await env.DB.prepare(
    "SELECT value_json FROM metric_history WHERE key = ? AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT 12"
  )
    .bind("perf:site", now - 60 * 60 * 24)
    .all<{ value_json: string }>();

  const values = history.results
    .map((row) => {
      const parsed = JSON.parse(row.value_json) as PerformanceSummary;
      return parsed.response_ms ?? null;
    })
    .filter((value): value is number => typeof value === "number");

  const avg = values.length > 0
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : latency_ms ?? null;

  const summary: PerformanceSummary = {
    response_ms: latency_ms,
    rolling_avg_ms: avg,
    checked_at: now,
  };

  await setLatest(env, "perf:site", summary, now);
  await addHistory(env, "perf:site", summary, now);

  return summary;
}

async function fetchGithub(env: Env, force: boolean): Promise<GithubSummary | null> {
  if (!force && (await wasUpdatedRecently(env, "github:activity", UPDATE_FREQUENCY_SECONDS))) {
    const latest = await getLatest(env, "github:activity");
    return latest ? (JSON.parse(latest.value_json) as GithubSummary) : null;
  }

  const user = env.GITHUB_USER?.trim() || DEFAULT_GITHUB_USER;
  const response = await fetch(`https://api.github.com/users/${user}/events/public`, {
    headers: {
      "User-Agent": "madison-status-dashboard",
      Accept: "application/vnd.github+json",
    },
  });

  const now = toEpochSeconds();
  if (!response.ok) {
    const summary: GithubSummary = { user, items: [], checked_at: now };
    await setLatest(env, "github:activity", summary, now);
    return summary;
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;
  const items: GithubEvent[] = payload.slice(0, 10).map((event) => {
    const repo = typeof event.repo === "object" && event.repo && "name" in event.repo
      ? String((event.repo as { name: string }).name)
      : "";
    const type = String(event.type ?? "Event");
    const created = typeof event.created_at === "string" ? Date.parse(event.created_at) : Date.now();
    const payloadData = (event.payload as Record<string, unknown>) ?? {};
    const commit = Array.isArray(payloadData.commits) ? payloadData.commits[0] : null;
    const message = commit && typeof commit.message === "string"
      ? commit.message
      : typeof payloadData.action === "string"
        ? payloadData.action
        : "New activity";
    const url = repo ? `https://github.com/${repo}` : "https://github.com/";
    return {
      type,
      repo,
      message,
      url,
      time: Math.floor(created / 1000),
    };
  });

  const summary: GithubSummary = {
    user,
    items,
    checked_at: now,
  };

  await setLatest(env, "github:activity", summary, now);
  await addHistory(env, "github:activity", summary, now);

  return summary;
}

async function fetchPosts(env: Env, force: boolean): Promise<PostsSummary | null> {
  if (!force && (await wasUpdatedRecently(env, "posts:latest", UPDATE_FREQUENCY_SECONDS))) {
    const latest = await getLatest(env, "posts:latest");
    return latest ? (JSON.parse(latest.value_json) as PostsSummary) : null;
  }

  const now = toEpochSeconds();
  const feedUrl = env.POSTS_FEED_URL?.trim();

  if (!feedUrl) {
    const summary: PostsSummary = {
      items: [
        { title: "On warm design systems", url: "#", published_at: null },
        { title: "Thoughts from the lake", url: "#", published_at: null },
        { title: "Building calm dashboards", url: "#", published_at: null },
      ],
      checked_at: now,
      source: "placeholder",
    };
    await setLatest(env, "posts:latest", summary, now);
    return summary;
  }

  const response = await fetch(feedUrl, { headers: { "User-Agent": "madison-status-dashboard" } });
  if (!response.ok) {
    const summary: PostsSummary = { items: [], checked_at: now, source: feedUrl };
    await setLatest(env, "posts:latest", summary, now);
    return summary;
  }

  const payload = (await response.json()) as {
    items?: Array<{ title?: string; url?: string; published_at?: string }>;
  };

  const items = (payload.items ?? []).slice(0, 5).map((item) => ({
    title: item.title ?? "Untitled",
    url: item.url ?? "#",
    published_at: item.published_at ? Math.floor(Date.parse(item.published_at) / 1000) : null,
  }));

  const summary: PostsSummary = {
    items,
    checked_at: now,
    source: feedUrl,
  };

  await setLatest(env, "posts:latest", summary, now);
  return summary;
}

async function fetchNowText(env: Env): Promise<NowSummary> {
  const latest = await getLatest(env, "now:text");
  if (latest) {
    return JSON.parse(latest.value_json) as NowSummary;
  }
  const now = toEpochSeconds();
  const summary: NowSummary = { text: DEFAULT_NOW_TEXT, updated_at: now };
  await setLatest(env, "now:text", summary, now);
  return summary;
}

async function fetchIncidentLog(env: Env): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    "SELECT target, status, details_json, started_at, ended_at FROM incident_log ORDER BY started_at DESC LIMIT 8"
  ).all();
  return rows.results.map((row) => ({
    target: row.target,
    status: row.status,
    details: row.details_json ? JSON.parse(row.details_json) : null,
    started_at: row.started_at,
    ended_at: row.ended_at,
  }));
}

async function refreshAll(env: Env, force: boolean): Promise<void> {
  await fetchUptime(env, force);
  await fetchPerformance(env, force);
  await fetchGithub(env, force);
  await fetchPosts(env, force);
  await fetchNowText(env);
}

function requireAdmin(request: Request, env: Env): Response | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace("Bearer", "").trim();
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function parseRange(range: string | null): number {
  if (!range) return 60 * 60 * 24;
  if (range.endsWith("h")) {
    const hours = Number(range.replace("h", ""));
    if (!Number.isNaN(hours)) return hours * 60 * 60;
  }
  return 60 * 60 * 24;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/status/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/status/summary") {
      await refreshAll(env, false);
      const [uptime, perf, github, posts, nowText, incidents] = await Promise.all([
        getLatest(env, "uptime:site"),
        getLatest(env, "perf:site"),
        getLatest(env, "github:activity"),
        getLatest(env, "posts:latest"),
        getLatest(env, "now:text"),
        fetchIncidentLog(env),
      ]);

      return jsonResponse({
        generated_at: toEpochSeconds(),
        uptime: uptime ? JSON.parse(uptime.value_json) : null,
        perf: perf ? JSON.parse(perf.value_json) : null,
        github: github ? JSON.parse(github.value_json) : null,
        posts: posts ? JSON.parse(posts.value_json) : null,
        now: nowText ? JSON.parse(nowText.value_json) : null,
        incidents,
      });
    }

    if (url.pathname === "/api/status/history") {
      const key = url.searchParams.get("key");
      if (!key) {
        return jsonResponse({ error: "Missing key" }, 400);
      }
      const rangeSeconds = parseRange(url.searchParams.get("range"));
      const now = toEpochSeconds();
      const since = now - rangeSeconds;
      const history = await env.DB.prepare(
        "SELECT value_json, recorded_at FROM metric_history WHERE key = ? AND recorded_at >= ? ORDER BY recorded_at ASC"
      )
        .bind(key, since)
        .all<{ value_json: string; recorded_at: number }>();

      return jsonResponse({
        key,
        points: history.results.map((row) => ({
          recorded_at: row.recorded_at,
          value: JSON.parse(row.value_json),
        })),
      });
    }

    if (url.pathname === "/api/admin/refresh" && request.method === "POST") {
      const auth = requireAdmin(request, env);
      if (auth) return auth;
      await refreshAll(env, true);
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/admin/now" && request.method === "POST") {
      const auth = requireAdmin(request, env);
      if (auth) return auth;
      const body = (await request.json()) as { text?: string };
      const text = body.text?.trim();
      if (!text) {
        return jsonResponse({ error: "Text is required" }, 400);
      }
      const now = toEpochSeconds();
      const summary: NowSummary = { text, updated_at: now };
      await setLatest(env, "now:text", summary, now);
      return jsonResponse({ ok: true, now: summary });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await refreshAll(env, false);
  },
};
