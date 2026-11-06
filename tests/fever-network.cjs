const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")

function transpile(file) {
    return ts.transpileModule(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
                esModuleInterop: true,
            },
        }
    ).outputText
}

function loadPure(file) {
    const module = { exports: {} }
    new Function("require", "module", "exports", transpile(file))(
        require,
        module,
        module.exports
    )
    return module.exports
}

const diagnostics = loadPure("src/scripts/models/net/diagnostics.ts")

class Source {
    constructor(url, name) {
        this.url = url
        this.name = name
    }
}

const domParser = {
    parseFromString: () => ({
        createElement: () => ({ setAttribute() {} }),
        head: { append() {} },
        querySelector: () => null,
        body: { querySelector: () => null },
    }),
}

const baseImports = {
    "react-intl-universal": { get: key => key },
    "../service": {},
    "../../../schema-types": { SyncService: { Fever: 1, None: 0 } },
    "../net/diagnostics": diagnostics,
    "../group": { createSourceGroup: name => ({ name }) },
    "../source": { RSSSource: Source },
    "../item": {},
    "../rule": {
        ArticleRule: { applyAll() {} },
        getRulesForTarget: () => [],
    },
    "../../utils": { htmlDecode: value => value, domParser },
    "../../db": { database: {}, itemsTable: {} },
    "./pending-read-states": {
        pendingReadStates: {
            use() {
                return this
            },
            set() {},
            confirm() {},
            track: promise => promise,
        },
    },
}

function loadFever({ fetchImpl, windowObj, imports = {} } = {}) {
    const module = { exports: {} }
    new Function(
        "require",
        "module",
        "exports",
        "fetch",
        "window",
        "AbortController",
        "setTimeout",
        "clearTimeout",
        "console",
        transpile("src/scripts/models/services/fever.ts")
    )(
        id => {
            if (Object.prototype.hasOwnProperty.call(imports, id)) {
                return imports[id]
            }
            if (Object.prototype.hasOwnProperty.call(baseImports, id)) {
                return baseImports[id]
            }
            return require(id)
        },
        module,
        module.exports,
        fetchImpl,
        windowObj,
        AbortController,
        setTimeout,
        clearTimeout,
        console
    )
    return module.exports
}

function loadMainNetwork(electron) {
    const module = { exports: {} }
    new Function(
        "require",
        "module",
        "exports",
        transpile("src/main/network.ts")
    )(
        id => {
            if (id === "./diagnostics") return { appendDiagnostic() {} }
            if (id === "electron") return electron
            if (id === "../schema-types") {
                return { SyncService: { None: 0, Fever: 1 } }
            }
            if (id === "../scripts/models/net/diagnostics") {
                return diagnostics
            }
            return require(id)
        },
        module,
        module.exports
    )
    return module.exports
}

function configs(endpoint, extra = {}) {
    return {
        type: 1,
        endpoint,
        username: "reader",
        apiKey: "APIKEY-SECRET",
        password: "PASSWORD-SECRET",
        fetchLimit: 1000,
        lastId: 0,
        timeoutMs: 150,
        ...extra,
    }
}

function startServer(handler) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler)
        server.on("error", reject)
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, port: server.address().port })
        })
    })
}

function stopServer(server) {
    return new Promise(resolve => {
        try {
            server.closeAllConnections?.()
        } catch {}
        server.close(() => resolve())
    })
}

function makeStore(values = {}) {
    const store = {
        values,
        getCalls: [],
        setCalls: [],
        get(key, defaultValue) {
            this.getCalls.push(key)
            return key in this.values ? this.values[key] : defaultValue
        },
        set(key, value) {
            this.setCalls.push([key, value])
            this.values[key] = value
        },
    }
    return store
}

function makeSessions(overrides = {}) {
    const resolved = []
    const fetched = []
    const sessions = {
        defaultSession: {
            async setProxy() {},
            async resolveProxy(url) {
                resolved.push(url)
                return "PROXY 127.0.0.1:7890"
            },
            async fetch(url) {
                fetched.push(url)
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ auth: 1 }),
                }
            },
            ...overrides.defaultSession,
        },
        sandboxSession: {
            async setProxy() {},
            async resolveProxy(url) {
                resolved.push(url)
                return "DIRECT"
            },
            ...overrides.sandboxSession,
        },
    }
    return { sessions, resolved, fetched }
}

const tests = []
function test(name, fn) {
    tests.push([name, fn])
}

