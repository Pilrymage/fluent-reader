import { DatabaseSync } from "node:sqlite"
import type { StatementSync } from "node:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

// node:sqlite refuses boolean and undefined bind values, so every write path
// normalizes through these two helpers instead of touching the raw driver.
export type Bind = string | number | null | Uint8Array

let db: DatabaseSync
const prepared = new Map<string, StatementSync>()

function stmt(sql: string): StatementSync {
    let cached = prepared.get(sql)
    if (!cached) {
        cached = db.prepare(sql)
        prepared.set(sql, cached)
    }
    return cached
}

export function toBind(value: unknown): Bind {
    if (value === undefined || value === null) return null
    if (typeof value === "boolean") return value ? 1 : 0
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    // Binary columns (icon bodies) must reach the driver as bytes; String()
    // would turn every blob into the useless text "1,137,80,78,71,…".
    if (value instanceof Uint8Array) return value
    return String(value)
}

export function run(sql: string, ...params: unknown[]) {
    return stmt(sql).run(...params.map(toBind))
}

export function all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
) {
    return stmt(sql).all(...params.map(toBind)) as T[]
}

export function get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
) {
    return stmt(sql).get(...params.map(toBind)) as T | undefined
}

/**
 * Apply the drizzle migration files shipped with the Electron build, then add
 * the indexes this server needs. Migration files are hashed so an applied file
 * is never replayed, and each file is applied atomically.
 */
export function openDb(file: string, migrationsDir: string): DatabaseSync {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    db = new DatabaseSync(file)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (hash TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
    )
    if (!fs.existsSync(migrationsDir)) {
        throw new Error(`Migration directory not found: ${migrationsDir}`)
    }
    const files = fs
        .readdirSync(migrationsDir)
        .filter(name => name.endsWith(".sql"))
        .sort()
    for (const name of files) {
        const sqlText = fs.readFileSync(path.join(migrationsDir, name), "utf8")
        const hash = createHash("sha256").update(sqlText).digest("hex")
        if (
            get(
                "SELECT 1 AS present FROM schema_migrations WHERE hash = ?",
                hash
            )
        ) {
            continue
        }
        db.exec("BEGIN")
        try {
            for (const statement of sqlText.split("--> statement-breakpoint")) {
                if (statement.trim()) db.exec(statement)
            }
            run(
                "INSERT INTO schema_migrations (hash, applied_at) VALUES (?, ?)",
                hash,
                Date.now()
            )
            db.exec("COMMIT")
        } catch (err) {
            db.exec("ROLLBACK")
            throw err
        }
    }
    // The API always filters by source and orders by date; without these the
    // 40k+ row table degrades into a scan per request.
    db.exec(
        "CREATE INDEX IF NOT EXISTS idx_items_source_date ON items (source, date DESC)"
    )
    db.exec(
        "CREATE INDEX IF NOT EXISTS idx_items_unread_date ON items (hasRead, date DESC)"
    )
    db.exec(
        "CREATE INDEX IF NOT EXISTS idx_items_source_guid ON items (source, guid)"
    )
    // Server-owned cache of resolved site icons. It is not part of the Electron
    // schema, so it is created here rather than through a drizzle migration.
    db.exec(
        `CREATE TABLE IF NOT EXISTS source_icons (
            sid INTEGER PRIMARY KEY,
            content_type TEXT,
            body BLOB,
            fetched_at INTEGER NOT NULL
        )`
    )
    // Server-owned filter rules (whole-feed auto-read, keyword auto-read).
    // Same rationale as source_icons: rules change at runtime, a drizzle
    // migration would only add deployment friction. The future learning
    // system writes its decisions into this same table.
    db.exec(
        `CREATE TABLE IF NOT EXISTS filter_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT '*',
            sids TEXT,
            field TEXT NOT NULL DEFAULT 'title',
            mode TEXT NOT NULL DEFAULT 'substr',
            pattern TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL DEFAULT 'read',
            enabled INTEGER NOT NULL DEFAULT 1,
            hits INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            created_at INTEGER NOT NULL
        )`
    )
    return db
}

export interface SourceRow {
    sid: number
    url: string
    name: string
    iconurl: string | null
    openTarget: number
    lastFetched: number
    fetchFrequency: number
    textDir: number
    hidden: number
    unreadCount?: number
}

export interface ItemSummary {
    _id: number
    source: number
    guid: string | null
    title: string
    link: string
    date: number
    fetchedDate: number
    thumb: string | null
    snippet: string
    creator: string | null
    hasRead: number
    starred: number
    hidden: number
    serviceRef: string | null
}

export interface NewItem {
    source: number
    guid: string
    title: string
    link: string
    date: number
    fetchedDate: number
    thumb: string | null
    content: string
    snippet: string
    creator: string | null
}

export function listSources(includeHidden = false): SourceRow[] {
    return all<SourceRow>(
        `SELECT * FROM sources ${
            includeHidden ? "" : "WHERE hidden = 0"
        } ORDER BY name COLLATE NOCASE`
    )
}

