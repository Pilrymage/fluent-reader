const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
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

function loadModule(file, imports = {}) {
    const module = { exports: {} }
    new Function("require", "module", "exports", transpile(file))(
        id => {
            if (Object.prototype.hasOwnProperty.call(imports, id)) {
                return imports[id]
            }
            return require(id)
        },
        module,
        module.exports
    )
    return module.exports
}

const pure = loadModule("src/scripts/models/net/diagnostics.ts")

const handlers = {}
const diagnosticsMain = loadModule("src/main/diagnostics.ts", {
    "node:fs": fs,
    "node:path": path,
    "../scripts/models/net/diagnostics": pure,
    electron: {
        ipcMain: {
            handle(channel, handler) {
                handlers[channel] = handler
            },
        },
        dialog: {},
        app: { getPath: () => os.tmpdir() },
    },
})

const tests = []
function test(name, fn) {
    tests.push([name, fn])
}

test("sanitizeEndpoint keeps origin and pathname only", () => {
    assert.equal(
        pure.sanitizeEndpoint(
            "http://user:pass@example.com:8080/fever/items?api&api_key=SECRET#frag"
        ),
        "http://example.com:8080/fever/items"
    )
    assert.equal(pure.sanitizeEndpoint("not-a-url/path?token=SECRET"), "not-a-url/path")
})

test("redactText strips query strings, credentials, auth headers and bearers", () => {
    const text =
        "GET https://example.com/fever?api_key=SECRET&password=PASS " +
        "Authorization: Bearer TOK123 Cookie: sid=COOKIEVALUE " +
        "body api_key=BODYSECRET&password=BODYPASS"
    const redacted = pure.redactText(text, 500)
    for (const secret of [
        "SECRET",
        "PASS",
        "TOK123",
        "COOKIEVALUE",
        "BODYSECRET",
        "BODYPASS",
        "?api_key",
    ]) {
        assert.equal(redacted.includes(secret), false, "leaked " + secret)
    }
    assert.ok(pure.redactText("x".repeat(500), 50).length <= 50)
})

test("classifyError distinguishes timeout, abort, network, http, json and auth", () => {
    assert.equal(pure.classifyError({ name: "TimeoutError" }), "timeout")
    assert.equal(pure.classifyError({ name: "AbortError" }), "abort")
    assert.equal(pure.classifyError({ code: "ETIMEDOUT" }), "timeout")
    assert.equal(pure.classifyError({ status: 502 }), "http")
    assert.equal(pure.classifyError(new SyntaxError("bad json")), "json")
    assert.equal(pure.classifyError({ code: "ECONNREFUSED" }), "network")
    assert.equal(pure.classifyError(new TypeError("fetch failed")), "network")
    assert.equal(pure.classifyError({ authFailure: true }), "auth")
    assert.equal(pure.classifyError({}), "unknown")
})

test("sanitizeEvent applies the allowlist and redacts detail", () => {
    const event = {
        ts: 1700000000000,
        phase: "request",
        outcome: "error",
        durationMs: 12,
        status: 502,
        proxyRoute: "PROXY 127.0.0.1:7890",
        page: 2,
        count: 50,
        errorKind: "http",
        endpoint:
            "https://user:pass@example.com/fever?api_key=SECRET#fragment",
        detail: "api_key=SECRET&password=PASS",
        apiKey: "APIKEY-SECRET",
        content: "<p>article body</p>",
        cookies: "sid=COOKIE",
        requestBody: "api_key=SECRET",
    }
    const sanitized = pure.sanitizeEvent(event)
    assert.deepEqual(Object.keys(sanitized).sort(), [
        "count",
        "detail",
        "durationMs",
        "endpoint",
        "errorKind",
        "outcome",
        "page",
        "phase",
        "proxyRoute",
        "status",
        "ts",
    ])
    assert.equal(sanitized.endpoint, "https://example.com/fever")
    assert.equal(sanitized.detail.includes("SECRET"), false)
    assert.equal(sanitized.detail.includes("PASS"), false)
    const blob = JSON.stringify(sanitized)
    for (const secret of [
        "APIKEY-SECRET",
        "article body",
        "sid=COOKIE",
        "api_key=SECRET",
        "?api_key",
    ]) {
        assert.equal(blob.includes(secret), false, "leaked " + secret)
    }
})

