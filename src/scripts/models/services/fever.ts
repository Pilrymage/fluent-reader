import intl from "react-intl-universal"
import { database, itemsTable } from "../../db"
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm"
import { ServiceHooks } from "../service"
import { pendingReadStates } from "./pending-read-states"
import { ServiceConfigs, SyncService } from "../../../schema-types"
import { createSourceGroup } from "../group"
import { RSSSource } from "../source"
import { htmlDecode, domParser } from "../../utils"
import { RSSItem } from "../item"
import { ArticleRule, getRulesForTarget } from "../rule"
import {
    classifyError,
    DiagEvent,
    ErrorKind,
    redactText,
    sanitizeEndpoint,
    extractErrorCode,
} from "../net/diagnostics"

export interface FeverConfigs extends ServiceConfigs {
    type: SyncService.Fever
    endpoint: string
    username: string
    apiKey: string
    fetchLimit: number
    lastId?: number
    useInt32?: boolean
    timeoutMs?: number
}

interface NetworkBridge {
    ensureRoute?: (targetUrl?: string) => Promise<{ routes?: { default?: string } }>
    appendLog?: (event: DiagEvent) => unknown
}

function getNetworkBridge(): NetworkBridge | undefined {
    const root: any = typeof window !== "undefined" ? window : undefined
    return root && root.network ? root.network : undefined
}

function emitDiagnostic(event: DiagEvent) {
    try {
        const bridge = getNetworkBridge()
        if (!bridge?.appendLog) return
        void bridge.appendLog({
            ts: Date.now(),
            phase: event.phase,
            outcome: event.outcome,
            durationMs: event.durationMs,
            status: event.status,
            proxyRoute: event.proxyRoute
                ? redactText(event.proxyRoute, 200)
                : undefined,
            page: event.page,
            count: event.count,
            errorKind: event.errorKind,
            errorCode: event.errorCode,
            endpoint: event.endpoint
                ? sanitizeEndpoint(event.endpoint)
                : undefined,
            detail: event.detail ? redactText(event.detail, 200) : undefined,
        })
    } catch {
        // Diagnostics must never break syncing.
    }
}

async function ensureRoute(targetUrl: string): Promise<string | undefined> {
    const bridge = getNetworkBridge()
    if (!bridge?.ensureRoute) return undefined
    try {
        const state = await bridge.ensureRoute(targetUrl)
        return state?.routes?.default
    } catch {
        return undefined
    }
}

function requestError(kind: ErrorKind, message: string, status?: number) {
    const err = new Error(message) as Error & {
        errorKind?: ErrorKind
        status?: number
    }
    err.errorKind = kind
    if (status !== undefined) err.status = status
    return err
}

async function requestAPI(
    configs: FeverConfigs,
    params = "",
    postparams = ""
): Promise<{ data: any; status: number; proxyRoute?: string }> {
    const started = Date.now()
    const proxyRoute = await ensureRoute(configs.endpoint)
    const timeoutMs =
        Number.isFinite(configs.timeoutMs) && configs.timeoutMs > 0
            ? configs.timeoutMs
            : 15000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
        response = await fetch(configs.endpoint + "?api" + params, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `api_key=${configs.apiKey}${postparams}`,
            signal: controller.signal,
        })
    } catch (err) {
        clearTimeout(timer)
        const errorKind: ErrorKind = controller.signal.aborted
            ? "timeout"
            : classifyError(err)
        const message =
            errorKind === "timeout"
                ? "Request timed out"
                : errorKind === "network"
                ? "Network or DNS failure" + (extractErrorCode(err) ? ` (${extractErrorCode(err)})` : "")
                : "Request failed"
        emitDiagnostic({
            phase: "request",
            outcome: "error",
            errorKind,
            durationMs: Date.now() - started,
            endpoint: configs.endpoint,
            proxyRoute,
            detail: message,
            errorCode: extractErrorCode(err),
        })
        throw requestError(errorKind, message)
    }
    const status = response.status
    // Check the HTTP status before reading the body so an empty error response
    // stays an HTTP error rather than becoming a JSON parse error.
    if (!response.ok) {
        clearTimeout(timer)
        emitDiagnostic({
            phase: "request",
            outcome: "error",
            errorKind: "http",
            status,
            durationMs: Date.now() - started,
            endpoint: configs.endpoint,
            proxyRoute,
            detail: `HTTP ${status}`,
        })
        throw requestError("http", `HTTP ${status}`, status)
    }
    let data: any
    try {
        data = await response.json()
    } catch (err) {
        clearTimeout(timer)
        // A deadline firing while the body is being read is a timeout, not a
        // malformed JSON response.
        const errorKind: ErrorKind = controller.signal.aborted
            ? "timeout"
            : classifyError(err) === "abort"
            ? "abort"
            : "json"
        const message =
            errorKind === "timeout"
                ? "Request timed out"
                : errorKind === "abort"
                ? "Request aborted"
                : "Invalid JSON response"
        emitDiagnostic({
            phase: "request",
            outcome: "error",
            errorKind,
            status,
            durationMs: Date.now() - started,
            endpoint: configs.endpoint,
            proxyRoute,
            detail: message,
            errorCode: extractErrorCode(err),
        })
        throw requestError(errorKind, message, status)
    }
    clearTimeout(timer)
    emitDiagnostic({
        phase: "request",
        outcome: "ok",
        status,
        durationMs: Date.now() - started,
        endpoint: configs.endpoint,
        proxyRoute,
    })
    return { data, status, proxyRoute }
}