export function sourcesWithUnread(includeHidden = false): SourceRow[] {
    const counts = new Map<number, number>()
    for (const row of all<{ source: number; count: number }>(
        "SELECT source, count(*) AS count FROM items WHERE hasRead = 0 GROUP BY source"
    )) {
        counts.set(row.source, row.count)
    }
    return listSources(includeHidden).map(source => ({
        ...source,
        unreadCount: counts.get(source.sid) ?? 0,
    }))
}

export function nextSid(): number {
    const row = get<{ sid: number | null }>(
        "SELECT max(sid) AS sid FROM sources"
    )
    return (row?.sid ?? 0) + 1
}

export function upsertSource(input: {
    url: string
    name: string
    iconurl?: string | null
    hidden?: boolean
}): number {
    const existing = get<{ sid: number }>(
        "SELECT sid FROM sources WHERE url = ?",
        input.url
    )
    if (existing) {
        run(
            "UPDATE sources SET name = ?, iconurl = coalesce(?, iconurl) WHERE sid = ?",
            input.name,
            input.iconurl ?? null,
            existing.sid
        )
        return existing.sid
    }
    const sid = nextSid()
    run(
        `INSERT INTO sources (sid, url, iconurl, name, openTarget, lastFetched, serviceRef, fetchFrequency, textDir, hidden)
         VALUES (?, ?, ?, ?, 0, 0, NULL, 0, 0, ?)`,
        sid,
        input.url,
        input.iconurl ?? null,
        input.name,
        input.hidden ?? false
    )
    return sid
}

export function touchSource(sid: number, when = Date.now()) {
    run("UPDATE sources SET lastFetched = ? WHERE sid = ?", when, sid)
}

/** Dedupe keys already stored for a source, so a refresh never re-inserts. */
export function knownItemKeys(sid: number): Set<string> {
    const keys = new Set<string>()
    for (const row of all<{ guid: string | null; link: string }>(
        "SELECT guid, link FROM items WHERE source = ?",
        sid
    )) {
        if (row.guid) keys.add(row.guid)
        if (row.link) keys.add(row.link)
    }
    return keys
}

export function insertItems(items: NewItem[]): number {
    if (items.length === 0) return 0
    let inserted = 0
    db.exec("BEGIN")
    try {
        for (const item of items) {
            run(
                `INSERT INTO items (source, guid, title, link, date, fetchedDate, thumb, content, snippet, creator, hasRead, starred, hidden, notify, serviceRef)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL)`,
                item.source,
                item.guid,
                item.title,
                item.link,
                item.date,
                item.fetchedDate,
                item.thumb,
                item.content,
                item.snippet,
                item.creator
            )
            inserted += 1
        }
        db.exec("COMMIT")
    } catch (err) {
        db.exec("ROLLBACK")
        throw err
    }
    return inserted
}

export interface CacheEntryRow {
    source: number
    guid: string
    title: string
    link: string
    date: number
    fetchedDate: number
    content: string
    snippet: string
    creator: string | null
    thumb: string | null
    hasRead: boolean
    starred: boolean
}

/**
 * Lazy cache of entries the client has actually paged through. Rows are keyed
 * by (source, guid) so an updated entry overwrites its cached copy, and the
 * numeric _id stays stable for the client across refreshes.
 */