test("HTTP 502 is a typed http error with status, not auth", async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(502, { "content-type": "text/html" })
        res.end("<html>bad gateway</html>")
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`)
        )
        assert.equal(result.ok, false)
        assert.equal(result.errorKind, "http")
        assert.equal(result.status, 502)
        assert.notEqual(result.errorKind, "auth")
        assert.ok(
            fever.getLastFeverAuthFailure().length > 0,
            "failure cause must be recorded"
        )
        const legacy = await fever.feverServiceHooks.authenticate(
            configs(`http://127.0.0.1:${port}/fever`)
        )
        assert.equal(legacy, false)
    } finally {
        await stopServer(server)
    }
})

test("HTTP 502 with an EMPTY body is http, never json", async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(502)
        res.end()
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`)
        )
        assert.equal(result.ok, false)
        assert.equal(result.errorKind, "http")
        assert.equal(result.status, 502)
    } finally {
        await stopServer(server)
    }
})

test("hanging server hits the deadline and reports timeout", async () => {
    const { server, port } = await startServer(() => {})
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const started = Date.now()
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`, { timeoutMs: 120 })
        )
        const elapsed = Date.now() - started
        assert.equal(result.ok, false)
        assert.equal(result.errorKind, "timeout")
        assert.ok(elapsed < 3000, "deadline must abort promptly, got " + elapsed)
    } finally {
        await stopServer(server)
    }
})

test("a deadline during the body read is timeout, never json", async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.flushHeaders()
        // Never end the body: response.json() must hang until the deadline.
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`, { timeoutMs: 150 })
        )
        assert.equal(result.ok, false)
        assert.equal(result.errorKind, "timeout")
    } finally {
        await stopServer(server)
    }
})

test("invalid JSON is typed as a json parse error", async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("this is not json")
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`)
        )
        assert.equal(result.ok, false)
        assert.equal(result.errorKind, "json")
    } finally {
        await stopServer(server)
    }
})

test("connection refused is a network error", async () => {
    const probe = await startServer((_, res) => res.end())
    const port = probe.port
    await stopServer(probe.server)
    const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
    const result = await fever.authenticateFever(
        configs(`http://127.0.0.1:${port}/fever`)
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, "network")
})

test("auth:1 is the only success", async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ auth: 1 }))
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`)
        )
        assert.equal(result.ok, true)
        assert.equal(result.auth, 1)
        assert.equal(result.status, 200)
        assert.equal(
            await fever.feverServiceHooks.authenticate(
                configs(`http://127.0.0.1:${port}/fever`)
            ),
            true
        )
        assert.equal(fever.getLastFeverAuthFailure(), "")
    } finally {
        await stopServer(server)
    }
})

test("auth:0 is an authentication FAILURE with status kept separate", async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ auth: 0 }))
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`)
        )
        assert.equal(result.ok, false)
        assert.equal(result.errorKind, "auth")
        assert.equal(result.status, 200)
        assert.equal(result.auth, 0)
        assert.ok(result.cause && result.cause.length > 0, "concrete cause")
        assert.equal(
            await fever.feverServiceHooks.authenticate(
                configs(`http://127.0.0.1:${port}/fever`)
            ),
            false
        )
        assert.ok(fever.getLastFeverAuthFailure().length > 0)
    } finally {
        await stopServer(server)
    }
})

test("a missing auth field is an authentication failure", async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "no auth here" }))
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`)
        )
        assert.equal(result.ok, false)
        assert.equal(result.errorKind, "auth")
        assert.equal(result.status, 200)
        assert.equal(result.auth, undefined)
        assert.match(result.cause, /missing auth/i)
    } finally {
        await stopServer(server)
    }
})

test("real auth failure surfaces a concrete cause", async () => {
    const { server, port } = await startServer((_, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ auth: false, error: "invalid credentials" }))
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj: undefined })
        const result = await fever.authenticateFever(
            configs(`http://127.0.0.1:${port}/fever`)
        )
        assert.equal(result.ok, false)
        assert.equal(result.errorKind, "auth")
        assert.equal(result.status, 200)
        assert.match(result.cause, /invalid credentials/)
        assert.match(fever.getLastFeverAuthFailure(), /invalid credentials/)
    } finally {
        await stopServer(server)
    }
})

