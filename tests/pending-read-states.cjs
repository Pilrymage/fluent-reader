// Read states marked locally must survive a sync until the service confirms
// them. Covers the pending registry, the sync flow in service.ts, and the
// Fever mark-all-read path, using the same transpile + fake-require pattern
// as the other custom tests.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")

function load(file, imports = {}, globals = {}) {
    const code = ts.transpileModule(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
                esModuleInterop: true,
            },
        }
    ).outputText
    const module = { exports: {} }
    const names = Object.keys(globals)
    new Function("require", "module", "exports", ...names, code)(
        id => (id in imports ? imports[id] : {}),
        module,
        module.exports,
        ...names.map(name => globals[name])
    )
    return module.exports
}

function memoryStorage() {
    const data = new Map()
    return {
        data,
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
    }
}

const SyncService = {
    None: 0,
    Fever: 1,
    Feedbin: 2,
    GReader: 3,
    Inoreader: 4,
    Miniflux: 5,
    Nextcloud: 6,
}
const FEVER = { type: SyncService.Fever, endpoint: "http://rss.test/fever/" }

function loadRegistry(storage) {
    return load(
        "src/scripts/models/services/pending-read-states.ts",
        {},
        {
            localStorage: storage,
        }
    )
}

function deferred() {
    let resolve, reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

async function settle(times = 20) {
    for (let i = 0; i < times; i += 1) await Promise.resolve()
}

const tests = []
function test(name, fn) {
    tests.push([name, fn])
}

test("registry keeps the newest intent and confirms only a matching one", () => {
    const { PendingReadStates } = loadRegistry(memoryStorage())
    const storage = memoryStorage()
    const pending = new PendingReadStates(() => storage).use(FEVER)
    pending.set(["1", "2"], true)
    pending.set(["1"], false)
    // A late confirmation of the older "read" must not drop the newer "unread".
    pending.confirm("1", true)
    assert.equal(pending.get("1"), false)
    pending.confirm("2", true)
    assert.equal(pending.get("2"), undefined)

    const unread = new Set(["2", "3"])
    pending.set(["3"], true)
    pending.applyTo(unread)
    assert.deepEqual([...unread].sort(), ["1", "2"])
})

test("registry persists per service and drops other accounts' changes", () => {
    const { PendingReadStates } = loadRegistry(memoryStorage())
    const storage = memoryStorage()
    new PendingReadStates(() => storage).use(FEVER).set(["7"], true)

    const restored = new PendingReadStates(() => storage).use(FEVER)
    assert.equal(restored.get("7"), true)

    const other = new PendingReadStates(() => storage).use({
        ...FEVER,
        endpoint: "http://other.test/fever/",
    })
    assert.equal(other.size, 0)

    restored.confirm("7", true)
    assert.equal(storage.getItem("pendingServiceReadStates"), null)
})

test("registry survives broken storage", () => {
    const { PendingReadStates } = loadRegistry(memoryStorage())
    const broken = {
        getItem() {
            throw new Error("denied")
        },
        setItem() {
            throw new Error("quota")
        },
        removeItem() {
            throw new Error("denied")
        },
    }
    const pending = new PendingReadStates(() => broken).use(FEVER)
    pending.set(["1"], true)
    assert.equal(pending.get("1"), true)
})

test("registry writes storage once per batch", () => {
    const { PendingReadStates } = loadRegistry(memoryStorage())
    const storage = memoryStorage()
    let writes = 0
    const counting = {
        ...storage,
        setItem: (key, value) => {
            writes += 1
            storage.setItem(key, value)
        },
        removeItem: key => {
            writes += 1
            storage.removeItem(key)
        },
    }
    const pending = new PendingReadStates(() => counting).use(FEVER)
    const refs = Array.from({ length: 3000 }, (_, i) => String(i))
    pending.set(refs, true)
    pending.confirm(refs.slice(0, 2999), true)
    assert.equal(writes, 2)
    assert.deepEqual(pending.refs(), ["2999"])
    // Nothing matching means nothing to write.
    pending.confirm(["2999"], false)
    assert.equal(writes, 2)
})

function makeServiceHarness({ markRead, markUnread, unread = [], rows = [] }) {
    const storage = memoryStorage()
    const registry = loadRegistry(storage)
    const env = {
        storage,
        registry: registry.pendingReadStates,
        events: [],
        updates: [],
        syncLocal: null,
    }
    const hooks = {
        markRead: item => async () => {
            env.events.push("markRead:" + item.serviceRef)
            return markRead(item)
        },
        markUnread: item => async () => {
            env.events.push("markUnread:" + item.serviceRef)
            return markUnread(item)
        },
        updateSources: () => async () => [[], null],
        syncItems: () => async () => {
            env.events.push("syncItems")
            return [new Set(unread), new Set()]
        },
        fetchItems: () => async () => [[], FEVER],
    }
    const column = name => ({ name })
    const itemsTable = {
        serviceRef: column("serviceRef"),
        hasRead: column("hasRead"),
        starred: column("starred"),
    }
    const database = {
        select: () => ({
            from: () => ({ where: () => Promise.resolve(rows) }),
        }),
        update: () => ({
            set: values => ({
                where: condition => {
                    env.updates.push({ ref: condition.value, ...values })
                    return Promise.resolve()
                },
            }),
        }),
    }
    const state = {
        service: FEVER,
        sources: {},
        app: { settings: { saving: false } },
    }
    const service = load("src/scripts/models/service.ts", {
        "../db": { database, itemsTable, sourcesTable: {} },
        "drizzle-orm": {
            and: (...args) => ({ and: args }),
            or: (...args) => ({ or: args }),
            eq: (col, value) => ({ col, value }),
            isNotNull: col => ({ notNull: col }),
        },
        "../../schema-types": { SyncService },
        "../utils": { ActionStatus: { Request: 0, Success: 1, Failure: 2 } },
        "./source": { updateUnreadCounts: () => ({ type: "UNREAD_COUNTS" }) },
        "./app": { saveSettings: () => ({ type: "SAVE_SETTINGS" }) },
        "./services/fever": { feverServiceHooks: hooks },
        "./services/pending-read-states": registry,
    })
    env.dispatch = action => {
        if (typeof action === "function") {
            return action(env.dispatch, () => state)
        }
        if (action && action.type === service.SYNC_LOCAL_ITEMS) {
            env.syncLocal = action
        }
        if (action && action.type === service.SYNC_SERVICE) {
            env.events.push("sync:" + action.status)
            if (action.err) env.syncError = action.err
        }
        return action
    }
    env.service = service
    return env
}

test("a failed mark is retried before the next sync reads unread ids", async () => {
    let calls = 0
    const env = makeServiceHarness({
        markRead: async () => {
            calls += 1
            if (calls === 1) throw new Error("offline")
        },
        unread: [],
    })
    const ok = await env.dispatch(
        env.service.pushReadState({ serviceRef: "42" }, true)
    )
    assert.equal(ok, false)
    assert.equal(env.registry.get("42"), true)
    assert.ok(env.storage.getItem("pendingServiceReadStates"))

    await env.dispatch(env.service.syncWithService())
    assert.equal(env.syncError, undefined)
    assert.deepEqual(env.events, [
        "markRead:42",
        "sync:0",
        "markRead:42",
        "syncItems",
        "sync:1",
    ])
    assert.equal(env.registry.size, 0)
    assert.equal(env.storage.getItem("pendingServiceReadStates"), null)
})

test("an unconfirmed read is never reverted by the service's unread list", async () => {
    const env = makeServiceHarness({
        markRead: async () => {
            throw new Error("offline")
        },
        // The service still lists 42 as unread; 43 is genuinely unread.
        unread: ["42", "43"],
        rows: [],
    })
    await env.dispatch(env.service.pushReadState({ serviceRef: "42" }, true))
    await env.dispatch(env.service.syncWithService())
    assert.deepEqual(
        env.updates.filter(u => u.hasRead === false).map(u => u.ref),
        ["43"]
    )
    assert.equal(env.syncLocal.unreadIds.has("42"), false)
    assert.equal(env.syncLocal.unreadIds.has("43"), true)
    assert.equal(env.registry.get("42"), true, "still pending for later")
})

test("an unconfirmed unread is not overwritten by the service", async () => {
    const env = makeServiceHarness({
        markUnread: async () => {
            throw new Error("offline")
        },
        unread: [],
        rows: [{ serviceRef: "9", hasRead: false, starred: false }],
    })
    await env.dispatch(env.service.pushReadState({ serviceRef: "9" }, false))
    await env.dispatch(env.service.syncWithService())
    assert.deepEqual(
        env.updates.filter(u => u.ref === "9"),
        [],
        "the local unread row must not be marked read"
    )
    assert.equal(env.syncLocal, null)
})

test("sync waits for a mark that is still in flight", async () => {
    const gate = deferred()
    const env = makeServiceHarness({
        markRead: () => gate.promise,
        unread: ["5"],
    })
    void env.dispatch(env.service.pushReadState({ serviceRef: "5" }, true))
    const sync = env.dispatch(env.service.syncWithService())
    await settle()
    assert.deepEqual(env.events, ["sync:0", "markRead:5"])
    gate.resolve()
    await sync
    assert.deepEqual(env.events, [
        "sync:0",
        "markRead:5",
        "syncItems",
        "sync:1",
    ])
    // The service now lists 5 as unread again only if it really is.
    assert.equal(env.registry.size, 0)
})

test("changes to one item reach the service in order", async () => {
    const first = deferred()
    const env = makeServiceHarness({
        markRead: () => first.promise,
        markUnread: async () => {},
    })
    const read = env.dispatch(
        env.service.pushReadState({ serviceRef: "3" }, true)
    )
    await settle()
    const unread = env.dispatch(
        env.service.pushReadState({ serviceRef: "3" }, false)
    )
    await settle()
    // The second request waits for the first one.
    assert.deepEqual(env.events, ["markRead:3"])
    first.resolve()
    await Promise.all([read, unread])
    assert.deepEqual(env.events, ["markRead:3", "markUnread:3"])
    assert.equal(env.registry.size, 0)
})

test("quick changes to one item send only the latest state", async () => {
    const env = makeServiceHarness({
        markRead: async () => {},
        markUnread: async () => {},
    })
    await Promise.all([
        env.dispatch(env.service.pushReadState({ serviceRef: "4" }, true)),
        env.dispatch(env.service.pushReadState({ serviceRef: "4" }, false)),
    ])
    assert.deepEqual(env.events, ["markUnread:4"])
    assert.equal(env.registry.size, 0)
})

test("retries stop once nothing gets through", async () => {
    let calls = 0
    const env = makeServiceHarness({
        markRead: async () => {
            calls += 1
            throw new Error("offline")
        },
    })
    const refs = Array.from({ length: 30 }, (_, i) => String(i + 1))
    env.registry.use(FEVER).set(refs, true)
    await env.dispatch(env.service.syncWithService())
    assert.equal(calls, 8, "only the first batch is attempted")
    assert.equal(env.registry.size, 30)
})

function loadDiagnostics() {
    return load("src/scripts/models/net/diagnostics.ts")
}

function makeFeverHarness({ rows, failFeed }) {
    const storage = memoryStorage()
    const registry = loadRegistry(storage)
    const posts = []
    const fetchImpl = async (_url, init) => {
        posts.push(init.body)
        if (failFeed && init.body.includes(`&id=${failFeed}&`)) {
            throw Object.assign(new Error("reset"), { errorKind: "network" })
        }
        return { ok: true, status: 200, json: async () => ({ auth: 1 }) }
    }
    const fever = load(
        "src/scripts/models/services/fever.ts",
        {
            "react-intl-universal": { get: key => key },
            "../../db": {
                database: {
                    select: () => ({
                        from: () => ({ where: () => Promise.resolve(rows) }),
                    }),
                },
                itemsTable: {},
            },
            "drizzle-orm": {
                and: () => ({}),
                eq: () => ({}),
                gte: () => ({}),
                inArray: () => ({}),
                isNotNull: () => ({}),
                lte: () => ({}),
            },
            "./pending-read-states": registry,
            "../net/diagnostics": loadDiagnostics(),
        },
        { fetch: fetchImpl, window: undefined }
    )
    const state = {
        service: { ...FEVER, apiKey: "k" },
        sources: {
            1: { sid: 1, serviceRef: "100" },
            2: { sid: 2, serviceRef: "200" },
        },
    }
    return {
        posts,
        registry: registry.pendingReadStates,
        markAllRead: (...args) =>
            fever.feverServiceHooks.markAllRead(...args)(null, () => state),
        markRead: ref =>
            fever.feverServiceHooks.markRead({ serviceRef: ref })(
                null,
                () => state
            ),
    }
}

test("Fever mark-all-read stays pending until each feed is confirmed", async () => {
    const past = new Date(Date.now() - 3600 * 1000)
    const future = new Date(Date.now() + 3 * 3600 * 1000)
    const env = makeFeverHarness({
        rows: [
            { serviceRef: "a", source: 1, date: past },
            // Dated ahead: the service only marks entries before `before`.
            { serviceRef: "b", source: 1, date: future },
            { serviceRef: "c", source: 2, date: past },
        ],
        failFeed: "200",
    })
    await env.markAllRead([1, 2], null, true)
    // Returns before the requests finish, with every item protected.
    assert.deepEqual(env.registry.refs().sort(), ["a", "b", "c"])
    await env.registry.settled()
    assert.equal(env.posts.length, 2)
    assert.ok(env.posts.every(body => body.includes("&mark=feed&as=read")))
    assert.deepEqual(env.registry.refs().sort(), ["b", "c"])
})

test("Fever mark-newer-as-read marks every matching row one by one", async () => {
    const env = makeFeverHarness({
        rows: [
            { serviceRef: "x", source: 1, date: new Date() },
            { serviceRef: "y", source: 2, date: new Date() },
        ],
    })
    await env.markAllRead([1, 2], new Date(Date.now() - 1000), false)
    await env.registry.settled()
    assert.deepEqual(
        env.posts.map(body => body.replace(/^api_key=k/, "")).sort(),
        ["&mark=item&as=read&id=x", "&mark=item&as=read&id=y"]
    )
    assert.equal(env.registry.size, 0)
})

test("Fever markRead throws when the service rejects or fails", async () => {
    const env = makeFeverHarness({ rows: [], failFeed: null })
    await env.markRead("1")
    assert.deepEqual(env.posts, ["api_key=k&mark=item&as=read&id=1"])
    const rejected = load(
        "src/scripts/models/services/fever.ts",
        {
            "react-intl-universal": { get: key => key },
            "../net/diagnostics": loadDiagnostics(),
        },
        {
            fetch: async () => ({
                ok: true,
                status: 200,
                json: async () => ({ auth: 0 }),
            }),
            window: undefined,
        }
    )
    await assert.rejects(
        rejected.feverServiceHooks.markRead({ serviceRef: "1" })(null, () => ({
            service: { ...FEVER, apiKey: "bad" },
        })),
        /auth: 0/
    )
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
