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

function refresh() {
    backend.refresh().catch(err => console.error("[refresh] failed:", err))
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
        await backend.refresh()
        shutdown(0)
        return
    }

    if (skipInitial) {
        console.log("[server] initial refresh skipped")
    } else {
        refresh()
    }
    timer = setInterval(refresh, config.refreshIntervalMs)
})