async function fetchAPI(configs: FeverConfigs, params = "", postparams = "") {
    return (await requestAPI(configs, params, postparams)).data
}

function explicitAuthCause(data: any): string {
    const candidate = data?.error ?? data?.error_message ?? data?.errorMessage
    if (typeof candidate === "string" && candidate.trim()) {
        return redactText(candidate.trim(), 200)
    }
    return ""
}

function safeErrorCause(errorKind: ErrorKind, err: any): string {
    switch (errorKind) {
        case "timeout":
            return "Request timed out"
        case "abort":
            return "Request aborted"
        case "network":
            return "Network or DNS failure" + (extractErrorCode(err) ? ` (${extractErrorCode(err)})` : "")
        case "http":
            return typeof err?.status === "number"
                ? `HTTP ${err.status}`
                : "HTTP error"
        case "json":
            return "Invalid JSON response"
        case "auth":
            return "Authentication failed"
        default:
            return "Request failed"
    }
}

let lastFeverAuthFailure = ""

export function getLastFeverAuthFailure(): string {
    return lastFeverAuthFailure
}

export async function authenticateFever(configs: FeverConfigs): Promise<{
    ok: boolean
    auth?: number
    status?: number
    errorKind?: ErrorKind
    cause?: string
}> {
    try {
        const { data, status } = await requestAPI(configs)
        const auth = data?.auth
        // Fever authenticates only when auth === 1. auth: 0 and a missing
        // auth field are authentication failures; the HTTP status stays a
        // separate field so "reached the endpoint" and "credentials accepted"
        // are never conflated.
        if (auth === 1) {
            lastFeverAuthFailure = ""
            return { ok: true, auth: 1, status }
        }
        let cause: string
        let authValue: number | undefined
        if (auth === 0) {
            authValue = 0
            cause = explicitAuthCause(data) || "Credentials rejected (auth: 0)"
        } else if (data && typeof data === "object" && "auth" in data) {
            cause = explicitAuthCause(data) || "Credentials rejected"
        } else {
            cause = "Missing auth field in service response"
        }
        lastFeverAuthFailure = cause
        emitDiagnostic({
            phase: "auth",
            outcome: "error",
            errorKind: "auth",
            status,
            endpoint: configs.endpoint,
            detail: cause,
        })
        return {
            ok: false,
            auth: authValue,
            status,
            errorKind: "auth",
            cause,
        }
    } catch (err) {
        const errorKind = classifyError(err)
        const cause = safeErrorCause(errorKind, err)
        lastFeverAuthFailure = cause
        return {
            ok: false,
            status:
                typeof (err as any)?.status === "number"
                    ? (err as any).status
                    : undefined,
            errorKind,
            cause,
        }
    }
}

// Throws when the service did not apply the change, so read states can be
// retried before a sync would revert them.
async function markItem(configs: FeverConfigs, item: RSSItem, as: string) {
    if (!item.serviceRef) return
    await postMark(configs, `&mark=item&as=${as}&id=${item.serviceRef}`)
}

