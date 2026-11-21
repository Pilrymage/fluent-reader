import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { createHash, timingSafeEqual } from "node:crypto"
import { upsertSource } from "./db.ts"
import {
    deleteFilterRule,
    getFilterRule,
    insertFilterRule,
    listFilterRules,
    updateFilterRule,
} from "./db.ts"
import type { FilterRuleRow } from "./db.ts"
import type { ReaderBackend } from "./backend.ts"
import type { ServerConfig } from "./config.ts"

const MAX_BODY_BYTES = 1024 * 1024

function json(res: http.ServerResponse, status: number, payload: unknown) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
    })
    res.end(body)
}

function digest(value: string) {
    return createHash("sha256").update(value).digest()
}

/**
 * No password lives here any more: identity is Authelia's job.
 *
 *  - Browsers arrive through Caddy's forward_auth. Only after Authelia accepts
 *    the session does Caddy stamp `X-Forwarded-Sso: 1` and copy `Remote-User`;
 *    a direct request cannot produce that pair, so the check fails closed.
 *  - Machines (curl, scripts) present the shared token instead. Caddy routes
 *    those past forward_auth, which is why it must strip any client-supplied
 *    SSO headers on that branch.
 *
 * The token is compared by digest so the comparison is constant time.
 */
function authorized(req: http.IncomingMessage, url: URL, config: ServerConfig) {
    const header = req.headers.authorization ?? ""
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : ""
    const candidate = bearer || url.searchParams.get("token") || ""
    if (candidate) {
        return timingSafeEqual(digest(candidate), digest(config.token))
    }
    const marker = req.headers["x-forwarded-sso"]
    const user = req.headers["remote-user"]
    return marker === "1" && typeof user === "string" && user.trim().length > 0
}

async function readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) throw new Error("Request body too large")
        chunks.push(chunk as Buffer)
    }
    if (chunks.length === 0) return {}
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
        throw new Error("Invalid JSON body")
    }
}

function normalizeRule(row: FilterRuleRow) {
    return {
        id: row.id,
        kind: row.kind,
        scope: row.scope,
        sids: row.sids,
        field: row.field,
        mode: row.mode,
        pattern: row.pattern,
        action: row.action,
        enabled: Boolean(row.enabled),
        hits: row.hits,
        note: row.note,
        createdAt: row.created_at,
    }
}

// Turn a request body into a full rule row. Shared by POST /rules and
// POST /rules/:id — the patch path validates the merged result, so an update
// cannot leave a rule that would not have been creatable.
function parseRuleBody(
    body: any,
    existing?: FilterRuleRow
): { error?: string; value?: FilterRuleRow } {
    const kind = existing ? existing.kind : body.kind
    if (kind !== "feed" && kind !== "keyword")
        return { error: "kind must be feed or keyword" }
    const scope =
        typeof body.scope === "string" && body.scope.trim()
            ? body.scope.trim()
            : existing?.scope ?? "*"
    const field = typeof body.field === "string" ? body.field : existing?.field
    if (field && !["title", "creator", "title_creator"].includes(field))
        return { error: "field must be title, creator or title_creator" }
    const mode = typeof body.mode === "string" ? body.mode : existing?.mode
    if (mode && mode !== "substr" && mode !== "regex")
        return { error: "mode must be substr or regex" }
    const pattern =
        typeof body.pattern === "string" ? body.pattern : existing?.pattern
    if (kind === "keyword") {
        if (!pattern || !pattern.trim()) return { error: "pattern is required" }
        if (mode === "regex") {
            try {
                new RegExp(pattern, "i")
            } catch (err) {
                return {
                    error: `regex does not compile: ${
                        err instanceof Error ? err.message : err
                    }`,
                }
            }
        }
    }
    const sids =
        kind === "feed"
            ? Array.isArray(body.sids)
                ? body.sids.map(Number).filter(Number.isFinite).join(",")
                : existing?.sids ?? ""
            : null
    if (kind === "feed" && !sids)
        return { error: "sids is required for kind=feed" }
    const enabled =
        body.enabled === undefined
            ? existing?.enabled ?? 1
            : body.enabled
            ? 1
            : 0
    const note =
        typeof body.note === "string" && body.note.trim()
            ? body.note.trim().slice(0, 200)
            : existing?.note ?? null
    return {
        value: {
            id: existing?.id ?? 0,
            kind,
            scope,
            sids,
            field: field ?? "title",
            mode: mode ?? "substr",
            pattern: pattern ?? "",
            action: "read",
            enabled,
            hits: existing?.hits ?? 0,
            note,
            created_at: existing?.created_at ?? 0,
        },
    }
}

