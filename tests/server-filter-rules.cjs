#!/usr/bin/env node
// Filter rules end to end, against the mutating Miniflux stub and the real
// API surface:
//  - validation rejects bogus rules before they reach the sweep,
//  - keyword and whole-feed rules mark exactly their matches,
//  - categories with no rules (and no auto-read) are never scanned,
//  - rule hit counters accumulate and survive idempotent sweeps,
//  - preview reports matches without marking anything,
//  - rules compose with READER_AUTO_READ_GROUPS whole-category sweeps.

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

async function importTs(relPath) {
    return import(pathToFileURL(path.join(ROOT, relPath)).href)
}

async function stubGet(base, query) {
    const response = await fetch(`${base}/v1/entries?${query}`, {
        headers: { "x-auth-token": "test-token" },
    })
    if (!response.ok) throw new Error(`${response.status} on ${query}`)
    return response.json()
}

function makeConfig(base) {
    return {
        backend: "miniflux",
        minifluxUrl: base,
        minifluxToken: "test-token",
        minifluxTimeoutMs: 5000,
        port: 0,
        host: "127.0.0.1",
        token: "test-api-token",
        dbFile: "",
        migrationsDir: "",
        webRoot: "",
        staticRoot: "",
        refreshIntervalMs: 60000,
        concurrency: 2,
        fetchTimeoutMs: 5000,
        corsOrigin: "*",
        autoReadGroups: [],
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
    const stubPort = await stubReady
    const stubBase = `http://127.0.0.1:${stubPort}`

    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "reader-rules-"))
    let passed = false
    try {
        const { openDb, closeDb } = await importTs("server/src/db.ts")
        openDb(
            path.join(dbDir, "reader.db"),
            path.join(ROOT, "dist", "drizzle")
        )
        let apiServer = null
        try {
            const { createBackend } = await importTs("server/src/backend.ts")
            const { createApiServer } = await importTs("server/src/api.ts")
            const config = makeConfig(stubBase)
            const backend = createBackend(config)
            const { server } = createApiServer(config, backend)
            apiServer = server
            const apiReady = new Promise(resolve => {
                server.listen(0, "127.0.0.1", () =>
                    resolve(server.address().port)
                )
            })
            const apiPort = await apiReady
            const api = `http://127.0.0.1:${apiPort}`
            const call = async (method, route, body) => {
                const response = await fetch(`${api}${route}`, {
                    method,
                    headers: {
                        "authorization": "Bearer test-api-token",
                        "content-type": "application/json",
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                })
                return { status: response.status, data: await response.json() }
            }

            // Sanity of the fixture: 中文 feed 1 holds the one unread entry
            // (101, title "First 文章"); 外文 feeds 2 and 3 hold the rest.
            let listing = await call("GET", "/api/filter/rules")
            assert(listing.status === 200, "GET rules failed")
            assert(
                Array.isArray(listing.data.rules) &&
                    listing.data.rules.length === 0,
                "expected no rules at start"
            )

            // Validation.
            let bad = await call("POST", "/api/filter/rules", {
                kind: "bogus",
                pattern: "x",
            })
            assert(bad.status === 400, "bogus kind accepted")
            bad = await call("POST", "/api/filter/rules", {
                kind: "keyword",
                mode: "regex",
                pattern: "(unclosed",
            })
            assert(bad.status === 400, "invalid regex accepted")
            bad = await call("POST", "/api/filter/rules", {
                kind: "feed",
                sids: [],
            })
            assert(bad.status === 400, "empty sids accepted")
            bad = await call("POST", "/api/filter/rules", {
                kind: "keyword",
                pattern: "",
            })
            assert(bad.status === 400, "empty pattern accepted")

            // Create one keyword rule and one whole-feed rule on feed 1.
            let created = await call("POST", "/api/filter/rules", {
                kind: "keyword",
                scope: "中文",
                field: "title",
                mode: "substr",
                pattern: "文章",
                note: "keyword rule",
            })
            assert(created.status === 200, "keyword rule not created")
            const keywordId = created.data.rule.id
            created = await call("POST", "/api/filter/rules", {
                kind: "feed",
                scope: "*",
                sids: [1],
                note: "feed rule",
            })
            assert(created.status === 200, "feed rule not created")
            const feedId = created.data.rule.id

            // Preview marks nothing and reports the would-be match.
            const preview = await call("POST", "/api/filter/preview", {
                kind: "keyword",
                scope: "中文",
                field: "title",
                mode: "substr",
                pattern: "文",
            })
            assert(preview.status === 200, "preview failed")
            assert(
                preview.data.scanned === 1,
                `preview scanned ${preview.data.scanned}`
            )
            assert(
                preview.data.matched === 1,
                `preview matched ${preview.data.matched}`
            )
            assert(
                preview.data.samples[0].title === "First 文章",
                `preview sample wrong: ${JSON.stringify(preview.data.samples)}`
            )
            const afterPreview = await stubGet(
                stubBase,
                "feed_id=1&status=unread&limit=100"
            )
            assert(
                afterPreview.entries.length === 1,
                "preview must not mark anything"
            )

            // The sweep marks exactly the rule matches; untouched categories
            // (外文: no rules, not auto-read) are not scanned at all.
            let result = await backend.autoRead()
            assert(result.entries === 1, `sweep marked ${result.entries}`)
            let feed1 = await stubGet(
                stubBase,
                "feed_id=1&status=unread&limit=100"
            )
            assert(feed1.entries.length === 0, "feed 1 not drained")
            let feed2 = await stubGet(
                stubBase,
                "feed_id=2&status=unread&limit=100"
            )
            assert(feed2.entries.length === 1, "feed 2 should be untouched")
            let feed3 = await stubGet(
                stubBase,
                "feed_id=3&status=unread&limit=100"
            )
            assert(
                feed3.total === 250,
                `feed 3 should keep its backlog, has ${feed3.total}`
            )

            // Both rules matched the same entry: hits count per rule.
            listing = await call("GET", "/api/filter/rules")
            const byId = Object.fromEntries(
                listing.data.rules.map(rule => [rule.id, rule])
            )
            assert(byId[keywordId].hits === 1, "keyword rule hits wrong")
            assert(byId[feedId].hits === 1, "feed rule hits wrong")
            assert(byId[keywordId].enabled === true, "rule should be enabled")

            // Idempotent sweep: nothing new, counters unchanged.
            result = await backend.autoRead()
            assert(
                result.entries === 0,
                `second sweep marked ${result.entries}`
            )
            listing = await call("GET", "/api/filter/rules")
            assert(
                listing.data.rules.find(rule => rule.id === keywordId).hits ===
                    1,
                "hits changed on an empty sweep"
            )

            // Disable one rule, delete the other: 中文 loses its applicable
            // rules and is skipped again.
            let updated = await call("POST", `/api/filter/rules/${keywordId}`, {
                enabled: false,
            })
            assert(
                updated.status === 200 && updated.data.rule.enabled === false,
                "disable failed"
            )
            const deleted = await call("DELETE", `/api/filter/rules/${feedId}`)
            assert(deleted.status === 200, "delete failed")
            const gone = await call("POST", `/api/filter/rules/${feedId}`, {
                enabled: true,
            })
            assert(gone.status === 404, "deleted rule still patchable")

            // Composition: whole-category auto-read coexists with rules.
            const { createBackend: createBackendAgain } = await importTs(
                "server/src/backend.ts"
            )
            const wholeBackend = createBackendAgain({
                ...config,
                autoReadGroups: ["外文"],
            })
            result = await wholeBackend.autoRead()
            assert(
                result.entries === 251,
                `whole sweep marked ${result.entries}`
            )
            feed2 = await stubGet(stubBase, "feed_id=2&status=unread&limit=100")
            feed3 = await stubGet(stubBase, "feed_id=3&status=unread&limit=100")
            assert(
                feed2.entries.length === 0 && feed3.entries.length === 0,
                "外文 not fully drained by whole-category sweep"
            )

            console.log("PASS server-filter-rules")
            passed = true
        } finally {
            // The api server keeps the event loop alive; a passing test must
            // still be able to exit.
            apiServer?.close()
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
