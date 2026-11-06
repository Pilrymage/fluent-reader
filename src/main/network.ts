import { ipcMain, session } from "electron"
import { ProxyMode, SyncService } from "../schema-types"
import {
    classifyError,
    redactText,
    sanitizeEndpoint,
    extractErrorCode,
} from "../scripts/models/net/diagnostics"
import { appendDiagnostic } from "./diagnostics"

export type { ProxyMode }

export type ProxyRules =
    | { mode: "system" }
    | { mode: "direct" }
    | { mode: "pac_script"; pacScript: string }

export interface StoreLike {
    get(key: string, defaultValue?: unknown): unknown
    set(key: string, value: unknown): void
}

export interface ProxySession {
    setProxy(rules: ProxyRules): Promise<void> | void
    resolveProxy(url: string): Promise<string> | string
    fetch?: typeof fetch
}

export interface NetworkSessions {
    defaultSession: ProxySession
    sandboxSession: ProxySession
}

export interface NetworkDeps {
    getStore(): StoreLike
    sessions?: NetworkSessions
}

export interface DiagnoseDeps extends NetworkDeps {
    fetchImpl?: typeof fetch
    now?: () => number
    timeoutMs?: number
}

export interface DiagnosePayload {
    endpoint: string
    apiKey?: string
    username?: string
}

export interface RouteState {
    mode: ProxyMode
    routes: { default: string; sandbox: string }
}

export interface DiagnosisResult {
    ok: boolean
    status?: number
    auth?: number
    errorKind?: string
    errorCode?: string
    cause?: string
    durationMs: number
    endpoint: string
    proxyRoute: string
}

const PROXY_READBACK_URL = "https://example.com/"
const DIAGNOSE_TIMEOUT_MS = 8000
const SUPPORTED_PROTOCOLS = ["http:", "https:"]
const PROXY_MODES: ProxyMode[] = ["system", "direct", "pac"]

export function isProxyMode(value: unknown): value is ProxyMode {
    return typeof value === "string" && PROXY_MODES.includes(value as ProxyMode)
}

export function getProxyMode(store: StoreLike): ProxyMode {
    const explicit = store.get("proxyMode", undefined)
    if (isProxyMode(explicit)) return explicit
    return store.get("pacOn", false) ? "pac" : "system"
}

export function proxyRulesFor(mode: ProxyMode, pac: string): ProxyRules {
    switch (mode) {
        case "direct":
            return { mode: "direct" }
        case "pac":
            return { mode: "pac_script", pacScript: pac || "" }
        default:
            return { mode: "system" }
    }
}

export function getElectronSessions(): NetworkSessions {
    return {
        defaultSession: session.defaultSession,
        sandboxSession: session.fromPartition("sandbox"),
    }
}

async function resolveRoutes(
    sessions: NetworkSessions,
    targetUrl?: string
): Promise<{ default: string; sandbox: string }> {
    const target =
        typeof targetUrl === "string" && targetUrl.trim()
            ? targetUrl
            : PROXY_READBACK_URL
    const [defaultRoute, sandboxRoute] = await Promise.all([
        Promise.resolve(sessions.defaultSession.resolveProxy(target)),
        Promise.resolve(sessions.sandboxSession.resolveProxy(target)),
    ])
    return { default: redactText(defaultRoute, 400), sandbox: redactText(sandboxRoute, 400) }
}

/**
 * Apply the proxy mode to both the default and sandbox sessions. The returned
 * routes are the actual routes resolved for `targetUrl` (or a harmless default
 * when the caller cannot supply one). Both setProxy promises must settle before
 * any route is resolved, so a request issued afterwards uses the new route.
 */
export async function applyProxyMode(
    mode: ProxyMode,
    deps: NetworkDeps,
    targetUrl?: string
): Promise<RouteState> {
    const store = deps.getStore()
    const sessions = deps.sessions || getElectronSessions()
    const pac = String(store.get("pac", "") || "").trim()
    if (mode === "pac" && !pac) throw new Error("PAC script is required; set its address in App preferences")
    const rules = proxyRulesFor(mode, pac)
    await Promise.all([
        Promise.resolve(sessions.defaultSession.setProxy(rules)),
        Promise.resolve(sessions.sandboxSession.setProxy(rules)),
    ])
    const routes = await resolveRoutes(sessions, targetUrl)
    return { mode, routes }
}

