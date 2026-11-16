import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "./config.ts"
import { listSources, openDb, upsertSource } from "./db.ts"

/**
 * Copies the subscription list out of an existing Fluent Reader database so the
 * server can start fetching the same feeds itself. The source database is only
 * ever opened read-only.
 */
function defaultAppDb(): string {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), ".config")
    return path.join(appData, "fluent-reader-custom", "fluent-reader.db")
}

const appDbPath = process.argv[2] ?? defaultAppDb()
if (!fs.existsSync(appDbPath)) {
    console.error(`[seed] app database not found: ${appDbPath}`)
    process.exit(1)
}

const config = loadConfig()
openDb(config.dbFile, config.migrationsDir)

const appDb = new DatabaseSync(appDbPath, { readOnly: true })
const rows = appDb
    .prepare("SELECT sid, url, name, iconurl, hidden FROM sources ORDER BY sid")
    .all() as Array<{
    sid: number
    url: string
    name: string
    iconurl: string | null
    hidden: number
}>

let added = 0
for (const row of rows) {
    if (!row.url || !row.url.startsWith("http")) continue
    const before = listSources(true).length
    upsertSource({
        url: row.url,
        name: row.name || row.url,
        iconurl: row.iconurl,
        hidden: Boolean(row.hidden),
    })
    if (listSources(true).length > before) added += 1
}
appDb.close()

console.log(
    `[seed] read ${
        rows.length
    } sources from ${appDbPath}\n[seed] ${added} added, ${
        listSources(true).length
    } total in ${config.dbFile}`
)
