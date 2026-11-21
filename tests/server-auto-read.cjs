#!/usr/bin/env node
// Category auto-read filter, exercised against the mutating Miniflux stub:
// the sweep must drain every unread entry of the listed categories (spanning
// pages), leave other categories untouched, be idempotent, and do nothing when
// no categories are configured. Also proves markSourcesRead now drains a
// backlog larger than one page — the defect that used to leave 200+ unread
// behind after a group "mark all read".

const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const ROOT = path.resolve(__dirname, "..")

function fail(message) {
    console.error(`FAIL ${message}`)
    process.exit(1)
}

function assert(condition, message) {
    if (!condition) fail(message)
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: { "x-auth-token": "test-token" },
    })
    if (!response.ok) throw new Error(`${response.status} on ${url}`)
    return response.json()
}

async function importTs(relPath) {
    return import(pathToFileURL(path.join(ROOT, relPath)).href)
}

function makeBackendConfig(overrides) {
    return {
        backend: "miniflux",
        minifluxUrl: "http://127.0.0.1:1",
        minifluxToken: "test-token",
        minifluxTimeoutMs: 5000,
        port: 0,
        host: "127.0.0.1",
        token: "test",
        dbFile: "",
        migrationsDir: "",
        webRoot: "",
        staticRoot: "",
        refreshIntervalMs: 60000,
        concurrency: 2,
        fetchTimeoutMs: 5000,
        corsOrigin: "*",
        autoReadGroups: ["外文"],
        ...overrides,
    }
}

async function main() {
    const stub = spawn(
        process.execPath,
        [path.join(ROOT, "server", "test", "stub-miniflux.ts")],
        { stdio: ["ignore", "pipe", "pipe"] }
    )
    const stubReady = new Promise((resolve, reject) => {
        stub.stdout.on("data", chunk => {
            const match = /stub miniflux on (\d+)/.exec(String(chunk))
            if (match) resolve(Number(match[1]))
        })
        stub.stderr.on("data", chunk => process.stderr.write(`[stub] ${chunk}`))
        stub.on("exit", () => reject(new Error("stub exited before ready")))
        setTimeout(
            () => reject(new Error("stub did not report ready in 15s")),
            15000
        )
    })
    const port = await stubReady
    const base = `http://127.0.0.1:${port}`

    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "reader-auto-read-"))
    let passed = false
    try {
        const { openDb, closeDb } = await importTs("server/src/db.ts")
        openDb(
            path.join(dbDir, "reader.db"),
            path.join(ROOT, "dist", "drizzle")
        )
        try {
            const { createBackend } = await importTs("server/src/backend.ts")
            const config = makeBackendConfig({ minifluxUrl: base })
            const backend = createBackend(config)

            // Groups fold Miniflux categories: 中文 keeps feed 1, 外文 holds
            // feeds 2 and 3.
            const groups = await backend.groups()
            assert(
                groups.length === 2,
                `expected 2 groups, got ${groups.length}`
            )
            const byName = Object.fromEntries(groups.map(g => [g.name, g]))
            assert(
                JSON.stringify(byName["中文"].sids) === "[1]",
                `中文 sids: ${JSON.stringify(byName["中文"].sids)}`
            )
            assert(
                JSON.stringify(byName["外文"].sids) === "[2,3]",
                `外文 sids: ${JSON.stringify(byName["外文"].sids)}`
            )

            // A one-shot markSourcesRead must drain feed 3's 250-entry
            // backlog across pages (the old code stopped after one page).
            await backend.markSourcesRead([3])
            const feed3 = await fetchJson(
                `${base}/v1/entries?feed_id=3&status=unread&limit=100`
            )
            assert(
                feed3.entries.length === 0,
                `feed 3 still has ${feed3.entries.length} unread after drain`
            )
            const feed2 = await fetchJson(
                `${base}/v1/entries?feed_id=2&status=unread&limit=100`
            )
            assert(
                feed2.entries.length === 1,
                `feed 2 unread count changed: ${feed2.entries.length}`
            )

            // The auto-read sweep covers the remaining 外文 feed only.
            const result = await backend.autoRead()
            assert(
                result.groups === 1,
                `autoRead groups: ${JSON.stringify(result)}`
            )
            assert(
                result.entries === 1,
                `autoRead entries: ${JSON.stringify(result)}`
            )
            const feed1 = await fetchJson(
                `${base}/v1/entries?feed_id=1&status=unread&limit=100`
            )
            assert(
                feed1.entries.length === 1,
                "auto-read leaked into 中文 (feed 1)"
            )

            // Idempotent: a second sweep finds nothing and stays quiet.
            const again = await backend.autoRead()
            assert(again.entries === 0, `second sweep marked ${again.entries}`)

            // No configured categories: the sweep is a no-op and touches
            // nothing on the wire.
            const callsBefore = (await fetchJson(`${base}/__calls`)).length
            const idle = createBackend(
                makeBackendConfig({ minifluxUrl: base, autoReadGroups: [] })
            )
            const idleResult = await idle.autoRead()
            assert(
                idleResult.groups === 0 && idleResult.entries === 0,
                `empty-config sweep did something: ${JSON.stringify(
                    idleResult
                )}`
            )
            const callsAfter = (await fetchJson(`${base}/__calls`)).length
            assert(
                callsBefore === callsAfter,
                "empty-config sweep issued mutating calls"
            )

            // Every marked entry belongs to the 外文 feeds (2, 3); 中文's
            // entry 101 must never be marked.
            const calls = await fetchJson(`${base}/__calls`)
            const marked = new Set()
            for (const call of calls) {
                if (call.method !== "setStatus") continue
                if (call.body.status !== "read") continue
                for (const id of call.body.entry_ids) marked.add(id)
            }
            assert(marked.size === 251, `marked ${marked.size} entries`)
            assert(!marked.has(101), "entry 101 (中文) was marked read")

            console.log("PASS server-auto-read")
            passed = true
        } finally {
            closeDb()
        }
    } catch (err) {
        fail(err instanceof Error ? err.stack : String(err))
    } finally {
        stub.kill()
        fs.rmSync(dbDir, { recursive: true, force: true })
    }
    if (!passed) process.exit(1)
}

main()
