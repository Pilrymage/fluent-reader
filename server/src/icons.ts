// Site icon resolution.
//
// Miniflux stores icons for most feeds, but it gives up when a site blocks the
// crawler or publishes its icon as an inline data: URI (linux.do does both), and
// those feeds then render an empty <img>. This module fills the gap: it fetches
// the site's own HTML, follows <link rel="icon">, understands data: URIs, and
// falls back to /favicon.ico. Results are cached in SQLite so the browser and
// Miniflux are each asked at most once per TTL.
import { get, run } from "./db.ts"

export interface IconBytes {
    body: Uint8Array
    contentType: string
}

// A crawler UA gets blocked; these are the headers a browser would send.
const BROWSER_HEADERS = {
    "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
}

const MAX_HTML_BYTES = 512 * 1024
const MAX_ICON_BYTES = 512 * 1024

export const ICON_TTL_MS = 7 * 24 * 3600_000
// A miss is retried sooner than a hit: sites change and a block is often
// temporary, but retrying on every page load would hammer them.
export const MISS_TTL_MS = 24 * 3600_000

const MAGIC: [number[], string][] = [
    [[0x89, 0x50, 0x4e, 0x47], "image/png"],
    [[0xff, 0xd8, 0xff], "image/jpeg"],
    [[0x47, 0x49, 0x46, 0x38], "image/gif"],
    [[0x00, 0x00, 0x01, 0x00], "image/x-icon"],
    [[0x00, 0x00, 0x02, 0x00], "image/x-icon"],
    [[0x52, 0x49, 0x46, 0x46], "image/webp"],
]

function sniff(bytes: Uint8Array): string | null {
    for (const [prefix, type] of MAGIC) {
        if (
            bytes.length >= prefix.length &&
            prefix.every((b, i) => bytes[i] === b)
        )
            return type
    }
    const head = Buffer.from(bytes.subarray(0, 256))
        .toString("latin1")
        .trimStart()
    if (head.startsWith("<svg") || head.startsWith("<?xml"))
        return "image/svg+xml"
    return null
}

/** Some servers answer icons with application/octet-stream; trust the bytes. */
function normaliseType(
    declared: string,
    bytes: Uint8Array,
    url: string
): string | null {
    const type = declared.split(";")[0].trim().toLowerCase()
    if (type.startsWith("image/")) return type
    const sniffed = sniff(bytes)
    if (sniffed) return sniffed
    const ext = url.split("?")[0].toLowerCase()
    if (ext.endsWith(".png")) return "image/png"
    if (ext.endsWith(".svg")) return "image/svg+xml"
    if (ext.endsWith(".ico")) return "image/x-icon"
    return null
}

interface Page {
    html: string
    url: string
}

async function fetchPage(url: string, timeoutMs: number): Promise<Page | null> {
    try {
        const response = await fetch(url, {
            headers: BROWSER_HEADERS,
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
        })
        // A 403 page is still the site's own HTML and often still carries its
        // icon link (Discourse does), so parse the body whatever the status.
        const length = Number(response.headers.get("content-length") ?? 0)
        if (length > MAX_HTML_BYTES) return null
        const html = await response.text()
        if (html.length > MAX_HTML_BYTES) return null
        return { html, url: response.url || url }
    } catch {
        return null
    }
}

function parseAttrs(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {}
    const pattern =
        /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(tag))) {
        attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ""
    }
    return attrs
}

function decodeDataUri(uri: string): IconBytes | null {
    const match = /^data:([^,]*),(.*)$/is.exec(uri)
    if (!match) return null
    const params = match[1]
    const payload = match[2]
    const contentType = params.split(";")[0].trim().toLowerCase() || "image/png"
    if (!contentType.startsWith("image/")) return null
    let body: Uint8Array
    if (/;base64/i.test(params)) {
        const buffer = Buffer.from(payload, "base64")
        if (buffer.byteLength === 0) return null
        body = new Uint8Array(buffer)
    } else {
        body = new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8"))
    }
    if (body.byteLength === 0 || body.byteLength > MAX_ICON_BYTES) return null
    return { body, contentType }
}

function resolveUrl(href: string, base: string): string | null {
    if (href.startsWith("data:")) return href
    try {
        const url = new URL(href, base)
        return url.protocol === "http:" || url.protocol === "https:"
            ? url.toString()
            : null
    } catch {
        return null
    }
}

