import type { ServerConfig } from "./config.ts"
import {
    addRuleHits,
    countItems,
    countUnread,
    getItem,
    listFilterRules,
    listItems,
    listSources,
    markSourceRead,
    setItemFlag,
    sourcesWithUnread,
    upsertEntries,
} from "./db.ts"
import type { FilterRuleRow, SourceRow } from "./db.ts"
import { firstImage, textOf } from "./html.ts"
import {
    discoverIcon,
    fetchSiteIcon,
    isFresh,
    letterIcon,
    readCachedIcon,
    writeCachedIcon,
} from "./icons.ts"

export interface SourceView {
    sid: number
    url: string
    name: string
    iconurl: string | null
    unreadCount: number
    lastFetched: number | null
    /** Miniflux category; the group list is built from these. */
    category: { id: number; title: string } | null
}

export interface GroupView {
    gid: number
    name: string
    sids: number[]
}

/** Category ids are small integers, so groups from them start past anything
 *  the client allocates locally (that counter starts at 0). */
const GROUP_GID_BASE = 1_000_000

export interface ItemView {
    _id: number
    source: number
    title: string
    link: string
    date: number
    thumb: string | null
    snippet: string
    creator: string | null
    hasRead: boolean
    starred: boolean
    ref: string | null
}

export interface ItemDetail extends ItemView {
    content: string
}

export interface ItemQuery {
    source?: number
    unread?: boolean
    starred?: boolean
    search?: string
    limit?: number
    offset?: number
}

export interface ReaderBackend {
    readonly kind: "miniflux" | "local"
    sources(): Promise<SourceView[]>
    groups(): Promise<GroupView[]>
    items(query: ItemQuery): Promise<ItemView[]>
    item(id: number): Promise<ItemDetail | null>
    setFlags(
        ids: number[],
        field: "read" | "star",
        value: boolean
    ): Promise<void>
    markSourcesRead(sids: number[]): Promise<void>
    refresh(limit?: number): Promise<unknown>
    /** The category auto-read filter (READER_AUTO_READ_GROUPS): marks every
     *  unread entry of the listed categories read. Absent on backends that
     *  have no categories. */
    autoRead?(): Promise<{ groups: number; entries: number }>
    /** Dry-run one candidate rule against current unread entries: report the
     *  matches without marking anything. Absent on backends without
     *  categories. */
    previewRule?(
        rule: FilterRuleRow,
        maxEntries?: number
    ): Promise<{
        scanned: number
        matched: number
        samples: { feed: string; title: string }[]
    }>
    stats(): Promise<{
        items: number
        unread: number
        sources: number
        refreshing: boolean
    }>
    icon(sid: number): Promise<{ body: Uint8Array; contentType: string } | null>
}

const clamp = (value: number | undefined, fallback: number) =>
    Math.min(Math.max(value ?? fallback, 1), 200)

/** Miniflux serves full pages of this size; a page shorter than the request
 *  only ever means the listing is exhausted. */
const UNREAD_PAGE_SIZE = 100

/** One feed's sweep stops after this many pages even if unread entries
 *  remain, so a pathological feed cannot wedge the sweep; the next sweep
 *  continues where this one stopped. 200 pages × 100 entries is far past any
 *  real backlog. */
const MAX_SWEEP_PAGES = 200

/** Max unread entries a rule preview walks before reporting back. */
const PREVIEW_ENTRY_CAP = 800
/** Matched titles a preview reports; the rest is a count. */
const PREVIEW_SAMPLE_CAP = 50

function ruleFieldText(entry: MinifluxEntry, field: string): string {
    const title = entry.title ?? ""
    const author = entry.author ?? ""
    if (field === "creator") return author
    if (field === "title_creator") return `${title}\n${author}`
    return title
}

type CompiledRule = {
    rule: FilterRuleRow
    test: (entry: MinifluxEntry) => boolean
}

/**
 * Compile one filter rule into a predicate over Miniflux entries.
 *
 *  - kind "feed": matches the listed feed ids (sids, comma-separated).
 *  - kind "keyword": substring (case-insensitive) or regex (case-insensitive)
 *    over title / creator / both, in the configured scope (Miniflux category
 *    title, or "*" for every category).
 *
 * A rule that cannot compile (bad regex, empty sids, empty pattern) returns
 * null and is skipped instead of failing the sweep; the API layer rejects
 * those at creation time, this is the defensive second line.
 */