export async function getNetworkState(deps: NetworkDeps): Promise<RouteState> {
    const sessions = deps.sessions || getElectronSessions()
    const config = deps.getStore().get("serviceConfigs", {}) as { endpoint?: string }
    const mode = getProxyMode(deps.getStore())
    const routes = await resolveRoutes(sessions, config.endpoint)
    return { mode, routes }
}

function sessionFetcher(sessions: NetworkSessions): typeof fetch {
    // A global fetch bypasses session.setProxy, so the route shown to the user
    // would not be the one the request actually used. Production must go
    // through the Electron session.
    const defaultSession = sessions.defaultSession
    if (typeof defaultSession.fetch === "function") {
        return defaultSession.fetch.bind(defaultSession)
    }
    return fetch
}

function endpointOrigin(raw: string): string | undefined {
    try {
        return new URL(raw).origin
    } catch {
        return undefined
    }
}

function unsupportedProtocol(raw: string): string | undefined {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return "Invalid endpoint URL"
    }
    if (!SUPPORTED_PROTOCOLS.includes(url.protocol)) {
        return `Unsupported endpoint protocol: ${url.protocol}`
    }
    if (!url.hostname) return "Invalid endpoint URL"
    return undefined
}

function appendApiFlag(raw: string): string {
    return raw.includes("?") ? raw + "&api" : raw + "?api"
}

function explicitAuthError(data: any): string {
    const candidate =
        typeof data?.error === "string"
            ? data.error
            : typeof data?.error_message === "string"
            ? data.error_message
            : typeof data?.errorMessage === "string"
            ? data.errorMessage
            : ""
    return candidate.trim() ? redactText(candidate.trim(), 200) : ""
}

