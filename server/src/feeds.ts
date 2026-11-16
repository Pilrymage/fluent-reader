import Parser from "rss-parser"
import type { NewItem, SourceRow } from "./db.ts"
import { insertItems, knownItemKeys, touchSource } from "./db.ts"
import { firstImage, textOf } from "./html.ts"

const USER_AGENT =
    "FluentReaderServer/0.1 (+https://github.com/Pilrymage/fluent-reader)"
const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_CONCURRENCY = 4

// Same custom fields the Electron renderer asks for, so both implementations
// see the same item shape.
const parser = new Parser({
    customFields: {
        item: [
            "thumb",
            "image",
            ["content:encoded", "fullContent"],
            ["media:content", "mediaContent", { keepArray: true }],
        ],
    },
})

const CHARSET_RE = /charset=["']?([^"'();\s]+)/i
const XML_DECL_RE = /^\s*<\?xml[^>]*encoding=["']([^"']+)["']/i
const META_CHARSET_RE = /<meta[^>]+charset=["']?([^"'\s/>;]+)/i

function detectCharset(contentType: string | null, head: string) {
    const fromHeader = contentType
        ? CHARSET_RE.exec(contentType)?.[1]
        : undefined
    if (fromHeader) return fromHeader
    return XML_DECL_RE.exec(head)?.[1] ?? META_CHARSET_RE.exec(head)?.[1]
}

function decodeBody(buffer: ArrayBuffer, contentType: string | null): string {
    // The charset hint can sit in the header, an XML declaration or an HTML
    // meta tag; sniff all three before defaulting to UTF-8.
    const head = new TextDecoder("utf-8").decode(buffer.slice(0, 2048))
    const charset = (detectCharset(contentType, head) ?? "utf-8")
        .trim()
        .toLowerCase()
    try {
        return new TextDecoder(charset).decode(buffer)
    } catch {
        return new TextDecoder("utf-8").decode(buffer)
    }
}

function toTimestamp(value: unknown, fallback: number): number {
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return value.getTime()
    }
    return fallback
}

interface ParsedItem {
    guid?: string
    id?: string
    title?: string
    link?: string
    isoDate?: string
    pubDate?: string
    content?: string
    summary?: string
    contentSnippet?: string
    creator?: string
    author?: string
    thumb?: string
    fullContent?: string
    enclosure?: { url?: string }
    mediaContent?: unknown
}

function mediaThumb(item: ParsedItem): string | null {
    const media = item.mediaContent
    const entries = Array.isArray(media) ? media : media ? [media] : []
    for (const entry of entries) {
        const url =
            (entry as { $?: { url?: string } })?.$?.url ??
            (entry as { url?: string })?.url
        if (typeof url === "string" && url.startsWith("http")) return url
    }
    return null
}

export function toNewItems(
    feed: { items?: ParsedItem[] },
    sid: number,
    now = Date.now()
): NewItem[] {
    const items: NewItem[] = []
    for (const item of feed.items ?? []) {
        const content = item.fullContent ?? item.content ?? item.summary ?? ""
        const link = typeof item.link === "string" ? item.link : ""
        const date = toTimestamp(item.isoDate, toTimestamp(item.pubDate, now))
        const guid =
            item.guid || item.id || link || `${item.title ?? ""}|${date}`
        items.push({
            source: sid,
            guid,
            title: textOf(item.title ?? "") || "(untitled)",
            link,
            date,
            fetchedDate: now,
            thumb:
                (typeof item.thumb === "string" ? item.thumb : null) ??
                firstImage(content) ??
                (typeof item.enclosure?.url === "string"
                    ? item.enclosure.url
                    : null) ??
                mediaThumb(item),
            content,
            snippet: (item.contentSnippet ?? textOf(content))
                .trim()
                .slice(0, 1000),
            creator: item.creator || item.author || null,
        })
    }
    return items
}

export interface FetchResult {
    sid: number
    name: string
    ok: boolean
    status?: number
    newItems: number
    totalItems: number
    durationMs: number
    error?: string
}

export async function fetchOneSource(
    source: SourceRow,
    options: { timeoutMs?: number; now?: number } = {}
): Promise<FetchResult> {
    const started = Date.now()
    const now = options.now ?? started
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const base = { sid: source.sid, name: source.name, durationMs: 0 }
    try {
        const response = await fetch(source.url, {
            headers: {
                "user-agent": USER_AGENT,
                "accept":
                    "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) {
            return {
                ...base,
                ok: false,
                status: response.status,
                newItems: 0,
                totalItems: 0,
                durationMs: Date.now() - started,
                error: `HTTP ${response.status}`,
            }
        }
        const body = decodeBody(
            await response.arrayBuffer(),
            response.headers.get("content-type")
        )
        const feed = await parser.parseString(body)
        const parsed = toNewItems(feed, source.sid, now)
        const known = knownItemKeys(source.sid)
        const fresh = parsed.filter(
            item =>
                !known.has(item.guid) && !(item.link && known.has(item.link))
        )
        // Newest first keeps the de-dupe window aligned with what the client shows.
        fresh.sort((a, b) => a.date - b.date)
        const inserted = insertItems(fresh)
        touchSource(source.sid, now)
        return {
            ...base,
            ok: true,
            status: response.status,
            newItems: inserted,
            totalItems: parsed.length,
            durationMs: Date.now() - started,
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
            ...base,
            ok: false,
            newItems: 0,
            totalItems: 0,
            durationMs: Date.now() - started,
            error: message,
        }
    }
}

/** Bounded parallel refresh: 259 feeds fanned out at once would just time out. */
export async function refreshSources(
    sources: SourceRow[],
    options: {
        concurrency?: number
        timeoutMs?: number
        limit?: number
        onResult?: (result: FetchResult) => void
    } = {}
): Promise<FetchResult[]> {
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    const queue = options.limit ? sources.slice(0, options.limit) : sources
    const results: FetchResult[] = []
    let cursor = 0
    const workers = Array.from(
        { length: Math.min(concurrency, queue.length) },
        async () => {
            while (cursor < queue.length) {
                const source = queue[cursor]
                cursor += 1
                const result = await fetchOneSource(source, {
                    timeoutMs: options.timeoutMs,
                })
                results.push(result)
                options.onResult?.(result)
            }
        }
    )
    await Promise.all(workers)
    return results
}