test("formatSummaryLine stays synchronous and detail-free", () => {
    const line = pure.formatSummaryLine({
        ts: 1700000000000,
        phase: "request",
        outcome: "error",
        status: 502,
        errorKind: "http",
        durationMs: 12,
        detail: "api_key=SECRET",
    })
    assert.match(line, /status=502/)
    assert.match(line, /error=http/)
    assert.equal(line.includes("SECRET"), false)
    assert.equal(line.includes("detail"), false)
})

test("memory log records summaries by default and detail only when verbose", () => {
    const log = pure.createMemoryLog({ maxEntries: 2 })
    log.add({ phase: "a", outcome: "ok", detail: "api_key=SECRET" })
    let entries = log.getEntries()
    assert.equal(entries.length, 1)
    assert.equal("detail" in entries[0], false)
    assert.equal(log.getLines()[0].includes("SECRET"), false)
    log.setVerbose(true)
    log.add({ phase: "b", outcome: "error", errorKind: "http", detail: "api_key=SECRET" })
    entries = log.getEntries()
    assert.equal(entries.length, 2)
    assert.ok("detail" in entries[1])
    assert.equal(log.getLines()[1].includes("SECRET"), false)
    log.add({ phase: "c" })
    assert.equal(log.getEntries().length, 2)
    assert.deepEqual(
        log.getEntries().map(entry => entry.phase),
        ["b", "c"]
    )
})

test("export cancel writes nothing and resolves canceled without throwing", async () => {
    let writes = 0
    const guardedFs = {
        ...fs,
        writeFileSync() {
            writes += 1
            throw new Error("must not write on cancel")
        },
    }
    const result = await diagnosticsMain.exportDiagnosticsFile({
        fs: guardedFs,
        path,
        logPath: path.join(os.tmpdir(), "unused-network-diagnostics.log"),
        dialog: { showSaveDialog: async () => ({ canceled: true }) },
    })
    assert.deepEqual(result, { canceled: true })
    assert.equal(writes, 0)
})