export function createApiServer(config: ServerConfig, backend: ReaderBackend) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        res.setHeader("access-control-allow-origin", config.corsOrigin)
        res.setHeader(
            "access-control-allow-headers",
            "authorization, content-type"
        )
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
        if (req.method === "OPTIONS") {
            res.writeHead(204).end()
            return
        }

        try {
            if (url.pathname === "/api/health") {
                json(res, 200, {
                    ok: true,
                    backend: backend.kind,
                    ...(await backend.stats()),
                })
                return
            }
            if (url.pathname === "/debug" && req.method === "GET") {
                if (!authorized(req, url, config)) {
                    json(res, 401, { error: "Unauthorized" })
                    return
                }
                res.writeHead(200, {
                    "content-type": "text/html; charset=utf-8",
                })
                res.end(debugPage(url.searchParams.get("token") ?? ""))
                return
            }
            if (!url.pathname.startsWith("/api/")) {
                // The browser client and its assets are plain files; identity
                // travels on the request headers Caddy adds, never on a URL.
                if (
                    req.method === "GET" &&
                    (await serveStatic(url.pathname, res, config))
                ) {
                    return
                }
                json(res, 404, { error: "Not found" })
                return
            }
            if (!authorized(req, url, config)) {
                json(res, 401, { error: "Unauthorized" })
                return
            }

            if (url.pathname === "/api/sources" && req.method === "GET") {
                const [sources, groups] = await Promise.all([
                    backend.sources(),
                    backend.groups(),
                ])
                json(res, 200, { sources, groups })
                return
            }

            // Batched read state. A reader pages through an unread list with one
            // keypress per row, so one request per item would put a round trip
            // in front of every key.
            if (url.pathname === "/api/items/read" && req.method === "POST") {
                const body = await readJson(req)
                const ids = Array.isArray(body.ids)
                    ? body.ids.map(Number).filter(Number.isFinite)
                    : []
                if (ids.length === 0) {
                    json(res, 400, { error: "ids is required" })
                    return
                }
                await backend.setFlags(
                    ids,
                    "read",
                    body.value === undefined ? true : Boolean(body.value)
                )
                json(res, 200, { ok: true, count: ids.length })
                return
            }

            if (url.pathname === "/api/sources" && req.method === "POST") {
                if (backend.kind !== "local") {
                    json(res, 501, {
                        error: "Add subscriptions in Miniflux; this server only reads it",
                    })
                    return
                }
                const body = await readJson(req)
                if (
                    typeof body.url !== "string" ||
                    !body.url.startsWith("http")
                ) {
                    json(res, 400, { error: "url is required" })
                    return
                }
                const sid = upsertSource({
                    url: body.url,
                    name:
                        typeof body.name === "string" && body.name
                            ? body.name
                            : body.url,
                    iconurl:
                        typeof body.iconurl === "string" ? body.iconurl : null,
                })
                json(res, 200, { sid })
                return
            }

            const icon = /^\/api\/sources\/(\d+)\/icon$/.exec(url.pathname)
            if (icon && req.method === "GET") {
                const result = await backend.icon(Number(icon[1]))
                if (!result) {
                    res.writeHead(404).end()
                    return
                }
                res.writeHead(200, {
                    "content-type": result.contentType,
                    // Auth-gated, so it must not be marked public.
                    "cache-control": "private, max-age=604800",
                })
                res.end(Buffer.from(result.body))
                return
            }

            // One request for "mark this whole group read".
            if (
                url.pathname === "/api/sources/read-all" &&
                req.method === "POST"
            ) {
                const body = await readJson(req)
                const sids = Array.isArray(body.sids)
                    ? body.sids.map(Number).filter(Number.isFinite)
                    : []
                if (sids.length === 0) {
                    json(res, 400, { error: "sids is required" })
                    return
                }
                await backend.markSourcesRead(sids)
                json(res, 200, { ok: true, count: sids.length })
                return
            }

            const readAll = /^\/api\/sources\/(\d+)\/read-all$/.exec(
                url.pathname
            )
            if (readAll && req.method === "POST") {
                await backend.markSourcesRead([Number(readAll[1])])
                json(res, 200, { ok: true })
                return
            }

            /* ----------------- filter rules ----------------- */

            if (url.pathname === "/api/filter/rules" && req.method === "GET") {
                json(res, 200, {
                    rules: listFilterRules().map(normalizeRule),
                })
                return
            }

            if (url.pathname === "/api/filter/rules" && req.method === "POST") {
                const parsed = parseRuleBody(await readJson(req))
                if (parsed.error || !parsed.value) {
                    json(res, 400, { error: parsed.error })
                    return
                }
                const row = insertFilterRule(parsed.value)
                json(res, 200, { rule: normalizeRule(row) })
                return
            }

            const ruleMatch = /^\/api\/filter\/rules\/(\d+)$/.exec(url.pathname)
            if (
                ruleMatch &&
                (req.method === "POST" || req.method === "DELETE")
            ) {
                const id = Number(ruleMatch[1])
                const existing = getFilterRule(id)
                if (!existing) {
                    json(res, 404, { error: "no such rule" })
                    return
                }
                if (req.method === "DELETE") {
                    if (!deleteFilterRule(id)) {
                        json(res, 500, { error: "delete failed" })
                        return
                    }
                    json(res, 200, { ok: true })
                    return
                }
                const parsed = parseRuleBody(await readJson(req), existing)
                if (parsed.error || !parsed.value) {
                    json(res, 400, { error: parsed.error })
                    return
                }
                const row = updateFilterRule(id, parsed.value)
                json(res, 200, { rule: normalizeRule(row ?? existing) })
                return
            }

            if (
                url.pathname === "/api/filter/preview" &&
                req.method === "POST"
            ) {
                const parsed = parseRuleBody(await readJson(req))
                if (parsed.error || !parsed.value) {
                    json(res, 400, { error: parsed.error })
                    return
                }
                if (!backend.previewRule) {
                    json(res, 501, { error: "backend has no categories" })
                    return
                }
                const result = await backend.previewRule(parsed.value)
                json(res, 200, result)
                return
            }

            if (url.pathname === "/api/items" && req.method === "GET") {
                const offset = Number(url.searchParams.get("offset") ?? 0)
                const limit = Number(url.searchParams.get("limit") ?? 50)
                const items = await backend.items({
                    source: url.searchParams.has("source")
                        ? Number(url.searchParams.get("source"))
                        : undefined,
                    unread: url.searchParams.get("unread") === "1",
                    starred: url.searchParams.get("starred") === "1",
                    search: url.searchParams.get("search") ?? undefined,
                    limit,
                    offset,
                })
                json(res, 200, {
                    items,
                    next: items.length < limit ? null : offset + items.length,
                })
                return
            }

            const itemMatch = /^\/api\/items\/(\d+)(\/\w+)?$/.exec(url.pathname)
            if (itemMatch) {
                const id = Number(itemMatch[1])
                const action = itemMatch[2]?.slice(1)
                if (!action && req.method === "GET") {
                    const item = await backend.item(id)
                    json(res, item ? 200 : 404, item ?? { error: "Not found" })
                    return
                }
                if (action && req.method === "POST") {
                    if (action !== "read" && action !== "star") {
                        json(res, 404, { error: "Unknown action" })
                        return
                    }
                    const body = await readJson(req)
                    const value =
                        body.value !== undefined ? Boolean(body.value) : true
                    await backend.setFlags([id], action, value)
                    json(res, 200, { ok: true })
                    return
                }
            }

            if (url.pathname === "/api/refresh" && req.method === "POST") {
                const limit = url.searchParams.get("limit")
                const result = await backend.refresh(
                    limit ? Number(limit) : undefined
                )
                // The sweep runs behind the response: draining a whole
                // category can take minutes, and the client reloads its feeds
                // immediately after this returns.
                void backend
                    .autoRead?.()
                    .catch(err => console.error("[auto-read] failed:", err))
                json(res, 202, result)
                return
            }

            if (url.pathname === "/api/stats" && req.method === "GET") {
                json(res, 200, await backend.stats())
                return
            }

            json(res, 404, { error: "Not found" })
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.error("[api] error:", message)
            json(res, 502, { error: message })
        }
    })

    return { server }
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
}