function compileRule(rule: FilterRuleRow): CompiledRule | null {
    if (rule.kind === "feed") {
        const sids = new Set(
            (rule.sids ?? "")
                .split(",")
                .map(part => Number(part.trim()))
                .filter(Number.isFinite)
        )
        if (sids.size === 0) return null
        return { rule, test: entry => sids.has(entry.feed_id) }
    }
    const pattern = rule.pattern ?? ""
    if (!pattern) return null
    if (rule.mode === "regex") {
        let regex: RegExp
        try {
            regex = new RegExp(pattern, "i")
        } catch {
            return null
        }
        return {
            rule,
            test: entry => regex.test(ruleFieldText(entry, rule.field)),
        }
    }
    const needle = pattern.toLowerCase()
    return {
        rule,
        test: entry =>
            ruleFieldText(entry, rule.field).toLowerCase().includes(needle),
    }
}

/* ------------------------------------------------------------------ *
 * Miniflux backend: Miniflux stays the only fetcher and store. This
 * layer reshapes its REST API for the front-end, keeps a lazy cache of
 * the entries actually read (so detail views never re-download a list),
 * and hides the API token from the browser.
 * ------------------------------------------------------------------ */

interface MinifluxEntry {
    id: number
    feed_id: number
    title: string
    url: string
    published_at: string
    content: string
    author: string
    status: string
    starred: boolean
}

interface MinifluxFeed {
    id: number
    title: string
    feed_url: string
    site_url: string
    category?: { id: number; title: string } | null
    icon?: { icon_id: number; external_icon_id?: string } | null
}

/** Miniflux stores an icon object even when it never found one (icon_id: 0). */
function hasMinifluxIcon(feed: MinifluxFeed): boolean {
    const icon = feed.icon
    if (!icon) return false
    return (icon.icon_id ?? 0) > 0 || Boolean(icon.external_icon_id)
}

function minifluxClient(config: ServerConfig) {
    const base = config.minifluxUrl
    async function call<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await fetch(new URL(path, base), {
            ...init,
            headers: {
                "x-auth-token": config.minifluxToken,
                "content-type": "application/json",
                ...(init?.headers ?? {}),
            },
            signal: AbortSignal.timeout(config.minifluxTimeoutMs),
        })
        if (!response.ok) {
            const body = await response.text()
            throw new Error(
                `Miniflux ${response.status} on ${path}: ${body.slice(0, 200)}`
            )
        }
        if (response.status === 204) return null as T
        return (await response.json()) as T
    }

    return {
        feeds: () => call<MinifluxFeed[]>("/v1/feeds"),
        counters: () =>
            // Miniflux names these "reads"/"unreads", not "read"/"unread".
            call<{
                reads: Record<string, number>
                unreads: Record<string, number>
            }>("/v1/feeds/counters"),
        entries: (params: Record<string, string | number | undefined>) => {
            const search = new URLSearchParams()
            for (const [key, value] of Object.entries(params)) {
                if (value !== undefined && value !== "")
                    search.set(key, String(value))
            }
            return call<{ total: number; entries: MinifluxEntry[] }>(
                `/v1/entries?${search.toString()}`
            )
        },
        setStatus: (entryIds: number[], status: "read" | "unread") =>
            call<null>("/v1/entries", {
                method: "PUT",
                body: JSON.stringify({ entry_ids: entryIds, status }),
            }),
        toggleStar: (entryId: number) =>
            call<null>(`/v1/entries/${entryId}/bookmark`, { method: "PUT" }),
        refresh: () => call<null>("/v1/feeds/refresh", { method: "PUT" }),
        icon: async (feedId: number) => {
            const response = await fetch(
                new URL(`/v1/feeds/${feedId}/icon`, base),
                {
                    headers: { "x-auth-token": config.minifluxToken },
                    signal: AbortSignal.timeout(config.minifluxTimeoutMs),
                }
            )
            if (!response.ok) return null
            const contentType = response.headers.get("content-type") ?? ""
            // This Miniflux answers with a JSON envelope
            // {"mime_type":"image/svg+xml","data":"image/svg+xml;base64,…"}
            // instead of the raw image, so unwrap it when present.
            if (contentType.includes("application/json")) {
                const payload = (await response.json()) as {
                    mime_type?: string
                    data?: string
                }
                const encoded = payload.data ?? ""
                const base64 = encoded.includes(",")
                    ? encoded.slice(encoded.indexOf(",") + 1)
                    : encoded
                if (!base64) return null
                return {
                    body: new Uint8Array(Buffer.from(base64, "base64")),
                    contentType: payload.mime_type ?? "image/png",
                }
            }
            return {
                body: new Uint8Array(await response.arrayBuffer()),
                contentType: contentType || "image/png",
            }
        },
    }
}

