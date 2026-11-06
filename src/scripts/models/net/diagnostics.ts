export type ErrorKind =
    | "timeout"
    | "abort"
    | "network"
    | "http"
    | "json"
    | "auth"
    | "unknown"

export interface DiagEvent {
    ts?: number
    phase?: string
    outcome?: string
    durationMs?: number
    status?: number
    proxyRoute?: string
    page?: number
    count?: number
    errorKind?: ErrorKind
    errorCode?: string
    endpoint?: string
    detail?: string
    [key: string]: unknown
}

export interface SanitizedEvent {
    ts?: number
    phase?: string
    outcome?: string
    durationMs?: number
    status?: number
    proxyRoute?: string
    page?: number
    count?: number
    errorKind?: ErrorKind
    errorCode?: string
    endpoint?: string
    detail?: string
}

const VALID_ERROR_KINDS: ErrorKind[] = [
    "timeout",
    "abort",
    "network",
    "http",
    "json",
    "auth",
    "unknown",
]

const ALLOWED_EVENT_FIELDS = [
    "ts",
    "phase",
    "outcome",
    "durationMs",
    "status",
    "proxyRoute",
    "page",
    "count",
    "errorKind",
    "errorCode",
    "endpoint",
    "detail",
] as const

const NUMERIC_EVENT_FIELDS = new Set([
    "ts",
    "durationMs",
    "status",
    "page",
    "count",
])

export const DEFAULT_DETAIL_LIMIT = 200

export function sanitizeEndpoint(raw: unknown): string {
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) return ""
    try {
        const url = new URL(value)
        return url.origin + url.pathname
    } catch {
        return value
            .split("#")[0]
            .split("?")[0]
            .replace(/\/\/[^/@]*@/, "//")
    }
}

const SECRET_KEY =
    "access[_-]?token|refresh[_-]?token|x[-_]api[_-]?key|client[_-]?secret|api[_-]?key|password|passwd|pwd|cookie|set-cookie|authorization|token|secret"