/**
 * Serve the browser build from webRoot, then fall back to the Electron dist
 * tree for the checked-in assets (icons/, article/, styles/). Path traversal is
 * rejected by re-checking the resolved prefix against the root.
 *
 * Exported so tests/static-cache-policy.cjs can assert the cache headers the
 * CDN in front of this site depends on.
 */
export async function serveStatic(
    pathname: string,
    res: http.ServerResponse,
    config: ServerConfig
): Promise<boolean> {
    const relative = pathname === "/" ? "/index.html" : pathname
    for (const root of [config.webRoot, config.staticRoot]) {
        const base = path.resolve(root)
        const target = path.resolve(base, "." + relative)
        if (target !== base && !target.startsWith(base + path.sep)) continue
        try {
            const data = await fs.promises.readFile(target)
            const ext = path.extname(target).toLowerCase()
            const name = path.basename(target)
            // Content-hashed bundles are immutable; everything else must
            // revalidate, or a deploy would keep serving the previous build
            // through Cloudflare for hours.
            const hashed = /\.[0-9a-f]{8,}\.(js|css)$/i.test(name)
            res.writeHead(200, {
                "content-type": MIME[ext] ?? "application/octet-stream",
                "content-length": data.byteLength,
                // Private on BOTH branches, for two different reasons:
                //  - the whole site is behind SSO, so a shared CDN cache must
                //    not hand the bundle to unauthenticated visitors;
                //  - Cloudflare's "Browser Cache TTL" zone setting (14400s here)
                //    replaces a bare `no-cache` with `max-age=14400` and then
                //    caches the file at the edge. A deploy would then serve the
                //    previous version for up to four hours. `private` is what
                //    makes the edge bypass instead of rewriting. Do not drop it
                //    from the unhashed branch: no-cache alone is not enough.
                "cache-control": hashed
                    ? "private, max-age=31536000, immutable"
                    : "private, no-cache, must-revalidate",
            })
            res.end(data)
            return true
        } catch {
            // Not in this root; try the next one.
        }
    }
    return false
}