async function postMark(configs: FeverConfigs, postparams: string) {
    try {
        const data = await fetchAPI(configs, "", postparams)
        // Fever answers rejected credentials with HTTP 200 and auth: 0.
        if (data?.auth === 0) {
            throw requestError("auth", "Credentials rejected (auth: 0)")
        }
    } catch (err) {
        // Never surface raw exception text, which can carry URLs or tokens.
        emitDiagnostic({
            phase: "mark",
            outcome: "error",
            errorKind: classifyError(err),
            endpoint: configs.endpoint,
        })
        throw err
    }
}

const MARK_CONCURRENCY = 6

// Runs the tasks a few at a time. Resolves false if any of them failed.
async function runLimited(tasks: (() => Promise<void>)[]): Promise<boolean> {
    let next = 0
    let ok = true
    const worker = async () => {
        while (next < tasks.length) {
            const task = tasks[next++]
            try {
                await task()
            } catch {
                ok = false
            }
        }
    }
    const workers = []
    for (let i = 0; i < Math.min(MARK_CONCURRENCY, tasks.length); i += 1) {
        workers.push(worker())
    }
    await Promise.all(workers)
    return ok
}

const APIError = () => new Error(intl.get("service.failure"))

function normalizeIconId(value: unknown): string | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? String(value) : undefined
    }
    if (typeof value === "string") {
        const trimmed = value.trim()
        return trimmed === "" ? undefined : trimmed
    }
    return undefined
}

const SAFE_ICON_MIME_TYPES = new Set([
    "png",
    "jpeg",
    "jpg",
    "gif",
    "webp",
    "bmp",
    "x-icon",
    "vnd.microsoft.icon",
    "avif",
    "tiff",
    "tif",
    "apng",
    // SVG inside an <img> data URI is not script-executable; the CSP img-src
    // data: rule is unchanged.
    "svg+xml",
])

function normalizeIconData(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined
    let value = raw.trim()
    if (!value) return undefined
    if (!/^data:/i.test(value)) value = "data:" + value
    const comma = value.indexOf(",")
    if (comma < 0) return undefined
    const meta = value.slice("data:".length, comma)
    const payload = value.slice(comma + 1).trim()
    if (!payload) return undefined
    const mime = meta.split(";")[0].trim().toLowerCase()
    if (!mime.startsWith("image/")) return undefined
    const subtype = mime.slice("image/".length)
    if (!SAFE_ICON_MIME_TYPES.has(subtype)) return undefined
    return value
}