function createMinifluxBackend(config: ServerConfig): ReaderBackend {
    const client = minifluxClient(config)
    let refreshing = false
    let lastRefreshAt: number | null = null
    // The feed list is needed by sources(), groups(), stats() and icon(); one
    // page load would otherwise fetch it four times over.
    let feedCache: { at: number; feeds: MinifluxFeed[] } | null = null
    async function feeds(maxAgeMs = 15_000): Promise<MinifluxFeed[]> {
        const now = Date.now()
        if (feedCache && now - feedCache.at < maxAgeMs) return feedCache.feeds
        const list = await client.feeds()
        feedCache = { at: now, feeds: list }
        return list
    }

    function toCacheRow(entry: MinifluxEntry, now: number) {
        const content = entry.content ?? ""
        return {
            source: entry.feed_id,
            guid: String(entry.id),
            title: entry.title || "(untitled)",
            link: entry.url,
            date: Date.parse(entry.published_at) || now,
            fetchedDate: now,
            content,
            snippet: textOf(content).slice(0, 1000),
            creator: entry.author || null,
            thumb: firstImage(content),
            hasRead: entry.status === "read",
            starred: Boolean(entry.starred),
        }
    }

    function toView(
        row: {
            source: number
            guid: string
            title: string
            link: string
            date: number
            thumb: string | null
            snippet: string
            creator: string | null
            hasRead: boolean
            starred: boolean
        },
        id: number
    ): ItemView {
        return {
            _id: id,
            source: row.source,
            title: row.title,
            link: row.link,
            date: row.date,
            thumb: row.thumb,
            snippet: row.snippet,
            creator: row.creator,
            hasRead: Boolean(row.hasRead),
            starred: Boolean(row.starred),
            ref: row.guid,
        }
    }

    /**
     * Drain one feed's unread entries, marking read those the predicate keeps.
     *
     * The unread listing shrinks as entries are marked, so the cursor advances
     * only over entries left unread; a page shorter than the request or an
     * empty page ends the loop. `keep` is the extension point for
     * keyword-level filters: today every caller passes `() => true` to mark
     * the whole category, a future rule engine can pass a title/author test
     * and the same loop marks selectively without skipping anything.
     */
    async function drainFeedUnread(
        sid: number,
        keep: (entry: MinifluxEntry) => boolean = () => true,
        maxPages: number = MAX_SWEEP_PAGES
    ): Promise<number> {
        let marked = 0
        let offset = 0
        for (let page = 0; page < maxPages; page += 1) {
            const pending = await client.entries({
                feed_id: sid,
                status: "unread",
                limit: UNREAD_PAGE_SIZE,
                offset,
            })
            if (pending.entries.length === 0) break
            const kept = pending.entries.filter(keep)
            if (kept.length > 0) {
                await client.setStatus(
                    kept.map(entry => entry.id),
                    "read"
                )
                marked += kept.length
            }
            offset += pending.entries.length - kept.length
            if (pending.entries.length < UNREAD_PAGE_SIZE) break
        }
        return marked
    }

    /** Mark unread entries of these feeds read. With `keep`, only entries the
     *  predicate accepts are marked (the filter rules); without it the whole
     *  feed is drained. Feeds run in a small worker pool; one feed failing
     *  does not stop the others. Returns how many entries were marked. */
    async function markFeedsRead(
        sids: number[],
        keep?: (entry: MinifluxEntry) => boolean
    ): Promise<number> {
        const test = keep ?? (() => true)
        const queue = [...sids]
        let marked = 0
        const runners = Array.from(
            { length: Math.min(6, queue.length) },
            async () => {
                while (queue.length > 0) {
                    const sid = queue.shift()
                    if (sid === undefined) break
                    try {
                        // Compound assignment reads the target BEFORE the
                        // await resolves, so `marked += await drain()` loses
                        // updates when the worker pool drains feeds
                        // concurrently. Decoupling the await from the read is
                        // the fix; keep it this way.
                        const drained = await drainFeedUnread(sid, test)
                        marked += drained
                        markSourceRead(sid)
                    } catch (err) {
                        console.error(
                            `[markSourcesRead] feed ${sid}:`,
                            err instanceof Error ? err.message : err
                        )
                    }
                }
            }
        )
        await Promise.all(runners)
        return marked
    }

    const backend: ReaderBackend = {
        kind: "miniflux",
        async sources() {
            const [list, counters] = await Promise.all([
                feeds(),
                client.counters(),
            ])
            return list
                .map(feed => ({
                    sid: feed.id,
                    url: feed.feed_url,
                    name: feed.title,
                    // Always set: icon() resolves Miniflux → site → monogram,
                    // and an <img> that 404s shows nothing at all.
                    iconurl: `/api/sources/${feed.id}/icon`,
                    unreadCount: counters.unreads[String(feed.id)] ?? 0,
                    lastFetched: null,
                    category: feed.category
                        ? { id: feed.category.id, title: feed.category.title }
                        : null,
                }))
                .sort(
                    (a, b) =>
                        b.unreadCount - a.unreadCount ||
                        a.name.localeCompare(b.name)
                )
        },
        async groups() {
            const list = await feeds()
            const byCategory = new Map<
                number,
                { name: string; sids: number[] }
            >()
            for (const feed of list) {
                const category = feed.category
                if (!category) continue
                const entry = byCategory.get(category.id) ?? {
                    name: category.title,
                    sids: [],
                }
                entry.sids.push(feed.id)
                byCategory.set(category.id, entry)
            }
            return [...byCategory.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([id, entry]) => ({
                    gid: GROUP_GID_BASE + id,
                    name: entry.name,
                    sids: entry.sids,
                }))
        },
        async items(query) {
            const now = Date.now()
            const { entries } = await client.entries({
                feed_id: query.source,
                status: query.unread ? "unread" : undefined,
                starred: query.starred ? "starred" : undefined,
                search: query.search,
                limit: clamp(query.limit, 50),
                offset: Math.max(query.offset ?? 0, 0),
                order: "published_at",
                direction: "desc",
            })
            const rows = entries.map(entry => toCacheRow(entry, now))
            const ids = upsertEntries(rows)
            return rows.map(row => toView(row, ids.get(row.guid) ?? 0))
        },
        async item(id) {
            const cached = getItem(id)
            if (!cached) return null
            return {
                _id: cached._id,
                source: cached.source,
                title: cached.title,
                link: cached.link,
                date: cached.date,
                thumb: cached.thumb,
                snippet: cached.snippet,
                creator: cached.creator,
                hasRead: Boolean(cached.hasRead),
                starred: Boolean(cached.starred),
                ref: cached.serviceRef,
                content: cached.content,
            }
        },
        async setFlags(ids, field, value) {
            const rows = []
            for (const id of ids) {
                const row = getItem(id)
                if (row?.serviceRef) rows.push(row)
            }
            if (rows.length === 0) return
            const entryIds = rows.map(row => Number(row.serviceRef))
            if (field === "read") {
                // One Miniflux call for a whole burst of keypresses.
                await client.setStatus(entryIds, value ? "read" : "unread")
                for (const row of rows) setItemFlag(row._id, "hasRead", value)
            } else {
                // Miniflux bookmarks toggle, so a batch of stars cannot be one
                // request. The client only batches read state.
                for (const entryId of entryIds) await client.toggleStar(entryId)
                for (const row of rows) setItemFlag(row._id, "starred", value)
            }
        },
        async markSourcesRead(sids) {
            // One request per feed used to leave any backlog past the first
            // 200 unread in place; the drain loops until the feed is empty.
            await markFeedsRead(sids)
        },
        async refresh() {
            if (refreshing) return { started: false }
            refreshing = true
            try {
                await client.refresh()
                lastRefreshAt = Date.now()
                return { started: true, at: lastRefreshAt }
            } finally {
                refreshing = false
            }
        },
        /**
         * The category auto-read filter (READER_AUTO_READ_GROUPS) plus the
         * filter_rules table: after every refresh,
         *  - every unread entry of a listed category is marked read, and
         *  - unread entries matching an enabled rule (whole feed, or keyword
         *    on title/creator) are marked read, with per-rule hit counts.
         * All marks are written to Miniflux, so they apply to every client.
         * A category with neither whole-read nor any applicable rule is not
         * scanned. Inside a whole-read category the rules are moot, so its
         * feeds are drained unconditionally and hits are not counted there.
         */
        async autoRead() {
            const autoNames = config.autoReadGroups
            const rules = listFilterRules()
                .filter(rule => rule.enabled)
                .map(compileRule)
                .filter(
                    (compiled): compiled is CompiledRule => compiled !== null
                )
            if (autoNames.length === 0 && rules.length === 0)
                return { groups: 0, entries: 0 }
            const groups = await backend.groups()
            let wholeEntries = 0
            let ruleEntries = 0
            let swept = 0
            const wholeGroups: string[] = []
            const hits = new Map<number, number>()
            for (const group of groups) {
                const whole = autoNames.includes(group.name)
                const applicable = rules.filter(
                    compiled =>
                        compiled.rule.scope === "*" ||
                        compiled.rule.scope === group.name
                )
                if (!whole && applicable.length === 0) continue
                swept += 1
                const keep = whole
                    ? undefined
                    : entry => {
                          let matched = false
                          for (const compiled of applicable) {
                              if (compiled.test(entry)) {
                                  matched = true
                                  hits.set(
                                      compiled.rule.id,
                                      (hits.get(compiled.rule.id) ?? 0) + 1
                                  )
                              }
                          }
                          return matched
                      }
                const marked = await markFeedsRead(group.sids, keep)
                if (whole) {
                    wholeEntries += marked
                    if (marked > 0) wholeGroups.push(group.name)
                } else {
                    ruleEntries += marked
                }
            }
            if (hits.size > 0) {
                addRuleHits(hits)
                const summary = [...hits.entries()]
                    .map(([id, count]) => `#${id}:${count}`)
                    .join(", ")
                console.log(`[auto-read] rule hits: ${summary}`)
            }
            const entries = wholeEntries + ruleEntries
            if (entries > 0) {
                console.log(
                    `[auto-read] marked ${entries} unread (whole: ${wholeEntries}${
                        wholeGroups.length > 0
                            ? ` [${wholeGroups.join(", ")}]`
                            : ""
                    }, rules: ${ruleEntries})`
                )
            }
            return { groups: swept, entries }
        },
        /**
         * Dry-run one candidate rule against the current unread entries of
         * its scope: counts matches and returns a sample of titles. Marks
         * nothing, writes nothing.
         */
        async previewRule(rule, maxEntries = PREVIEW_ENTRY_CAP) {
            const compiled = compileRule(rule)
            if (!compiled) throw new Error("rule does not compile")
            const groups = await backend.groups()
            const feedsById = new Map(
                (await feeds()).map(feed => [feed.id, feed.title])
            )
            const sids =
                rule.kind === "feed"
                    ? [...(rule.sids ?? "").split(",")]
                          .map(part => Number(part.trim()))
                          .filter(Number.isFinite)
                    : groups
                          .filter(
                              group =>
                                  rule.scope === "*" ||
                                  rule.scope === group.name
                          )
                          .flatMap(group => group.sids)
            let scanned = 0
            let matched = 0
            const samples: { feed: string; title: string }[] = []
            for (const sid of sids) {
                for (
                    let offset = 0;
                    offset < maxEntries;
                    offset += UNREAD_PAGE_SIZE
                ) {
                    const { entries } = await client.entries({
                        feed_id: sid,
                        status: "unread",
                        limit: UNREAD_PAGE_SIZE,
                        offset,
                    })
                    for (const entry of entries) {
                        scanned += 1
                        if (compiled.test(entry)) {
                            matched += 1
                            if (samples.length < PREVIEW_SAMPLE_CAP) {
                                samples.push({
                                    feed:
                                        feedsById.get(entry.feed_id) ??
                                        String(entry.feed_id),
                                    title: entry.title ?? "",
                                })
                            }
                        }
                    }
                    if (entries.length < UNREAD_PAGE_SIZE) break
                    if (scanned >= maxEntries) break
                }
                if (scanned >= maxEntries) break
            }
            return { scanned, matched, samples }
        },
        async stats() {
            const counters = await client.counters()
            const list = await feeds()
            return {
                items: countItems(),
                unread: Object.values(counters.unreads).reduce(
                    (a, b) => a + b,
                    0
                ),
                sources: list.length,
                refreshing,
            }
        },
        async icon(sid) {
            const feed = (await feeds()).find(item => item.id === sid)
            if (!feed) return null
            const cached = readCachedIcon(sid)
            if (cached && isFresh(cached)) {
                return cached.body
                    ? { body: cached.body, contentType: cached.contentType }
                    : letterIcon(feed.title, sid)
            }
            let icon = hasMinifluxIcon(feed) ? await client.icon(sid) : null
            if (!icon) {
                icon = await discoverIcon(
                    feed.site_url || feed.feed_url,
                    config.fetchTimeoutMs
                )
            }
            writeCachedIcon(sid, icon)
            return icon ?? letterIcon(feed.title, sid)
        },
    }
    return backend
}