/** Throwaway HTML so the API can be eyeballed before any real front-end exists. */
function debugPage(token: string): string {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>reader-server</title>
<style>
body{font:14px/1.6 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:18px}li{margin:.35rem 0}small{color:#666}
a{color:#0b5cad;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body>
<h1>reader-server 冒烟页</h1>
<p><small>阶段 1 调试页，不是前端。token 已在 URL 中。</small></p>
<p id="stat"><small>loading…</small></p>
<ul id="list"></ul>
<script>
const token = ${JSON.stringify(token)};
const api = (path) => fetch("/api" + path, { headers: { authorization: "Bearer " + token } }).then(r => r.json());
(async () => {
  const h = await api("/health");
  document.getElementById("stat").innerHTML = "<small>backend " + h.backend + " · 缓存 " +
    h.items + " · 未读 " + h.unread + " · 源 " + h.sources + " · 刷新中 " + h.refreshing + "</small>";
  const data = await api("/items?unread=1&limit=40");
  const ul = document.getElementById("list");
  for (const item of data.items) {
    const li = document.createElement("li");
    li.innerHTML = '<a href="' + item.link + '" target="_blank" rel="noreferrer">' +
      item.title.replace(/</g, "&lt;") + "</a> <small>" +
      new Date(item.date).toLocaleString() + "</small>";
    ul.append(li);
  }
})();
</script></body></html>`
}