export const feverServiceHooks: ServiceHooks = {
    authenticate: async (configs: FeverConfigs) => {
        return (await authenticateFever(configs)).ok
    },

    updateSources: () => async (dispatch, getState) => {
        const configs = getState().service as FeverConfigs
        const faviconStarted = Date.now()
        const [response, iconResult] = await Promise.all([
            fetchAPI(configs, "&feeds"),
            fetchAPI(configs, "&favicons").then(
                data => ({ ok: true as const, data }),
                error => ({ ok: false as const, error })
            ),
        ])
        const icons = new Map<string, string>()
        let faviconsSchemaError = false
        if (iconResult.ok) {
            const payload = iconResult.data
            const hasFaviconsKey =
                payload && typeof payload === "object" && "favicons" in payload
            const isFaviconsArray =
                payload &&
                typeof payload === "object" &&
                Array.isArray(payload.favicons)
            // A present-but-non-array favicons value is a schema error; a
            // missing key is simply an empty icon set.
            faviconsSchemaError = Boolean(hasFaviconsKey && !isFaviconsArray)
            const faviconList: any[] = isFaviconsArray ? payload.favicons : []
            for (const icon of faviconList) {
                if (!icon || typeof icon !== "object") continue
                if (typeof icon.data !== "string") continue
                const iconId = normalizeIconId(icon.id)
                if (iconId === undefined) continue
                const data = normalizeIconData(icon.data)
                if (data === undefined) continue
                icons.set(iconId, data)
            }
        }
        const feeds: any[] = response.feeds
        const feedGroups: any[] = response.feeds_groups
        const appliedIcons = Array.isArray(feeds)
            ? feeds.filter(f => {
                  const iconId = normalizeIconId(f?.favicon_id)
                  return iconId !== undefined && icons.has(iconId)
              }).length
            : 0
        if (iconResult.ok && faviconsSchemaError) {
            emitDiagnostic({
                phase: "favicons",
                outcome: "error",
                errorKind: "json",
                durationMs: Date.now() - faviconStarted,
                endpoint: configs.endpoint,
                detail: "favicons payload is not an array",
            })
        } else if (iconResult.ok) {
            emitDiagnostic({
                phase: "favicons",
                outcome: "ok",
                count: appliedIcons,
                durationMs: Date.now() - faviconStarted,
                endpoint: configs.endpoint,
            })
        } else if (iconResult.ok === false) {
            const errorKind = classifyError(iconResult.error)
            emitDiagnostic({
                phase: "favicons",
                outcome: "error",
                errorKind,
                status:
                    typeof (iconResult.error as any)?.status === "number"
                        ? (iconResult.error as any).status
                        : undefined,
                durationMs: Date.now() - faviconStarted,
                endpoint: configs.endpoint,
                detail: safeErrorCause(errorKind, iconResult.error),
            })
        }
        if (feeds === undefined) throw APIError()
        let groupsMap: Map<string, string>
        if (configs.importGroups) {
            // Import groups on the first sync
            const groups: any[] = (await fetchAPI(configs, "&groups")).groups
            if (groups === undefined || feedGroups === undefined)
                throw APIError()
            const groupsIdMap = new Map<number, string>()
            for (let group of groups) {
                const title = group.title.trim()
                dispatch(createSourceGroup(title))
                groupsIdMap.set(group.id, title)
            }
            groupsMap = new Map()
            for (let group of feedGroups) {
                for (let fid of group.feed_ids.split(",")) {
                    groupsMap.set(fid, groupsIdMap.get(group.group_id))
                }
            }
        }
        const sources = feeds.map(f => {
            const source = new RSSSource(f.url, f.title)
            source.serviceRef = String(f.id)
            const iconId = normalizeIconId(f.favicon_id)
            const icon = iconId === undefined ? undefined : icons.get(iconId)
            if (icon) source.iconurl = icon
            return source
        })
        return [sources, groupsMap]
    },

    fetchItems: () => async (_, getState) => {
        const state = getState()
        const configs = state.service as FeverConfigs
        const items = new Array()
        configs.lastId = configs.lastId || 0
        let min = configs.useInt32 ? 2147483647 : Number.MAX_SAFE_INTEGER
        let response
        let page = 0
        do {
            page += 1
            response = await fetchAPI(configs, `&items&max_id=${min}`)
            if (response.items === undefined) throw APIError()
            emitDiagnostic({
                phase: "items",
                outcome: "ok",
                page,
                count: response.items.length,
            })
            items.push(...response.items.filter(i => i.id > configs.lastId))
            if (
                response.items.length === 0 &&
                min === Number.MAX_SAFE_INTEGER
            ) {
                configs.useInt32 = true
                min = 2147483647
                response = undefined
            } else {
                min = response.items.reduce((m, n) => Math.min(m, n.id), min)
            }
        } while (
            min > configs.lastId &&
            (response === undefined || response.items.length >= 50) &&
            items.length < configs.fetchLimit
        )
        configs.lastId = items.reduce(
            (m, n) => Math.max(m, n.id),
            configs.lastId
        )
        if (items.length > 0) {
            const fidMap = new Map<string, RSSSource>()
            for (let source of Object.values(state.sources)) {
                if (source.serviceRef) {
                    fidMap.set(source.serviceRef, source)
                }
            }
            const parsedItems = items.map(i => {
                const source = fidMap.get(String(i.feed_id))
                const item = {
                    source: source.sid,
                    title: i.title,
                    link: i.url,
                    date: new Date(i.created_on_time * 1000),
                    fetchedDate: new Date(),
                    content: i.html,
                    snippet: htmlDecode(i.html).trim(),
                    creator: i.author,
                    hasRead: Boolean(i.is_read),
                    starred: Boolean(i.is_saved),
                    hidden: false,
                    notify: false,
                    serviceRef: String(i.id),
                } as RSSItem
                // Try to get the thumbnail of the item
                let dom = domParser.parseFromString(item.content, "text/html")
                let baseEl = dom.createElement("base")
                baseEl.setAttribute(
                    "href",
                    item.link.split("/").slice(0, 3).join("/")
                )
                dom.head.append(baseEl)
                let img = dom.querySelector("img")
                if (img && img.src) {
                    item.thumb = img.src
                } else if (configs.useInt32) {
                    // TTRSS Fever Plugin attachments
                    let a = dom.querySelector(
                        "body>ul>li:first-child>a"
                    ) as HTMLAnchorElement
                    if (a && /, image\/generic$/.test(a.innerText) && a.href)
                        item.thumb = a.href
                }
                // Rule writebacks are best effort and must not block fetching.
                ArticleRule.applyAll(
                    getRulesForTarget(state.rules, state.groups, {
                        type: "source",
                        sid: source.sid,
                    }),
                    item
                )
                if (Boolean(i.is_read) !== item.hasRead)
                    void markItem(
                        configs,
                        item,
                        item.hasRead ? "read" : "unread"
                    ).catch(() => {})
                if (Boolean(i.is_saved) !== Boolean(item.starred))
                    void markItem(
                        configs,
                        item,
                        item.starred ? "saved" : "unsaved"
                    ).catch(() => {})
                return item
            })
            return [parsedItems, configs]
        } else {
            return [[], configs]
        }
    },

    syncItems: () => async (_, getState) => {
        const configs = getState().service as FeverConfigs
        const [unreadResponse, starredResponse] = await Promise.all([
            fetchAPI(configs, "&unread_item_ids"),
            fetchAPI(configs, "&saved_item_ids"),
        ])
        if (
            typeof unreadResponse.unread_item_ids !== "string" ||
            typeof starredResponse.saved_item_ids !== "string"
        ) {
            throw APIError()
        }
        const unreadFids: string[] = unreadResponse.unread_item_ids.split(",")
        const starredFids: string[] = starredResponse.saved_item_ids.split(",")
        return [new Set(unreadFids), new Set(starredFids)]
    },

    // Returns once the affected items are recorded as pending. The requests run
    // in the background, and a sync waits for them before reading unread ids.
    markAllRead: (sids, date, before) => async (_, getState) => {
        const state = getState()
        const configs = state.service as FeverConfigs
        const conditions = [
            inArray(itemsTable.source, sids),
            eq(itemsTable.hasRead, false),
            isNotNull(itemsTable.serviceRef),
        ]
        if (date) {
            conditions.push(
                before ? lte(itemsTable.date, date) : gte(itemsTable.date, date)
            )
        }
        const rows = await database
            .select({
                serviceRef: itemsTable.serviceRef,
                source: itemsTable.source,
                date: itemsTable.date,
            })
            .from(itemsTable)
            .where(and(...conditions))
        const pending = pendingReadStates.use(configs)
        pending.set(
            rows.map(row => row.serviceRef),
            true
        )
        // Confirmed in one go so thousands of items are not saved one by one.
        const confirmed: string[] = []
        let tasks: (() => Promise<void>)[]
        if (date && !before) {
            // Fever can only mark items before a time, so mark newer ones
            // one by one, including rows that are not loaded in the list.
            tasks = rows.map(row => async () => {
                await markItem(configs, row as RSSItem, "read")
                confirmed.push(row.serviceRef)
            })
        } else {
            const timestamp =
                Math.floor((date ? date.getTime() : Date.now()) / 1000) + 1
            const rowsBySource = new Map<number, typeof rows>()
            for (const row of rows) {
                if (!rowsBySource.has(row.source))
                    rowsBySource.set(row.source, [])
                rowsBySource.get(row.source).push(row)
            }
            tasks = sids
                .map(sid => state.sources[sid])
                .filter(source => source && source.serviceRef)
                .map(source => async () => {
                    await postMark(
                        configs,
                        `&mark=feed&as=read&id=${source.serviceRef}&before=${timestamp}`
                    )
                    // Entries dated after the timestamp stay unread on the
                    // service; they remain pending and are retried one by one.
                    for (const row of rowsBySource.get(source.sid) || []) {
                        if (row.date.getTime() < timestamp * 1000) {
                            confirmed.push(row.serviceRef)
                        }
                    }
                })
        }
        void pending.track(
            runLimited(tasks).then(() => pending.confirm(confirmed, true))
        )
    },

    markRead: (item: RSSItem) => async (_, getState) => {
        await markItem(getState().service as FeverConfigs, item, "read")
    },

    markUnread: (item: RSSItem) => async (_, getState) => {
        await markItem(getState().service as FeverConfigs, item, "unread")
    },

    // Starring stays best effort: Miniflux toggles on both saved and unsaved,
    // so a blind retry could undo it.
    star: (item: RSSItem) => async (_, getState) => {
        await markItem(getState().service as FeverConfigs, item, "saved").catch(
            () => {}
        )
    },

    unstar: (item: RSSItem) => async (_, getState) => {
        await markItem(
            getState().service as FeverConfigs,
            item,
            "unsaved"
        ).catch(() => {})
    },
}