function safeFailureCause(errorKind: string, err: any): string {
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

interface ResolvedEndpoint {
    raw: string
    apiKey: string
}

function failure(
    errorKind: string,
    cause: string,
    extra: Partial<DiagnosisResult> = {}
): DiagnosisResult {
    return {
        ok: false,
        errorKind,
        cause,
        durationMs: 0,
        endpoint: "",
        proxyRoute: "",
        ...extra,
    }
}

function resolveEndpoint(
    store: StoreLike,
    payload?: DiagnosePayload
): ResolvedEndpoint | DiagnosisResult {
    if (payload && typeof payload === "object") {
        const raw =
            typeof payload.endpoint === "string" ? payload.endpoint.trim() : ""
        if (!raw) return failure("unknown", "Endpoint is required")
        return {
            raw,
            apiKey: typeof payload.apiKey === "string" ? payload.apiKey : "",
        }
    }
    const configs = (store.get("serviceConfigs", { type: SyncService.None }) ||
        {}) as {
        type?: number
        endpoint?: string
        apiKey?: string
    }
    if (configs.type !== SyncService.Fever) {
        return failure("unknown", "Fever service is not configured")
    }
    const raw =
        typeof configs.endpoint === "string" ? configs.endpoint.trim() : ""
    if (!raw) return failure("unknown", "Fever service is not configured")
    return {
        raw,
        apiKey: typeof configs.apiKey === "string" ? configs.apiKey : "",
    }
}

export async function diagnoseEndpoint(
    deps: DiagnoseDeps,
    payload?: DiagnosePayload
): Promise<DiagnosisResult> {
    const store = deps.getStore()
    const resolved = resolveEndpoint(store, payload)
    if (!("raw" in resolved)) return resolved
    const { raw, apiKey } = resolved
    const endpoint = sanitizeEndpoint(raw)

    const protocolCause = unsupportedProtocol(raw)
    if (protocolCause) {
        return failure("unknown", protocolCause, { endpoint })
    }

    const target = endpointOrigin(raw) || raw
    const sessions = deps.sessions || getElectronSessions()
    let proxyRoute = ""
    try {
        // Apply the current effective mode first, then resolve the route for the
        // endpoint actually about to be contacted.
        const state = await applyProxyMode(getProxyMode(store), deps, target)
        proxyRoute = state.routes.default || ""
    } catch (err) {
        return failure("network", "Proxy configuration failed" + (extractErrorCode(err) ? ` (${extractErrorCode(err)})` : ""), { endpoint, errorCode: extractErrorCode(err) })
    }

    const fetcher = deps.fetchImpl || sessionFetcher(sessions)
    const now = deps.now || (() => Date.now())
    const started = now()
    const timeoutMs =
        Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
            ? deps.timeoutMs
            : DIAGNOSE_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
        response = await fetcher(appendApiFlag(raw), {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
            },
            body: `api_key=${apiKey}`,
            signal: controller.signal,
        })
    } catch (err) {
        clearTimeout(timer)
        const errorKind = controller.signal.aborted
            ? "timeout"
            : classifyError(err)
        return {
            ok: false,
            status:
                typeof (err as any)?.status === "number"
                    ? (err as any).status
                    : undefined,
            errorKind,
            cause: safeFailureCause(errorKind, err),
            errorCode: extractErrorCode(err),
            durationMs: now() - started,
            endpoint,
            proxyRoute,
        }
    }

    const status = response.status
    const isOk =
        typeof response.ok === "boolean"
            ? response.ok
            : status >= 200 && status < 300
    // Check the status BEFORE parsing the body: an empty 502 is an HTTP error,
    // never a JSON parse error.
    if (!isOk) {
        clearTimeout(timer)
        return {
            ok: false,
            status,
            errorKind: "http",
            cause: `HTTP ${status}`,
            durationMs: now() - started,
            endpoint,
            proxyRoute,
        }
    }

    let data: any
    try {
        data = await response.json()
    } catch (err) {
        clearTimeout(timer)
        if (controller.signal.aborted) {
            return {
                ok: false,
                status,
                errorKind: "timeout",
                cause: "Request timed out",
                durationMs: now() - started,
                endpoint,
                proxyRoute,
            }
        }
        const errorKind = classifyError(err) === "abort" ? "abort" : "json"
        return {
            ok: false,
            status,
            errorKind,
            cause: safeFailureCause(errorKind, err),
            errorCode: extractErrorCode(err),
            durationMs: now() - started,
            endpoint,
            proxyRoute,
        }
    }
    clearTimeout(timer)

    // Fever semantics: only auth === 1 is authenticated. HTTP reachability
    // (status) and authentication (auth) are reported independently.
    const auth = data?.auth
    if (auth === 1) {
        return {
            ok: true,
            status,
            auth: 1,
            durationMs: now() - started,
            endpoint,
            proxyRoute,
        }
    }
    let cause: string
    let authValue: number | undefined
    if (auth === 0) {
        authValue = 0
        cause = explicitAuthError(data) || "Credentials rejected (auth: 0)"
    } else if (data && typeof data === "object" && "auth" in data) {
        cause = explicitAuthError(data) || "Credentials rejected"
    } else {
        cause = "Missing auth field in service response"
    }
    return {
        ok: false,
        status,
        auth: authValue,
        errorKind: "auth",
        cause,
        durationMs: now() - started,
        endpoint,
        proxyRoute,
    }
}

export interface NetworkIpcDeps extends DiagnoseDeps {
    userData?: string
}

export function registerNetworkIpc(deps: NetworkIpcDeps): void {
    ipcMain.handle("network:get-state", () => getNetworkState(deps))
    ipcMain.handle("network:set-mode", async (_, mode: ProxyMode) => {
        if (!isProxyMode(mode)) {
            throw new Error("Invalid proxy mode")
        }
        const previous = getProxyMode(deps.getStore())
        try {
            const state = await applyProxyMode(mode, deps)
            deps.getStore().set("proxyMode", mode)
            return state
        } catch (err) {
            try { await applyProxyMode(previous, deps) } catch {}
            throw err
        }
    })
    ipcMain.handle("network:ensure-route", (_, targetUrl?: string) =>
        applyProxyMode(getProxyMode(deps.getStore()), deps, targetUrl)
    )
    ipcMain.handle(
        "network:diagnose-endpoint",
        async (_, payload?: DiagnosePayload) => {
            const result = await diagnoseEndpoint(deps, payload)
            try {
                appendDiagnostic({ ts: Date.now(), phase: "diagnosis", outcome: result.ok ? "ok" : "error", status: result.status, durationMs: result.durationMs, errorKind: result.errorKind as any, errorCode: result.errorCode, endpoint: result.endpoint, proxyRoute: result.proxyRoute }, { userData: deps.userData, getVerbose: () => Boolean(deps.getStore().get("networkDiagVerbose", false)) })
            } catch { /* A logging failure must not hide the diagnosis. */ }
            return result
        }
    )
}