export function upsertEntries(rows: CacheEntryRow[]): Map<string, number> {
    const ids = new Map<string, number>()
    if (rows.length === 0) return ids
    db.exec("BEGIN")
    try {
        for (const row of rows) {
            const existing = get<{ _id: number }>(
                "SELECT _id FROM items WHERE source = ? AND guid = ?",
                row.source,
                row.guid
            )
            if (existing) {
                run(
                    `UPDATE items SET title = ?, link = ?, date = ?, content = ?, snippet = ?,
                        creator = ?, thumb = ?, hasRead = ?, starred = ?, serviceRef = ? WHERE _id = ?`,
                    row.title,
                    row.link,
                    row.date,
                    row.content,
                    row.snippet,
                    row.creator,
                    row.thumb,
                    row.hasRead,
                    row.starred,
                    row.guid,
                    existing._id
                )
                ids.set(row.guid, existing._id)
            } else {
                const info = run(
                    `INSERT INTO items (source, guid, title, link, date, fetchedDate, thumb, content, snippet, creator, hasRead, starred, hidden, notify, serviceRef)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
                    row.source,
                    row.guid,
                    row.title,
                    row.link,
                    row.date,
                    row.fetchedDate,
                    row.thumb,
                    row.content,
                    row.snippet,
                    row.creator,
                    row.hasRead,
                    row.starred,
                    row.guid
                )
                ids.set(row.guid, Number(info.lastInsertRowid))
            }
        }
        db.exec("COMMIT")
    } catch (err) {
        db.exec("ROLLBACK")
        throw err
    }
    return ids
}

export interface ItemQuery {
    source?: number
    unread?: boolean
    starred?: boolean
    search?: string
    limit?: number
    offset?: number
    beforeDate?: number
    beforeId?: number
}

/**
 * Keyset pagination on (date, _id) instead of OFFSET: the feed grows while a
 * client pages through it, and OFFSET would shift rows out from under it.
 */
export function listItems(query: ItemQuery): ItemSummary[] {
    const where: string[] = ["hidden = 0"]
    const params: unknown[] = []
    if (query.source !== undefined) {
        where.push("source = ?")
        params.push(query.source)
    }
    if (query.unread) where.push("hasRead = 0")
    if (query.starred) where.push("starred = 1")
    if (query.search) {
        where.push("(title LIKE ? OR snippet LIKE ?)")
        params.push(`%${query.search}%`, `%${query.search}%`)
    }
    if (query.beforeDate !== undefined && query.beforeId !== undefined) {
        where.push("(date, _id) < (?, ?)")
        params.push(query.beforeDate, query.beforeId)
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
    const offset = Math.max(query.offset ?? 0, 0)
    return all<ItemSummary>(
        `SELECT _id, source, guid, title, link, date, fetchedDate, thumb, snippet, creator, hasRead, starred, hidden, serviceRef
         FROM items WHERE ${where.join(
             " AND "
         )} ORDER BY date DESC, _id DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset
    )
}

export function getItem(id: number) {
    return get<ItemSummary & { content: string }>(
        "SELECT * FROM items WHERE _id = ?",
        id
    )
}

export function setItemFlag(
    id: number,
    field: "hasRead" | "starred" | "hidden",
    value: boolean
) {
    run(`UPDATE items SET ${field} = ? WHERE _id = ?`, value, id)
}

export function countUnread(): number {
    const row = get<{ count: number }>(
        "SELECT count(*) AS count FROM items WHERE hasRead = 0 AND hidden = 0"
    )
    return row?.count ?? 0
}

export function countItems(): number {
    const row = get<{ count: number }>("SELECT count(*) AS count FROM items")
    return row?.count ?? 0
}

export function markSourceRead(sid: number, before?: number) {
    if (before === undefined) {
        run(
            "UPDATE items SET hasRead = 1 WHERE source = ? AND hasRead = 0",
            sid
        )
    } else {
        run(
            "UPDATE items SET hasRead = 1 WHERE source = ? AND hasRead = 0 AND date <= ?",
            sid,
            before
        )
    }
}

/* ------------------------------------------------------------------ *
 * Filter rules: whole-feed and keyword auto-read rules, server-owned
 * like source_icons. The learning system that is planned on top of
 * this writes rules through the same helpers.
 * ------------------------------------------------------------------ */

export interface FilterRuleRow {
    id: number
    kind: string
    scope: string
    sids: string | null
    field: string
    mode: string
    pattern: string
    action: string
    enabled: number
    hits: number
    note: string | null
    created_at: number
}

export function listFilterRules(): FilterRuleRow[] {
    return all<FilterRuleRow>("SELECT * FROM filter_rules ORDER BY id")
}

export function getFilterRule(id: number): FilterRuleRow | undefined {
    return get<FilterRuleRow>("SELECT * FROM filter_rules WHERE id = ?", id)
}

export function insertFilterRule(
    rule: Omit<FilterRuleRow, "id" | "hits" | "created_at">
): FilterRuleRow {
    run(
        `INSERT INTO filter_rules
            (kind, scope, sids, field, mode, pattern, action, enabled, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rule.kind,
        rule.scope,
        rule.sids,
        rule.field,
        rule.mode,
        rule.pattern,
        rule.action,
        rule.enabled,
        rule.note,
        Date.now()
    )
    const row = get<FilterRuleRow>(
        "SELECT * FROM filter_rules WHERE id = last_insert_rowid()"
    )
    if (!row) throw new Error("insertFilterRule produced no row")
    return row
}

// Patchable columns, fixed by whitelist: column names never come from the
// request body, so building the SET list dynamically is injection-safe.
const RULE_PATCH_COLUMNS: Record<string, string> = {
    scope: "scope",
    sids: "sids",
    field: "field",
    mode: "mode",
    pattern: "pattern",
    action: "action",
    enabled: "enabled",
    note: "note",
}

export function updateFilterRule(
    id: number,
    patch: Partial<FilterRuleRow>
): FilterRuleRow | null {
    const entries = Object.entries(patch).filter(
        ([key, value]) => key in RULE_PATCH_COLUMNS && value !== undefined
    )
    if (entries.length > 0) {
        const sets = entries
            .map(([key]) => `${RULE_PATCH_COLUMNS[key]} = ?`)
            .join(", ")
        run(
            `UPDATE filter_rules SET ${sets} WHERE id = ?`,
            ...entries.map(([, value]) => value),
            id
        )
    }
    return getFilterRule(id) ?? null
}

export function deleteFilterRule(id: number): boolean {
    const result = run("DELETE FROM filter_rules WHERE id = ?", id)
    return Number(result.changes) > 0
}

export function addRuleHits(hits: Map<number, number>): void {
    for (const [id, count] of hits) {
        run("UPDATE filter_rules SET hits = hits + ? WHERE id = ?", count, id)
    }
}

export function closeDb() {
    prepared.clear()
    db?.close()
}