/* ------------------------------------------------------------------ *
 * Local backend: this server fetches the feeds itself into SQLite.
 * Kept behind READER_BACKEND=local for experiments and for hosts that
 * cannot reach Miniflux.
 * ------------------------------------------------------------------ */

function createLocalBackend(config: ServerConfig): ReaderBackend {
    let refreshing: Promise<unknown> | null = null

    function toView(source: SourceRow & { unreadCount?: number }): SourceView {
        return {
            sid: source.sid,
            url: source.url,
            name: source.name,
            iconurl: source.iconurl,
            unreadCount: source.unreadCount ?? 0,
            lastFetched: source.lastFetched || null,
            category: null,
        }
    }

    return {
        kind: "local",
        async sources() {
            return sourcesWithUnread(true)
                .map(toView)
                .sort(
                    (a, b) =>
                        b.unreadCount - a.unreadCount ||
                        a.name.localeCompare(b.name)
                )
        },
        // The local backend has no categories: the client keeps using the
        // groups it allocated itself.
        async groups() {
            return []
        },
        async items(query) {
            return listItems({
                source: query.source,
                unread: query.unread,
                starred: query.starred,
                search: query.search,
                limit: query.limit,
                offset: query.offset,
            }).map(row => ({
                _id: row._id,
                source: row.source,
                title: row.title,
                link: row.link,
                date: row.date,
                thumb: row.thumb,
                snippet: row.snippet,
                creator: row.creator,
                hasRead: Boolean(row.hasRead),
                starred: Boolean(row.starred),
                ref: row.serviceRef,
            }))
        },
        async item(id) {
            const row = getItem(id)
            if (!row) return null
            return {
                _id: row._id,
                source: row.source,
                title: row.title,
                link: row.link,
                date: row.date,
                thumb: row.thumb,
                snippet: row.snippet,
                creator: row.creator,
                hasRead: Boolean(row.hasRead),
                starred: Boolean(row.starred),
                ref: row.serviceRef,
                content: row.content,
            }
        },
        async setFlags(ids, field, value) {
            for (const id of ids) {
                setItemFlag(id, field === "read" ? "hasRead" : "starred", value)
            }
        },
        async markSourcesRead(sids) {
            for (const sid of sids) markSourceRead(sid)
        },
        async refresh(limit) {
            if (refreshing) return { started: false }
            // Loaded on demand: the miniflux deployment never needs rss-parser,
            // so it must not be part of the process's import graph.
            const { refreshSources } = await import("./feeds.ts")
            refreshing = refreshSources(listSources(), {
                concurrency: config.concurrency,
                timeoutMs: config.fetchTimeoutMs,
                limit,
                onResult: result =>
                    console.log(
                        `[refresh] ${result.ok ? "ok  " : "FAIL"} ${
                            result.durationMs
                        }ms ${result.name}${
                            result.error ? " — " + result.error : ""
                        }`
                    ),
            }).finally(() => {
                refreshing = null
            })
            return { started: true }
        },
        async stats() {
            return {
                items: countItems(),
                unread: countUnread(),
                sources: listSources(true).length,
                refreshing: Boolean(refreshing),
            }
        },
        async icon(sid) {
            const source = listSources(true).find(row => row.sid === sid)
            if (!source) return null
            const cached = readCachedIcon(sid)
            if (cached && isFresh(cached)) {
                return cached.body
                    ? { body: cached.body, contentType: cached.contentType }
                    : letterIcon(source.name, sid)
            }
            let icon = null
            if (source.iconurl) {
                icon = await fetchSiteIcon(
                    source.iconurl,
                    config.fetchTimeoutMs
                )
            }
            if (!icon) {
                icon = await discoverIcon(source.url, config.fetchTimeoutMs)
            }
            writeCachedIcon(sid, icon)
            return icon ?? letterIcon(source.name, sid)
        },
    }
}

export function createBackend(config: ServerConfig): ReaderBackend {
    return config.backend === "miniflux"
        ? createMinifluxBackend(config)
        : createLocalBackend(config)
}
