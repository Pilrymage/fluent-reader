import { loadConfig } from "./config.ts"
import { closeDb, openDb } from "./db.ts"
import { createBackend } from "./backend.ts"
import { createApiServer } from "./api.ts"

const config = loadConfig()
openDb(config.dbFile, config.migrationsDir)

const backend = createBackend(config)
const { server } = createApiServer(config, backend)
const refreshOnce = process.argv.includes("--refresh-once")
const skipInitial = process.argv.includes("--no-initial-refresh")
let timer: NodeJS.Timeout | null = null
let shuttingDown = false

function shutdown(code = 0) {
    if (shuttingDown) return
    shuttingDown = true
    if (timer) clearInterval(timer)
    server.close(() => {
        closeDb()
        process.exit(code)
    })
    // A hung socket must not keep the process alive.
    setTimeout(() => process.exit(code), 5000).unref()
}

async function refresh() {
    try {
        await backend.refresh()
    } catch (err) {
        console.error("[refresh] failed:", err)
    }
    // Miniflux fetches asynchronously after the nudge, so entries trickling
    // in behind the sweep are caught by the next one.
    try {
        await backend.autoRead?.()
    } catch (err) {
        console.error("[auto-read] failed:", err)
    }
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

server.listen(config.port, config.host, async () => {
    console.log(`[server] listening on http://${config.host}:${config.port}`)
    console.log(`[server] backend=${backend.kind} db=${config.dbFile}`)
    if (config.tokenGenerated) {
        console.log("[server] token generated and stored in data/token")
    }

    if (refreshOnce) {
        await refresh()
        shutdown(0)
        return
    }

    // The sweep is a data-state operation, not a fetch: it runs at startup
    // even when the initial Miniflux nudge is skipped.
    if (backend.autoRead && config.autoReadGroups.length > 0) {
        console.log(
            `[auto-read] categories: ${config.autoReadGroups.join(", ")}`
        )
        backend
            .autoRead()
            .catch(err => console.error("[auto-read] failed:", err))
    }

    if (skipInitial) {
        console.log("[server] initial refresh skipped")
    } else {
        refresh()
    }
    timer = setInterval(refresh, config.refreshIntervalMs)
})