const JSON_SECRET_PAIR = new RegExp(
    `("(?:${SECRET_KEY})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
    "gi"
)
const QUOTED_SECRET_PAIR = new RegExp(
    `\\b(${SECRET_KEY})\\s*[=:]\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`,
    "gi"
)
const UNQUOTED_SECRET_PAIR = new RegExp(
    `\\b(${SECRET_KEY})\\s*[=:]\\s*[^\\s&;,}]+`,
    "gi"
)
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi
const AUTHORIZATION_HEADER =
    /\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi
const BEARER_TOKEN = /\bbearer\s+[^\r\n,;]+/gi
const URL_QUERY = /\?[^\s"'<>)]*/g

const ERROR_CODE_PATTERN = /^net::ERR_[A-Z0-9_]+$/

export function isSafeErrorCode(value: unknown): value is string {
    return (
        typeof value === "string" &&
        !/\s/.test(value) &&
        ERROR_CODE_PATTERN.test(value)
    )
}

export function extractErrorCode(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined
    const record = err as Record<string, unknown>
    for (const field of ["errorCode", "code", "message"]) {
        const raw = record[field]
        if (typeof raw !== "string") continue
        const match = raw.match(/net::ERR_[A-Z0-9_]+/)
        if (match) return match[0]
    }
    return undefined
}

function redactOnce(value: string): string {
    return value
        .replace(JSON_SECRET_PAIR, '$1"[REDACTED]"')
        .replace(QUOTED_SECRET_PAIR, "$1=[REDACTED]")
        .replace(URL_USERINFO, "$1")
        .replace(/\b(PROXY|HTTPS?|SOCKS[45]?)\s+[^\s;@]+@/gi, "$1 ")
        .replace(AUTHORIZATION_HEADER, "$1: [REDACTED]")
        .replace(BEARER_TOKEN, "Bearer [REDACTED]")
        .replace(UNQUOTED_SECRET_PAIR, "$1=[REDACTED]")
        .replace(URL_QUERY, "")
}

export function redactText(
    text: unknown,
    limit = DEFAULT_DETAIL_LIMIT
): string {
    if (text === undefined || text === null) return ""
    // Two passes: removing an outer layer must never expose an inner value.
    let value = redactOnce(redactOnce(String(text)))
    if (limit > 0 && value.length > limit) value = value.slice(0, limit)
    return value
}

export function classifyError(err: unknown): ErrorKind {
    if (!err || typeof err !== "object") return "unknown"
    const error = err as {
        errorKind?: unknown
        name?: string
        code?: string
        status?: unknown
        authFailure?: boolean
    }
    if (
        typeof error.errorKind === "string" &&
        VALID_ERROR_KINDS.includes(error.errorKind as ErrorKind)
    ) {
        return error.errorKind as ErrorKind
    }
    const chromiumCode = extractErrorCode(error)
    if (chromiumCode) {
        return chromiumCode === "net::ERR_TIMED_OUT" ? "timeout" : "network"
    }
    if (
        error.name === "TimeoutError" ||
        error.code === "ETIMEDOUT" ||
        error.code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
        return "timeout"
    }
    if (error.name === "AbortError" || error.code === "ABORT_ERR") {
        return "abort"
    }
    if (typeof error.status === "number") return "http"
    if (error.name === "SyntaxError" || error.code === "JSON_PARSE") {
        return "json"
    }
    if (
        error.code === "ENOTFOUND" ||
        error.code === "EAI_AGAIN" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ECONNRESET" ||
        error.code === "ENETUNREACH" ||
        error.code === "EHOSTUNREACH" ||
        error.code === "EPIPE" ||
        error.code === "ERR_NETWORK"
    ) {
        return "network"
    }
    if (err instanceof TypeError) return "network"
    if (error.authFailure) return "auth"
    return "unknown"
}

export function sanitizeEvent(
    event: DiagEvent | SanitizedEvent
): SanitizedEvent {
    const source = event && typeof event === "object" ? event : {}
    const result: SanitizedEvent = {}
    for (const field of ALLOWED_EVENT_FIELDS) {
        const value = source[field]
        if (value === undefined || value === null) continue
        if (NUMERIC_EVENT_FIELDS.has(field)) {
            const numeric = Number(value)
            if (Number.isFinite(numeric)) {
                result[field] = numeric as never
            }
            continue
        }
        if (field === "endpoint") {
            result.endpoint = sanitizeEndpoint(value)
            continue
        }
        if (field === "detail") {
            result.detail = redactText(value, DEFAULT_DETAIL_LIMIT)
            continue
        }
        if (field === "errorKind") {
            const kind = String(value) as ErrorKind
            result.errorKind = VALID_ERROR_KINDS.includes(kind)
                ? kind
                : "unknown"
            continue
        }
        if (field === "errorCode") {
            if (isSafeErrorCode(value)) result.errorCode = value
            continue
        }
        ;(result as Record<string, unknown>)[field] = redactText(
            value,
            DEFAULT_DETAIL_LIMIT
        )
    }
    return result
}

export function formatSummaryLine(event: DiagEvent | SanitizedEvent): string {
    const sanitized = sanitizeEvent(event)
    const timestamp = new Date(sanitized.ts || Date.now()).toISOString()
    const parts = [
        timestamp,
        `[${sanitized.phase || "event"}]`,
        sanitized.outcome || "info",
    ]
    if (sanitized.status !== undefined) parts.push(`status=${sanitized.status}`)
    if (sanitized.errorKind) parts.push(`error=${sanitized.errorKind}`)
    if (sanitized.errorCode) parts.push(`errorCode=${sanitized.errorCode}`)
    if (sanitized.durationMs !== undefined) {
        parts.push(`durationMs=${sanitized.durationMs}`)
    }
    if (sanitized.proxyRoute) parts.push(`route=${sanitized.proxyRoute}`)
    if (sanitized.page !== undefined) parts.push(`page=${sanitized.page}`)
    if (sanitized.count !== undefined) parts.push(`count=${sanitized.count}`)
    if (sanitized.endpoint) parts.push(`endpoint=${sanitized.endpoint}`)
    return parts.join(" ")
}

export interface MemoryLog {
    add(event: DiagEvent): SanitizedEvent
    getEntries(): SanitizedEvent[]
    getLines(): string[]
    setVerbose(verbose: boolean): void
    getVerbose(): boolean
    clear(): void
    readonly maxEntries: number
}

export function createMemoryLog({
    maxEntries = 200,
    verbose = false,
}: {
    maxEntries?: number
    verbose?: boolean
} = {}): MemoryLog {
    let entries: SanitizedEvent[] = []
    let isVerbose = Boolean(verbose)
    return {
        add(event) {
            const sanitized = sanitizeEvent(event)
            if (!isVerbose) delete sanitized.detail
            entries.push(sanitized)
            if (entries.length > maxEntries) {
                entries.splice(0, entries.length - maxEntries)
            }
            return sanitized
        },
        getEntries() {
            return entries.map(entry => ({ ...entry }))
        },
        getLines() {
            return entries.map(entry =>
                isVerbose ? JSON.stringify(entry) : formatSummaryLine(entry)
            )
        },
        setVerbose(value) {
            isVerbose = Boolean(value)
        },
        getVerbose() {
            return isVerbose
        },
        clear() {
            entries = []
        },
        get maxEntries() {
            return maxEntries
        },
    }
}
