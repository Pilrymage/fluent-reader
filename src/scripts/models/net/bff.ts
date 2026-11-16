// Client for the reader BFF. Only used by the browser build; the Electron build
// keeps talking to SQLite through window.db.
//
// There is no login step: Caddy's forward_auth rejects the request unless
// Authelia accepted the session, so every call below is already authenticated
// by the time the BFF sees it.

declare global {
    interface Window {
        __FR_WEB__?: boolean
    }
}

export function isWeb(): boolean {
    return Boolean(globalThis.__FR_WEB__)
}

export interface ApiSource {
    sid: number
    url: string
    name: string
    iconurl: string | null
    unreadCount: number
    lastFetched: number | null
    category: { id: number; title: string } | null
}

/** A Miniflux category, shaped the way the menu wants a source group. */
export interface ApiGroup {
    gid: number
    name: string
    sids: number[]
}

export interface ApiItem {
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

export interface ApiItemDetail extends ApiItem {
    content: string
}

export class ApiError extends Error {
    constructor(readonly status: number, path: string) {
        super(`${status} on ${path}`)
        this.name = "ApiError"
    }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        ...((init?.headers as Record<string, string>) ?? {}),
    }
    const response = await fetch(`/api${path}`, {
        ...init,
        headers,
        credentials: "same-origin",
    })
    // An expired SSO session is answered with a redirect to the login page, so
    // the status is 200 but the body is HTML. Treat anything that is not JSON as
    // "the gateway did not let us in" instead of a confusing parse error.
    if (response.redirected || !response.ok) {
        throw new ApiError(response.redirected ? 401 : response.status, path)
    }
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("application/json")) {
        throw new ApiError(401, path)
    }
    return (await response.json()) as T
}

export async function fetchSources(): Promise<{
    sources: ApiSource[]
    groups: ApiGroup[]
}> {
    const data = await call<{ sources: ApiSource[]; groups?: ApiGroup[] }>(
        "/sources"
    )
    return { sources: data.sources, groups: data.groups ?? [] }
}

export interface ItemQuery {
    source?: number
    unread?: boolean
    starred?: boolean
    search?: string
    limit?: number
    offset?: number
}

export function fetchItems(
    query: ItemQuery
): Promise<{ items: ApiItem[]; next: number | null }> {
    const params = new URLSearchParams()
    if (query.source !== undefined) params.set("source", String(query.source))
    if (query.unread) params.set("unread", "1")
    if (query.starred) params.set("starred", "1")
    if (query.search) params.set("search", query.search)
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    if (query.offset) params.set("offset", String(query.offset))
    return call(`/items?${params.toString()}`)
}

export function fetchItemDetail(id: number): Promise<ApiItemDetail> {
    return call(`/items/${id}`)
}

/** One request for a whole burst of marks. */
export function setReadBatch(ids: number[], value: boolean): Promise<unknown> {
    return call(`/items/read`, {
        method: "POST",
        body: JSON.stringify({ ids, value }),
    })
}

export function setStar(id: number, value: boolean): Promise<unknown> {
    return call(`/items/${id}/star`, {
        method: "POST",
        body: JSON.stringify({ value }),
    })
}

/** "Mark this group read" is one request, not one per source. */
export function markSourcesRead(sids: number[]): Promise<unknown> {
    return call(`/sources/read-all`, {
        method: "POST",
        body: JSON.stringify({ sids }),
    })
}
