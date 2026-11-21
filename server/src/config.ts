import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type BackendKind = "miniflux" | "local"

export interface ServerConfig {
    backend: BackendKind
    minifluxUrl: string
    minifluxToken: string
    minifluxTimeoutMs: number
    port: number
    host: string
    token: string
    dbFile: string
    migrationsDir: string
    webRoot: string
    staticRoot: string
    refreshIntervalMs: number
    concurrency: number
    fetchTimeoutMs: number
    corsOrigin: string
    /** Miniflux category titles whose unread entries are always marked read
     *  (the category-level filter). Empty disables the sweep. */
    autoReadGroups: string[]
}

export const SERVER_ROOT = path.resolve(import.meta.dirname, "..")

/**
 * Writable state (SQLite, token, session secret) lives next to the database,
 * not next to the code: the deployment runs with ProtectSystem=full and the
 * code tree is root-owned, so writing into SERVER_ROOT would fail.
 */
function resolveDataDir(): string {
    if (process.env.READER_DATA_DIR) return process.env.READER_DATA_DIR
    if (process.env.READER_DB) return path.dirname(process.env.READER_DB)
    return path.join(SERVER_ROOT, "data")
}

export const DATA_DIR = resolveDataDir()

function numberFromEnv(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
}

function listFromEnv(name: string): string[] {
    const raw = process.env[name]
    if (!raw) return []
    return raw
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
}

/**
 * The token authenticates every /api request. It comes from the environment in
 * a container; without one, a random token is generated once and reused from
 * data/token so a restart does not invalidate the client.
 */
function resolveToken(): { token: string; generated: boolean } {
    if (process.env.READER_TOKEN) {
        return { token: process.env.READER_TOKEN, generated: false }
    }
    const tokenFile = path.join(DATA_DIR, "token")
    if (fs.existsSync(tokenFile)) {
        const existing = fs.readFileSync(tokenFile, "utf8").trim()
        if (existing) return { token: existing, generated: false }
    }
    const token = randomBytes(24).toString("base64url")
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(tokenFile, token, { mode: 0o600 })
    return { token, generated: true }
}

export function loadConfig(): ServerConfig & { tokenGenerated: boolean } {
    const { token, generated } = resolveToken()
    const minifluxToken = process.env.MINIFLUX_TOKEN ?? ""
    const backend =
        (process.env.READER_BACKEND as BackendKind | undefined) ??
        (minifluxToken ? "miniflux" : "local")
    if (backend === "miniflux" && !minifluxToken) {
        throw new Error(
            "READER_BACKEND=miniflux requires MINIFLUX_TOKEN (Miniflux → Settings → API Keys)"
        )
    }
    return {
        backend,
        minifluxUrl: process.env.MINIFLUX_URL ?? "https://rss.pilrymage.com",
        minifluxToken,
        minifluxTimeoutMs: numberFromEnv("MINIFLUX_TIMEOUT_MS", 20000),
        port: numberFromEnv("READER_PORT", 7788),
        host: process.env.READER_HOST ?? "127.0.0.1",
        token,
        tokenGenerated: generated,
        dbFile: process.env.READER_DB ?? path.join(DATA_DIR, "reader.db"),
        migrationsDir:
            process.env.READER_MIGRATIONS ??
            path.resolve(SERVER_ROOT, "..", "dist", "drizzle"),
        webRoot:
            process.env.READER_WEB_ROOT ??
            path.resolve(SERVER_ROOT, "..", "dist-web"),
        staticRoot:
            process.env.READER_STATIC_ROOT ??
            path.resolve(SERVER_ROOT, "..", "dist"),
        refreshIntervalMs: numberFromEnv("READER_REFRESH_MINUTES", 30) * 60_000,
        concurrency: numberFromEnv("READER_CONCURRENCY", 4),
        fetchTimeoutMs: numberFromEnv("READER_TIMEOUT_MS", 20000),
        corsOrigin: process.env.READER_CORS_ORIGIN ?? "*",
        autoReadGroups: listFromEnv("READER_AUTO_READ_GROUPS"),
    }
}