test("production diagnose fetcher comes from the injected Electron session", async () => {
    const main = loadMainNetwork({
        ipcMain: { handle() {} },
        session: {
            defaultSession: {},
            fromPartition: () => ({}),
        },
        app: { getPath: () => process.cwd() },
    })
    const store = makeStore({})
    const { sessions, fetched } = makeSessions()
    const originalFetch = global.fetch
    global.fetch = () => {
        throw new Error("global fetch must never be used by diagnostics")
    }
    try {
        const result = await main.diagnoseEndpoint(
            { getStore: () => store, sessions, now: () => 1 },
            {
                endpoint: "http://127.0.0.1:4567/fever?token=SECRET",
                apiKey: "APIKEY-SECRET",
            }
        )
        assert.equal(result.ok, true)
        assert.equal(result.status, 200)
        assert.equal(result.auth, 1)
        assert.equal(fetched.length, 1)
        assert.match(fetched[0], /(\?|&)api\b/)
    } finally {
        global.fetch = originalFetch
    }
})

test("diagnose resolves the route for the actual endpoint origin, not example.com", async () => {
    const main = loadMainNetwork({
        ipcMain: { handle() {} },
        session: { defaultSession: {}, fromPartition: () => ({}) },
        app: { getPath: () => process.cwd() },
    })
    const store = makeStore({})
    const { sessions, resolved } = makeSessions()
    const result = await main.diagnoseEndpoint(
        { getStore: () => store, sessions, now: () => 5 },
        {
            endpoint: "http://127.0.0.1:4567/fever?token=SECRET",
            apiKey: "APIKEY-SECRET",
        }
    )
    assert.equal(result.ok, true)
    assert.equal(result.proxyRoute, "PROXY 127.0.0.1:7890")
    assert.ok(
        resolved.includes("http://127.0.0.1:4567"),
        "resolveProxy must receive the target origin: " + resolved.join(",")
    )
    assert.equal(
        resolved.some(url => url.includes("example.com")),
        false,
        "must not resolve example.com"
    )
    assert.equal(
        result.endpoint.includes("token"),
        false,
        "endpoint must strip the query string"
    )
})

test("diagnose accepts an unsaved transient payload without persisting", async () => {
    const main = loadMainNetwork({
        ipcMain: { handle() {} },
        session: { defaultSession: {}, fromPartition: () => ({}) },
        app: { getPath: () => process.cwd() },
    })
    const store = makeStore({})
    const { sessions } = makeSessions()
    const result = await main.diagnoseEndpoint(
        { getStore: () => store, sessions, now: () => 10 },
        {
            endpoint: "https://fever.invalid/fever",
            apiKey: "APIKEY-SECRET",
            username: "reader",
        }
    )
    assert.equal(result.ok, true)
    assert.equal(result.auth, 1)
    assert.equal(store.setCalls.length, 0, "must not write the store")
    assert.equal("serviceConfigs" in store.values, false)
})

test("diagnose rejects non-http(s) endpoints before any request", async () => {
    const main = loadMainNetwork({
        ipcMain: { handle() {} },
        session: { defaultSession: {}, fromPartition: () => ({}) },
        app: { getPath: () => process.cwd() },
    })
    const store = makeStore({})
    const { sessions, fetched, resolved } = makeSessions()
    const result = await main.diagnoseEndpoint(
        { getStore: () => store, sessions, now: () => 1 },
        { endpoint: "ftp://example.test/fever", apiKey: "KEY" }
    )
    assert.equal(result.ok, false)
    assert.match(result.cause, /protocol/i)
    assert.equal(fetched.length, 0)
    assert.equal(resolved.length, 0)
})

test("diagnose falls back to the stored Fever config", async () => {
    const main = loadMainNetwork({
        ipcMain: { handle() {} },
        session: { defaultSession: {}, fromPartition: () => ({}) },
        app: { getPath: () => process.cwd() },
    })
    const store = makeStore({
        serviceConfigs: {
            type: 1,
            endpoint: "http://127.0.0.1:4567/fever",
            apiKey: "APIKEY-SECRET",
        },
    })
    const { sessions } = makeSessions()
    const result = await main.diagnoseEndpoint({
        getStore: () => store,
        sessions,
        now: () => 10,
    })
    assert.equal(result.ok, true)
    assert.equal(result.auth, 1)
    assert.equal(result.endpoint, "http://127.0.0.1:4567/fever")
    assert.equal(store.setCalls.length, 0, "stored diagnose must be read-only")
})

test("diagnose keeps status and auth failure as separate fields", async () => {
    const main = loadMainNetwork({
        ipcMain: { handle() {} },
        session: { defaultSession: {}, fromPartition: () => ({}) },
        app: { getPath: () => process.cwd() },
    })
    const store = makeStore({})
    const { sessions } = makeSessions({
        defaultSession: {
            async fetch() {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ auth: 0 }),
                }
            },
        },
    })
    const result = await main.diagnoseEndpoint(
        { getStore: () => store, sessions, now: () => 1 },
        { endpoint: "http://127.0.0.1:4567/fever", apiKey: "KEY" }
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, "auth")
    assert.equal(result.status, 200)
    assert.equal(result.auth, 0)
    assert.ok(result.cause && result.cause.length > 0)
})

