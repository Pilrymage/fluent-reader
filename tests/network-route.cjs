const assert = require("node:assert/strict")
const fs = require("node:fs")
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

function loadModule(file, imports) {
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

function makeStore(values = {}) {
    return {
        values,
        get(key, defaultValue) {
            return key in this.values ? this.values[key] : defaultValue
        },
        set(key, value) {
            this.values[key] = value
        },
    }
}

const diagnosticsStub = {
    sanitizeEndpoint: raw => {
        try {
            const url = new URL(raw)
            return url.origin + url.pathname
        } catch {
            return ""
        }
    },
    classifyError: err => (err && err.errorKind) || "unknown",
    redactText: (text, limit) =>
        String(text == null ? "" : text).slice(0, limit || 200),
}

const handlers = {}
const electron = {
    ipcMain: {
        handle(channel, handler) {
            handlers[channel] = handler
        },
    },
    session: {
        defaultSession: {
            setProxy: async () => {},
            resolveProxy: async () => "DIRECT",
        },
        fromPartition: () => ({
            setProxy: async () => {},
            resolveProxy: async () => "DIRECT",
        }),
    },
    app: { getPath: () => process.cwd() },
}

const net = loadModule("src/main/network.ts", {
    "./diagnostics": { appendDiagnostic() {} },
    electron,
    "../schema-types": { SyncService: { None: 0, Fever: 1 } },
    "../scripts/models/net/diagnostics": diagnosticsStub,
})

const tests = []
function test(name, fn) {
    tests.push([name, fn])
}

test("proxy rules map system, direct and PAC", () => {
    assert.deepEqual(net.proxyRulesFor("system", ""), { mode: "system" })
    assert.deepEqual(net.proxyRulesFor("direct", ""), { mode: "direct" })
    assert.deepEqual(
        net.proxyRulesFor("pac", "http://127.0.0.1:9999/proxy.pac"),
        { mode: "pac_script", pacScript: "http://127.0.0.1:9999/proxy.pac" }
    )
})

test("effective mode prefers explicit proxyMode and preserves legacy PAC", () => {
    assert.equal(net.getProxyMode(makeStore({})), "system")
    assert.equal(net.getProxyMode(makeStore({ pacOn: true })), "pac")
    assert.equal(
        net.getProxyMode(makeStore({ pacOn: true, proxyMode: "direct" })),
        "direct"
    )
    assert.equal(
        net.getProxyMode(makeStore({ pacOn: false, proxyMode: "system" })),
        "system"
    )
})

test("direct is applied to default and sandbox with verbatim readback", async () => {
    const calls = []
    const sessions = {
        defaultSession: {
            async setProxy(rules) {
                calls.push(["default", rules])
            },
            async resolveProxy() {
                return "PROXY 127.0.0.1:7890; DIRECT"
            },
        },
        sandboxSession: {
            async setProxy(rules) {
                calls.push(["sandbox", rules])
            },
            async resolveProxy() {
                return "DIRECT"
            },
        },
    }
    const result = await net.applyProxyMode("direct", {
        getStore: () => makeStore({ pac: "http://127.0.0.1:9/p.pac" }),
        sessions,
    })
    assert.deepEqual(calls, [
        ["default", { mode: "direct" }],
        ["sandbox", { mode: "direct" }],
    ])
    assert.deepEqual(result, {
        mode: "direct",
        routes: {
            default: "PROXY 127.0.0.1:7890; DIRECT",
            sandbox: "DIRECT",
        },
    })
})

test("applyProxyMode waits for BOTH session setProxy promises before resolving", async () => {
    let releaseDefault
    let releaseSandbox
    const log = []
    const sessions = {
        defaultSession: {
            setProxy() {
                log.push(["set", "default"])
                return new Promise(resolve => (releaseDefault = resolve))
            },
            resolveProxy() {
                log.push(["resolve", "default"])
                return Promise.resolve("A")
            },
        },
        sandboxSession: {
            setProxy() {
                log.push(["set", "sandbox"])
                return new Promise(resolve => (releaseSandbox = resolve))
            },
            resolveProxy() {
                log.push(["resolve", "sandbox"])
                return Promise.resolve("B")
            },
        },
    }
    const pending = net.applyProxyMode("direct", {
        getStore: () => makeStore({}),
        sessions,
    })
    const tick = () => new Promise(resolve => setImmediate(resolve))
    await tick()
    assert.equal(
        log.some(entry => entry[0] === "resolve"),
        false,
        "must not resolve before any setProxy settles"
    )
    releaseDefault()
    await tick()
    assert.equal(
        log.some(entry => entry[0] === "resolve"),
        false,
        "must not resolve before the sandbox setProxy settles"
    )
    releaseSandbox()
    const result = await pending
    assert.deepEqual(result.routes, { default: "A", sandbox: "B" })
    assert.equal(log.filter(entry => entry[0] === "resolve").length, 2)
})

test("switching back to system and PAC reapplies both sessions", async () => {
    const store = makeStore({ pac: "http://127.0.0.1:9/proxy.pac" })
    const rules = []
    const sessions = {
        defaultSession: {
            async setProxy(value) {
                rules.push(value)
            },
            async resolveProxy() {
                return "DIRECT"
            },
        },
        sandboxSession: {
            async setProxy(value) {
                rules.push(value)
            },
            async resolveProxy() {
                return "DIRECT"
            },
        },
    }
    await net.applyProxyMode("system", { getStore: () => store, sessions })
    assert.deepEqual(rules, [{ mode: "system" }, { mode: "system" }])
    await net.applyProxyMode("pac", { getStore: () => store, sessions })
    assert.deepEqual(rules.slice(2), [
        { mode: "pac_script", pacScript: "http://127.0.0.1:9/proxy.pac" },
        { mode: "pac_script", pacScript: "http://127.0.0.1:9/proxy.pac" },
    ])
})

test("IPC exposes get-state, set-mode, ensure-route and diagnose", async () => {
    const store = makeStore({
        proxyMode: "direct",
        pac: "",
        serviceConfigs: { type: 0 },
    })
    const sessions = {
        defaultSession: {
            async setProxy() {},
            async resolveProxy() {
                return "DIRECT"
            },
        },
        sandboxSession: {
            async setProxy() {},
            async resolveProxy() {
                return "DIRECT"
            },
        },
    }
    net.registerNetworkIpc({
        getStore: () => store,
        sessions,
        fetchImpl: async () => ({ ok: true, status: 200 }),
        now: () => 1,
    })
    for (const channel of [
        "network:get-state",
        "network:set-mode",
        "network:diagnose-endpoint",
        "network:ensure-route",
    ]) {
        assert.equal(typeof handlers[channel], "function", channel + " missing")
    }
    const state = await handlers["network:get-state"]()
    assert.equal(state.mode, "direct")
    assert.deepEqual(state.routes, { default: "DIRECT", sandbox: "DIRECT" })
    const changed = await handlers["network:set-mode"]({}, "system")
    assert.equal(store.get("proxyMode"), "system")
    assert.equal(changed.mode, "system")
    const ensured = await handlers["network:ensure-route"]()
    assert.deepEqual(ensured.routes, { default: "DIRECT", sandbox: "DIRECT" })
})

test("applyProxyMode resolves the route for the supplied target, not example.com", async () => {
    const resolved = []
    const sessions = {
        defaultSession: {
            async setProxy() {},
            async resolveProxy(url) {
                resolved.push(url)
                return "PROXY 127.0.0.1:7890"
            },
        },
        sandboxSession: {
            async setProxy() {},
            async resolveProxy(url) {
                resolved.push("sandbox:" + url)
                return "DIRECT"
            },
        },
    }
    const result = await net.applyProxyMode(
        "direct",
        { getStore: () => makeStore({}), sessions },
        "http://127.0.0.1:4567"
    )
    assert.equal(result.routes.default, "PROXY 127.0.0.1:7890")
    assert.deepEqual(resolved, [
        "http://127.0.0.1:4567",
        "sandbox:http://127.0.0.1:4567",
    ])
})

test("ensure-route IPC accepts a target and returns the readback", async () => {
    const resolved = []
    const store = makeStore({ proxyMode: "direct" })
    const sessions = {
        defaultSession: {
            async setProxy() {},
            async resolveProxy(url) {
                resolved.push(url)
                return "DIRECT"
            },
        },
        sandboxSession: {
            async setProxy() {},
            async resolveProxy(url) {
                resolved.push("sandbox:" + url)
                return "DIRECT"
            },
        },
    }
    net.registerNetworkIpc({ getStore: () => store, sessions })
    const ensured = await handlers["network:ensure-route"](
        {},
        "https://fever.example.test"
    )
    assert.deepEqual(ensured.routes, { default: "DIRECT", sandbox: "DIRECT" })
    assert.ok(resolved.every(url => url.includes("fever.example.test")))
})

test("diagnose endpoint is read-only and reports no Fever config safely", async () => {
    const store = makeStore({ serviceConfigs: { type: 0 } })
    const sessions = {
        defaultSession: {
            async setProxy() {},
            async resolveProxy() {
                return "DIRECT"
            },
        },
        sandboxSession: {
            async setProxy() {},
            async resolveProxy() {
                return "DIRECT"
            },
        },
    }
    net.registerNetworkIpc({ getStore: () => store, sessions })
    const result = await handlers["network:diagnose-endpoint"]()
    assert.equal(result.ok, false)
    assert.equal(store.get("serviceConfigs").type, 0)
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