export async function fetchSiteIcon(
    candidate: string,
    timeoutMs: number
): Promise<IconBytes | null> {
    return fetchIconBytes(candidate, timeoutMs)
}

async function fetchIconBytes(
    candidate: string,
    timeoutMs: number
): Promise<IconBytes | null> {
    if (candidate.startsWith("data:")) return decodeDataUri(candidate)
    try {
        const response = await fetch(candidate, {
            headers: { ...BROWSER_HEADERS, accept: "image/*,*/*;q=0.8" },
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return null
        const buffer = new Uint8Array(await response.arrayBuffer())
        if (buffer.byteLength === 0 || buffer.byteLength > MAX_ICON_BYTES)
            return null
        const contentType = normaliseType(
            response.headers.get("content-type") ?? "",
            buffer,
            response.url || candidate
        )
        return contentType ? { body: buffer, contentType } : null
    } catch {
        return null
    }
}

function originOf(url: string): string | null {
    try {
        return new URL(url).origin
    } catch {
        return null
    }
}

/**
 * Ask the site itself for an icon. Tries every <link rel="icon"> in document
 * order, then the conventional paths. Returns null when the site offers none.
 */
export async function discoverIcon(
    siteUrl: string,
    timeoutMs: number
): Promise<IconBytes | null> {
    if (!originOf(siteUrl)) return null
    const page = await fetchPage(siteUrl, timeoutMs)
    const candidates: string[] = []
    if (page) {
        for (const tag of page.html.match(/<link\b[^>]*>/gi) ?? []) {
            const attrs = parseAttrs(tag)
            if (!attrs.href) continue
            const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/)
            if (!rel.some(value => value.includes("icon"))) continue
            const resolved = resolveUrl(attrs.href, page.url)
            if (resolved) candidates.push(resolved)
        }
    }
    const origin = originOf(page?.url ?? siteUrl)
    if (origin) {
        for (const suffix of [
            "/favicon.ico",
            "/apple-touch-icon.png",
            "/favicon.png",
        ]) {
            candidates.push(origin + suffix)
        }
    }
    const seen = new Set<string>()
    for (const candidate of candidates) {
        if (seen.has(candidate)) continue
        seen.add(candidate)
        const icon = await fetchIconBytes(candidate, timeoutMs)
        if (icon) return icon
    }
    return null
}

// Deterministic per source so the same feed keeps its colour.
const LETTER_COLORS = [
    "#0b5cad",
    "#498205",
    "#8764b8",
    "#c239b3",
    "#ca5010",
    "#038387",
    "#986f0b",
    "#a4262c",
]

/**
 * Last resort: an SVG monogram. It keeps the source list aligned instead of
 * leaving a blank gap where a feed publishes no icon at all.
 */
export function letterIcon(name: string, key: number): IconBytes {
    const letter = Array.from(name.trim())[0] ?? "?"
    const safe = letter
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
    const color = LETTER_COLORS[Math.abs(key) % LETTER_COLORS.length]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="43" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="34" font-weight="600" fill="#fff">${safe}</text></svg>`
    return {
        body: new Uint8Array(Buffer.from(svg, "utf8")),
        contentType: "image/svg+xml",
    }
}

export interface CachedIcon {
    contentType: string
    body: Uint8Array | null
    fetchedAt: number
}

export function readCachedIcon(sid: number): CachedIcon | null {
    const row = get<{
        content_type: string | null
        body: Uint8Array | null
        fetched_at: number
    }>(
        "SELECT content_type, body, fetched_at FROM source_icons WHERE sid = ?",
        sid
    )
    if (!row) return null
    return {
        contentType: row.content_type ?? "",
        body: row.body ?? null,
        fetchedAt: row.fetched_at,
    }
}

export function writeCachedIcon(
    sid: number,
    icon: IconBytes | null,
    now = Date.now()
) {
    run(
        `INSERT INTO source_icons (sid, content_type, body, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
             content_type = excluded.content_type,
             body = excluded.body,
             fetched_at = excluded.fetched_at`,
        sid,
        icon?.contentType ?? null,
        icon?.body ?? null,
        now
    )
}

export function isFresh(cached: CachedIcon, now = Date.now()): boolean {
    const ttl = cached.body ? ICON_TTL_MS : MISS_TTL_MS
    return now - cached.fetchedAt < ttl
}