test("diagnostic events contain no apiKey, password, cookie, article or query token", async () => {
    const events = []
    const windowObj = {
        network: {
            ensureRoute: async () => ({
                mode: "direct",
                routes: { default: "DIRECT", sandbox: "DIRECT" },
            }),
            appendLog: event => events.push(event),
        },
    }
    const { server, port } = await startServer((_, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ auth: 0, html: "<p>SECRET-ARTICLE-BODY</p>" }))
    })
    try {
        const fever = loadFever({ fetchImpl: fetch, windowObj })
        await fever.authenticateFever(
            configs(
                `http://127.0.0.1:${port}/fever?token=SECRET-QUERY-TOKEN`
            )
        )
        const blob = JSON.stringify(events)
        for (const secret of [
            "APIKEY-SECRET",
            "PASSWORD-SECRET",
            "SECRET-QUERY-TOKEN",
            "SECRET-ARTICLE-BODY",
            "Cookie",
            "Authorization",
            "?api",
            "?token",
        ]) {
            assert.equal(blob.includes(secret), false, "leaked " + secret)
        }
        assert.ok(events.length > 0, "diagnostics must be emitted")
        const request = events.find(event => event.phase === "request")
        assert.ok(request, "request event missing")
        assert.match(
            request.endpoint,
            new RegExp("^http://127\\.0\\.0\\.1:" + port + "/fever$")
        )
    } finally {
        await stopServer(server)
    }
})

test("ensureRoute is awaited before fetch", async () => {
    const order = []
    const windowObj = {
        network: {
            ensureRoute: async () => {
                order.push("route")
                return { mode: "direct", routes: { default: "DIRECT" } }
            },
            appendLog: () => {},
        },
    }
    const fever = loadFever({
        windowObj,
        fetchImpl: async () => {
            order.push("fetch")
            return {
                ok: true,
                status: 200,
                json: async () => ({ auth: 1 }),
            }
        },
    })
    const result = await fever.authenticateFever(
        configs("http://127.0.0.1:1/fever")
    )
    assert.equal(result.ok, true)
    assert.deepEqual(order, ["route", "fetch"])
})

test("pagination counters are recorded without changing the cursor", async () => {
    const events = []
    const pageItems = (start, count) =>
        Array.from({ length: count }, (_, index) => ({
            id: start + index,
            feed_id: 1,
            title: "item " + (start + index),
            url: "https://example.test/item/" + (start + index),
            created_on_time: 1700000000,
            html: "<p>body</p>",
            author: "author",
            is_read: false,
            is_saved: false,
        }))
    const { server, port } = await startServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1")
        const maxId = Number(url.searchParams.get("max_id"))
        const items =
            maxId > 1000000 ? pageItems(100, 50) : pageItems(70, 30)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ items }))
    })
    try {
        const windowObj = {
            network: {
                ensureRoute: async () => ({
                    mode: "direct",
                    routes: { default: "DIRECT" },
                }),
                appendLog: event => events.push(event),
            },
        }
        const fever = loadFever({ fetchImpl: fetch, windowObj })
        const cfg = configs(`http://127.0.0.1:${port}/fever`)
        const state = {
            service: cfg,
            sources: { 0: { sid: 0, serviceRef: "1" } },
            rules: {},
            groups: {},
        }
        const dispatch = async action =>
            typeof action === "function" ? action(dispatch, () => state) : action
        const [, resultConfigs] = await fever.feverServiceHooks.fetchItems()(
            dispatch,
            () => state
        )
        const pages = events.filter(event => event.phase === "items")
        assert.deepEqual(
            pages.map(event => event.page),
            [1, 2]
        )
        assert.deepEqual(
            pages.map(event => event.count),
            [50, 30]
        )
        assert.equal(resultConfigs.lastId, 149)
        assert.equal(cfg.lastId, 149)
        assert.equal(JSON.stringify(events).includes("<p>body</p>"), false)
    } finally {
        await stopServer(server)
    }
})

;(async () => {
    for (const [name, fn] of tests) {
        await fn()
        console.log("PASS " + name)
    }
})().catch(err => {
    console.error(err)
    process.exit(1)
})