test("export writes redacted content on confirm", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-diag-"))
    try {
        const logPath = path.join(dir, "logs", "network-diagnostics.log")
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, "line api_key=SECRET ok\nphase=request\n")
        const exportPath = path.join(dir, "export.log")
        const result = await diagnosticsMain.exportDiagnosticsFile({
            fs,
            path,
            logPath,
            dialog: {
                showSaveDialog: async () => ({
                    canceled: false,
                    filePath: exportPath,
                }),
            },
        })
        assert.equal(result.canceled, false)
        assert.equal(result.filePath, exportPath)
        const content = fs.readFileSync(exportPath, "utf8")
        assert.equal(content.includes("SECRET"), false)
        assert.match(content, /phase=request/)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test("rotation at the size threshold keeps one .1 backup and stays bounded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-rot-"))
    try {
        const logPath = path.join(dir, "logs", "network-diagnostics.log")
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(
            logPath,
            "x".repeat(diagnosticsMain.ROTATE_BYTES + 10)
        )
        diagnosticsMain.appendDiagnostic(
            { phase: "rotate", outcome: "ok" },
            { fs, path, logPath, getVerbose: () => false }
        )
        assert.ok(fs.existsSync(logPath + ".1"), "backup must exist")
        assert.ok(
            fs.statSync(logPath).size <= diagnosticsMain.ROTATE_BYTES,
            "active log must be bounded"
        )
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test("verbose off writes summary only, verbose on writes redacted detail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-verb-"))
    try {
        const logPath = path.join(dir, "logs", "network-diagnostics.log")
        let verbose = false
        const deps = { fs, path, logPath, getVerbose: () => verbose }
        diagnosticsMain.appendDiagnostic(
            {
                ts: 1700000000000,
                phase: "request",
                outcome: "error",
                errorKind: "http",
                status: 502,
                detail: "api_key=SECRET",
            },
            deps
        )
        let content = fs.readFileSync(logPath, "utf8")
        assert.match(content, /status=502/)
        assert.equal(content.includes("SECRET"), false)
        assert.equal(content.includes('"detail"'), false)
        verbose = true
        diagnosticsMain.appendDiagnostic(
            {
                ts: 1700000000001,
                phase: "request",
                outcome: "error",
                errorKind: "http",
                status: 503,
                detail: "api_key=SECRET",
            },
            deps
        )
        content = fs.readFileSync(logPath, "utf8")
        assert.ok(content.includes('"detail"'))
        assert.equal(content.includes("SECRET"), false)
        assert.ok(content.includes('"status":503'))
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test("diagnostics IPC registers read, clear, verbose and export channels", async () => {
    const store = {
        values: { networkDiagVerbose: false },
        get(key, defaultValue) {
            return key in this.values ? this.values[key] : defaultValue
        },
        set(key, value) {
            this.values[key] = value
        },
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-ipc-"))
    try {
        diagnosticsMain.registerDiagnosticsIpc({
            getStore: () => store,
            userData: dir,
            dialog: { showSaveDialog: async () => ({ canceled: true }) },
        })
        for (const channel of [
            "network:diag-append",
            "network:diag-read",
            "network:diag-export",
            "network:diag-clear",
            "network:diag-get-verbose",
            "network:diag-set-verbose",
        ]) {
            assert.equal(typeof handlers[channel], "function", channel + " missing")
        }
        await handlers["network:diag-append"]({}, {
            phase: "request",
            status: 500,
            errorKind: "http",
            detail: "api_key=SECRET",
        })
        const text = await handlers["network:diag-read"]()
        assert.match(text, /status=500/)
        assert.equal(text.includes("SECRET"), false)
        assert.equal(await handlers["network:diag-get-verbose"](), false)
        await handlers["network:diag-set-verbose"]({}, true)
        assert.equal(store.get("networkDiagVerbose"), true)
        assert.equal(await handlers["network:diag-get-verbose"](), true)
        await handlers["network:diag-clear"]()
        assert.equal(await handlers["network:diag-read"](), "")
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test("pagination counters are recorded without changing the cursor", async () => {
    const http = require("node:http")
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
    const imports = {
        "react-intl-universal": { get: key => key },
        "../service": {},
        "../../../schema-types": { SyncService: { Fever: 1, None: 0 } },
        "../net/diagnostics": pure,
        "../group": { createSourceGroup: name => ({ name }) },
        "../source": { RSSSource: Source },
        "../item": {},
        "../rule": { ArticleRule: { applyAll() {} }, getRulesForTarget: () => [] },
        "../../utils": { htmlDecode: value => value, domParser },
        "../../db": { database: {}, itemsTable: {} },
        "./pending-read-states": { pendingReadStates: {} },
    }
    const loadFever = (fetchImpl, windowObj) => {
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
            id => (Object.prototype.hasOwnProperty.call(imports, id) ? imports[id] : require(id)),
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
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1")
        const maxId = Number(url.searchParams.get("max_id"))
        const items = maxId > 1000000 ? pageItems(100, 50) : pageItems(70, 30)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ items }))
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    try {
        const fever = loadFever(fetch, {
            network: {
                ensureRoute: async () => ({
                    mode: "direct",
                    routes: { default: "DIRECT" },
                }),
                appendLog: event => events.push(event),
            },
        })
        const cfg = {
            type: 1,
            endpoint: `http://127.0.0.1:${port}/fever`,
            username: "reader",
            apiKey: "KEY",
            fetchLimit: 1000,
            lastId: 0,
            timeoutMs: 1000,
        }
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
        assert.deepEqual(pages.map(event => event.page), [1, 2])
        assert.deepEqual(pages.map(event => event.count), [50, 30])
        assert.equal(resultConfigs.lastId, 149)
        assert.equal(cfg.lastId, 149)
    } finally {
        server.closeAllConnections?.()
        await new Promise(resolve => server.close(resolve))
    }
})

test("adversarial redaction cases never expose dummy secrets", () => {
    const cases = [
        ['{"apiKey":"DEMO_KEY_SECRET_91"}', "DEMO_KEY_SECRET_91"],
        ['{"password":"DEMO_PASSWORD_SECRET_92"}', "DEMO_PASSWORD_SECRET_92"],
        [
            "https://demo:DEMO_PASSWORD_SECRET_93@example.test/fever/?api_key=DEMO_KEY_93",
            "DEMO_PASSWORD_SECRET_93",
        ],
        ['token="DEMO_QUOTED_TOKEN_94 with-space"', "with-space"],
        ['{"cookie":"DEMO_COOKIE_SECRET_95"}', "DEMO_COOKIE_SECRET_95"],
    ]
    for (const [value, needle] of cases) {
        const text = JSON.stringify(
            pure.sanitizeEvent({ phase: "auth", detail: value })
        )
        assert.equal(text.includes(needle), false, "leaked " + needle)
    }
})

test("redactText strips quoted JSON and key=value secrets with any spacing", () => {
    const cases = [
        ['{ "api_key" : "DEMO_JSON_KEY_101" }', "DEMO_JSON_KEY_101"],
        ['{"passwd": "DEMO_JSON_PASSWD_102"}', "DEMO_JSON_PASSWD_102"],
        ['{"set-cookie":"DEMO_JSON_COOKIE_103"}', "DEMO_JSON_COOKIE_103"],
        ['{"authorization":"DEMO_JSON_AUTH_104"}', "DEMO_JSON_AUTH_104"],
        ['{"access_token":"DEMO_JSON_ACCESS_105"}', "DEMO_JSON_ACCESS_105"],
        ['{"refresh_token":"DEMO_JSON_REFRESH_106"}', "DEMO_JSON_REFRESH_106"],
        ['{"secret":"DEMO_JSON_SECRET_107"}', "DEMO_JSON_SECRET_107"],
        ["password='DEMO_SINGLE_QUOTED_108 with space'", "with space"],
        ['token="DEMO_DOUBLE_QUOTED_109 with space"', "with space"],
        ["https://demo:DEMO_USERINFO_110@example.test/fever", "DEMO_USERINFO_110"],
        ["prefix https://u:DEMO_USERINFO_111@host.test/a?x=1 suffix", "DEMO_USERINFO_111"],
    ]
    for (const [value, needle] of cases) {
        const redacted = pure.redactText(value, 500)
        assert.equal(redacted.includes(needle), false, "leaked " + needle)
    }
})

test("redactText re-checks after substitutions and still truncates", () => {
    assert.equal(
        pure.redactText('{"note":"token=DEMO_LAYER_112"}', 500).includes(
            "DEMO_LAYER_112"
        ),
        false
    )
    const redacted = pure.redactText(
        'header {"password":"DEMO_TRUNC_113"} trailing text',
        20
    )
    assert.ok(redacted.length <= 20)
    assert.equal(redacted.includes("DEMO_TRUNC_113"), false)
})

test("classifyError recognizes Chromium net error codes", () => {
    assert.equal(pure.classifyError({ code: "net::ERR_TIMED_OUT" }), "timeout")
    assert.equal(
        pure.classifyError({ message: "Failed to fetch: net::ERR_TIMED_OUT" }),
        "timeout"
    )
    for (const code of [
        "net::ERR_NAME_NOT_RESOLVED",
        "net::ERR_CONNECTION_REFUSED",
        "net::ERR_CONNECTION_RESET",
        "net::ERR_PROXY_CONNECTION_FAILED",
        "net::ERR_INTERNET_DISCONNECTED",
        "net::ERR_TUNNEL_CONNECTION_FAILED",
    ]) {
        assert.equal(pure.classifyError({ code }), "network", code)
        assert.equal(
            pure.classifyError({ message: "Request failed: " + code }),
            "network",
            code
        )
    }
    assert.equal(pure.classifyError({}), "unknown")
})

test("sanitizeEvent preserves only allowlisted net::ERR_ error codes", () => {
    const kept = pure.sanitizeEvent({
        phase: "request",
        errorCode: "net::ERR_TIMED_OUT",
    })
    assert.equal(kept.errorCode, "net::ERR_TIMED_OUT")
    const proxied = pure.sanitizeEvent({
        phase: "request",
        errorCode: "net::ERR_PROXY_CONNECTION_FAILED",
    })
    assert.equal(proxied.errorCode, "net::ERR_PROXY_CONNECTION_FAILED")
    for (const bad of [
        "ERR_TIMED_OUT",
        "net::ERR_",
        "net::ERR_lower",
        "net::ERR_A-B",
        "net::ERR_X\n",
        "secret=1",
        " net::ERR_TIMED_OUT",
        42,
        null,
        {},
    ]) {
        const sanitized = pure.sanitizeEvent({ phase: "request", errorCode: bad })
        assert.equal(
            "errorCode" in sanitized,
            false,
            "dropped bogus code: " + String(bad)
        )
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
