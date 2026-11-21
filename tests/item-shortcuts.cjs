// Integration tests for the item shortcut thunks. They load the real
// src/scripts/models/item.ts (and the real keyboard module) through the same
// transpile + fake-require pattern used by the other custom tests.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")

function transpile(file, imports) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8")
    const code = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
        },
    }).outputText
    const module = { exports: {} }
    new Function("require", "module", "exports", code)(
        id => imports[id] || {},
        module,
        module.exports
    )
    return module.exports
}

const tests = []
function test(name, fn) {
    tests.push([name, fn])
}

async function settle(times = 25) {
    for (let i = 0; i < times; i += 1) await Promise.resolve()
}

function makeHarness(options = {}) {
    const kb = transpile("src/scripts/keyboard.ts", {})

    const env = {
        focusedIds: [],
        loadMoreCalls: 0,
        markAllSids: null,
        inArrayCalls: [],
        rafQueue: [],
        unreadFilter: Boolean(options.unreadFilter),
        web: false,
        queuedReads: [],
        readBatches: [],
        markedSources: [],
        articleTrap: Boolean(options.articleTrap),
    }
    const feedId = options.feedId || "ALL"
    const iids = options.iids || [1, 2, 3]
    const itemIds = options.itemIds || iids
    const cardHeight = options.cardHeight || 100
    const clientHeight = options.clientHeight || 600
    const scrollHeight = options.scrollHeight || 4000
    const containerTop =
        options.containerTop === undefined ? 32 : options.containerTop
    const navBottom = options.navBottom === undefined ? 32 : options.navBottom

    const items = {}
    for (const id of itemIds) {
        items[id] = { _id: id, hasRead: false, source: 1 }
    }
    const feeds = {}
    feeds[feedId] = {
        _id: feedId,
        iids: [...iids],
        sids: options.sids || [1],
        allLoaded: options.allLoaded === undefined ? true : options.allLoaded,
        loading: false,
        loaded: true,
    }
    if (options.extraFeeds) Object.assign(feeds, options.extraFeeds)

    env.state = {
        page: { feedId, itemId: null, viewType: 0 },
        feeds,
        items,
        app: { settings: { display: false }, contextMenu: { type: 0 } },
        sources: {},
        rules: {},
        groups: {},
    }

    const offsets = options.offsets || {}
    const offsetFor = id => {
        if (offsets[id] !== undefined) return offsets[id]
        const index = iids.indexOf(id)
        return 1000 + Math.max(0, index) * cardHeight
    }

    const container = {
        id: "refocus",
        scrollTop: 0,
        scrollHeight,
        clientHeight,
        offsetHeight: clientHeight,
        getBoundingClientRect: () => ({
            top: containerTop,
            bottom: containerTop + clientHeight,
            height: clientHeight,
        }),
    }
    const nav = {
        getBoundingClientRect: () => ({
            top: navBottom - 32,
            bottom: navBottom,
            height: 32,
        }),
    }
    const cards = new Map()
    const makeCard = id => {
        const offset = offsetFor(id)
        const card = {
            id,
            tagName: "DIV",
            isContentEditable: false,
            attrs: { "data-iid": String(id) },
            closest(selector) {
                return /list-card|compact-card|magazine-card|default-card/.test(
                    selector
                )
                    ? card
                    : null
            },
            getAttribute(name) {
                return name in card.attrs ? card.attrs[name] : null
            },
            hasAttribute(name) {
                return name in card.attrs
            },
            setAttribute(name, value) {
                card.attrs[name] = value
            },
            focus() {
                document.activeElement = card
                env.focusedIds.push(id)
            },
            getBoundingClientRect() {
                const top = offset - container.scrollTop + containerTop
                return { top, bottom: top + cardHeight, height: cardHeight }
            },
        }
        cards.set(id, card)
        return card
    }
    const rendered = options.rendered || iids
    for (const id of rendered) makeCard(id)

    const document = {
        activeElement: null,
        documentElement: {},
        getElementById: id => (id === "refocus" ? container : null),
        querySelector(selector) {
            if (selector === "nav") return nav
            if (selector === ".article-container") {
                return env.articleTrap ? { className: "article-container" } : null
            }
            const match = /^\[data-iid="(\d+)"\]$/.exec(selector)
            if (match) return cards.get(Number(match[1])) || null
            return null
        },
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
    }

    globalThis.document = document
    globalThis.window = {
        innerWidth: 1200,
        utils: { openExternal() {} },
        settings: { getFilterType: () => null },
    }
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" })
    globalThis.requestAnimationFrame = callback => {
        env.rafQueue.push(callback)
        return env.rafQueue.length
    }
    env.flushRaf = () => {
        const pending = env.rafQueue.splice(0)
        for (const callback of pending) callback()
        return pending.length
    }

    env.document = document
    env.container = container
    env.cards = cards
    env.addCard = id => makeCard(id)

    env.dispatch = action => {
        if (typeof action === "function") {
            return action(env.dispatch, () => env.state)
        }
        if (!action) return action
        if (action.type === "MARK_READ") {
            const item = env.state.items[action.item._id]
            if (item) item.hasRead = true
            if (env.unreadFilter) {
                const feed = env.state.feeds[env.state.page.feedId]
                if (feed) {
                    feed.iids = feed.iids.filter(id => id !== action.item._id)
                }
            }
        }
        if (action.type === "MARK_UNREAD") {
            const item = env.state.items[action.item._id]
            if (item) item.hasRead = false
        }
        return action
    }

    const database = {
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        insert: () => ({
            values: () => ({ returning: () => Promise.resolve([]) }),
        }),
        select: () => ({
            from: () => ({
                where: () => ({
                    orderBy: () => ({
                        offset: () => ({ limit: () => Promise.resolve([]) }),
                    }),
                }),
            }),
        }),
    }

    const imports = {
        "../keyboard": kb,
        "../db": { database, itemsTable: {} },
        "drizzle-orm": {
            eq: () => ({}),
            and: () => ({}),
            inArray: (column, values) => {
                env.inArrayCalls.push(values)
                env.markAllSids = values
                return {}
            },
            lte: () => ({}),
            gte: () => ({}),
            desc: () => ({}),
            sql: () => ({}),
        },
        "../date": {
            getValidDate: (...dates) => dates.find(Boolean) || new Date(),
        },
        "react-intl-universal": { get: key => key },
        "../utils": {
            domParser: {},
            htmlDecode: value => value,
            ActionStatus: {
                Request: "request",
                Success: "success",
                Failure: "failure",
                Intermediate: "intermediate",
            },
            platformCtrl: () => false,
        },
        "./rule": { getRulesForTarget: () => [] },
        "./source": {
            RSSSource: class {},
            updateSource: () => ({}),
            updateUnreadCounts: () => ({ type: "UPDATE_UNREAD" }),
        },
        "./service": {
            getServiceHooks: () => ({}),
            pushReadState: () => async () => true,
            syncWithService: () => ({}),
            SYNC_LOCAL_ITEMS: "SYNC_LOCAL_ITEMS",
        },
        "./feed": {
            INIT_FEED: "INIT_FEED",
            LOAD_MORE: "LOAD_MORE",
            dismissItems: () => ({ type: "DISMISS_ITEMS" }),
            loadMore: feed => async () => {
                env.loadMoreCalls += 1
                if (options.onLoadMore) options.onLoadMore(env, feed)
            },
        },
        "./app": {
            pushNotification: () => ({ type: "PUSH" }),
            setupAutoFetch: () => ({ type: "AUTO" }),
            SettingsActionTypes: {},
            FREE_MEMORY: "FREE_MEMORY",
        },
        // The browser build talks to the BFF instead of SQLite. env.web stays
        // false by default so the existing cases keep exercising the DB path.
        "./net/bff": {
            isWeb: () => env.web,
            markSourcesRead: sids => {
                env.markedSources.push(...sids)
                return Promise.resolve()
            },
            setReadBatch: (ids, value) => {
                env.readBatches.push({ ids, value })
                return Promise.resolve()
            },
            setStar: () => Promise.resolve(),
            fetchItemDetail: () => Promise.resolve(null),
            fetchItems: () => Promise.resolve({ items: [], next: null }),
        },
        "./net/read-queue": {
            queueReadState: (id, value) => {
                env.queuedReads.push({ id, value })
            },
        },
    }

    const itemMod = transpile("src/scripts/models/item.ts", imports)
    env.itemMod = itemMod
    env.kb = kb
    return env
}

function keyEvent(overrides = {}) {
    return Object.assign(
        {
            key: "r",
            shiftKey: false,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            repeat: false,
            isComposing: false,
            keyCode: 82,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true
            },
            stopPropagation() {},
            target: null,
        },
        overrides
    )
}

function cardTarget(card) {
    return {
        tagName: "DIV",
        isContentEditable: false,
        closest: selector =>
            /list-card|compact-card|magazine-card|default-card/.test(selector)
                ? card
                : null,
    }
}

function ctrlL(card) {
    return keyEvent({ key: "l", ctrlKey: true, target: cardTarget(card) })
}

function shiftR() {
    return keyEvent({
        key: "R",
        shiftKey: true,
        code: "KeyR",
        target: {
            tagName: "DIV",
            isContentEditable: false,
            closest: () => null,
        },
    })
}

async function press(env, item, e) {
    return env.dispatch(env.itemMod.itemShortcuts(item, e))
}

test("Ctrl+L applies CENTER first through the real thunk", async () => {
    const env = makeHarness({ iids: [1, 2, 3], offsets: { 1: 1000 } })
    const item = env.state.items[1]
    const card = env.cards.get(1)
    const scrolls = []
    for (let i = 0; i < 4; i += 1) {
        await press(env, item, ctrlL(card))
        scrolls.push(env.container.scrollTop)
    }
    // center 1000 - (600 - 100) / 2 = 750, top 1000, bottom 500, center 750.
    assert.deepEqual(scrolls, [750, 1000, 500, 750])
    assert.equal(env.focusedIds.length, 4)
    assert.ok(env.focusedIds.every(id => id === 1))
})

test("Ctrl+L follows a newly focused row and resets the cycle to center", async () => {
    const env = makeHarness({
        iids: [1, 2, 3],
        offsets: { 1: 1000, 3: 1200 },
    })
    const item1 = env.state.items[1]
    await press(env, item1, ctrlL(env.cards.get(1)))
    assert.equal(env.container.scrollTop, 750)
    // User focuses a different row (mouse / Tab / programmatic).
    env.document.activeElement = env.cards.get(3)
    await press(env, env.state.items[3], ctrlL(env.cards.get(3)))
    assert.equal(env.container.scrollTop, 950) // center of row 3
    assert.equal(env.focusedIds[env.focusedIds.length - 1], 3)
})

test("Ctrl+L never reuses a stale keyboard focus id across categories", async () => {
    const env = makeHarness({
        feedId: "A",
        iids: [1, 2, 3],
        offsets: { 1: 1000 },
    })
    await press(env, env.state.items[1], ctrlL(env.cards.get(1)))
    assert.equal(env.focusedIds[0], 1)

    env.state.feeds.B = {
        _id: "B",
        iids: [11, 12, 13],
        sids: [2],
        allLoaded: true,
        loading: false,
        loaded: true,
    }
    env.state.items[11] = { _id: 11, hasRead: false, source: 2 }
    env.state.page.feedId = "B"
    env.addCard(11)
    env.cards.get(11).getBoundingClientRect = () => {
        const top = 2000 - env.container.scrollTop + 32
        return { top, bottom: top + 100, height: 100 }
    }
    // activeElement is still the old feed's card (data-iid 1, not in B).
    assert.equal(env.document.activeElement.id, 1)

    await press(env, env.state.items[11], ctrlL(env.cards.get(11)))
    assert.equal(env.focusedIds[env.focusedIds.length - 1], 11)
    assert.equal(env.container.scrollTop, 1750) // center of row 11 at 2000
})

test("unread filter + lazy load focuses the first newly appended row", async () => {
    const env = makeHarness({
        iids: [1, 2],
        itemIds: [1, 2, 3, 4],
        allLoaded: false,
        unreadFilter: true,
        rendered: [1, 2, 3, 4],
        offsets: { 1: 1000, 2: 1100, 3: 1200, 4: 1300 },
        onLoadMore: env => {
            env.state.feeds.ALL.iids = [1, 3, 4]
        },
    })
    const item2 = env.state.items[2]
    await press(env, item2, keyEvent({ target: cardTarget(env.cards.get(2)) }))
    await settle()
    assert.equal(env.loadMoreCalls, 1)
    assert.equal(env.document.activeElement.id, 3)
    assert.deepEqual(env.state.feeds.ALL.iids, [1, 3, 4])
})

test("non-filtered lazy load still advances to the next existing row", async () => {
    const env = makeHarness({
        iids: [1, 2],
        itemIds: [1, 2, 3, 4],
        allLoaded: false,
        rendered: [1, 2, 3, 4],
        offsets: { 1: 1000, 2: 1100, 3: 1200, 4: 1300 },
        onLoadMore: env => {
            env.state.feeds.ALL.iids = [1, 2, 3, 4]
        },
    })
    const item2 = env.state.items[2]
    await press(env, item2, keyEvent({ target: cardTarget(env.cards.get(2)) }))
    await settle()
    assert.equal(env.loadMoreCalls, 1)
    assert.equal(env.document.activeElement.id, 3)
})

test("a pending focus retry is cancelled when settings open", async () => {
    const env = makeHarness({
        iids: [1, 2],
        rendered: [1],
        offsets: { 1: 1000 },
    })
    await press(
        env,
        env.state.items[1],
        keyEvent({ target: cardTarget(env.cards.get(1)) })
    )
    await settle()
    assert.ok(env.rafQueue.length >= 1)
    env.state.app.settings.display = true
    env.flushRaf()
    await settle()
    assert.equal(env.document.activeElement, null)
    assert.equal(env.container.scrollTop, 0)
    assert.deepEqual(env.focusedIds, [])
})

test("a pending focus retry is cancelled when the category changes", async () => {
    const env = makeHarness({
        iids: [1, 2],
        rendered: [1],
        offsets: { 1: 1000 },
    })
    await press(
        env,
        env.state.items[1],
        keyEvent({ target: cardTarget(env.cards.get(1)) })
    )
    await settle()
    assert.ok(env.rafQueue.length >= 1)
    env.state.feeds.OTHER = {
        _id: "OTHER",
        iids: [7, 8],
        sids: [2],
        allLoaded: true,
        loading: false,
        loaded: true,
    }
    env.state.page.feedId = "OTHER"
    env.flushRaf()
    await settle()
    assert.equal(env.document.activeElement, null)
    assert.equal(env.container.scrollTop, 0)
    assert.deepEqual(env.focusedIds, [])
})

test("Shift+R marks once and captures the category sids at press time", async () => {
    const env = makeHarness({
        feedId: "A",
        iids: [1],
        sids: [1],
        extraFeeds: {
            B: {
                _id: "B",
                iids: [2],
                sids: [2],
                allLoaded: true,
                loading: false,
                loaded: true,
            },
        },
    })
    const tracker = new env.kb.HeldKeyTracker()
    let marks = 0
    let captured = null
    const down = e => {
        if (
            env.kb.getGlobalShortcutAction(e, env.state.app) ===
                "markAllRead" &&
            !tracker.has(e)
        ) {
            tracker.add(e)
            marks += 1
            captured = [...env.state.feeds[env.state.page.feedId].sids]
        }
    }
    down(shiftR())
    down(shiftR())
    assert.equal(marks, 1)

    const pending = env.dispatch(env.itemMod.markAllRead(captured))
    env.state.page.feedId = "B"
    await pending
    assert.deepEqual(env.markAllSids, [1])
    assert.equal(env.inArrayCalls.length, 1)
})

test("held r advances one row per repeat without coalescing", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const env = makeHarness({ iids: ids, itemIds: ids })
    const item1 = env.state.items[1]
    const target = cardTarget(env.cards.get(1))
    for (let i = 0; i < 7; i += 1) {
        await press(env, item1, keyEvent({ target, repeat: i > 0 }))
    }
    await env.itemMod.whenMarkReadQueueIdle()
    for (let id = 1; id <= 7; id += 1) {
        assert.equal(
            env.state.items[id].hasRead,
            true,
            `row ${id} must be read`
        )
    }
    assert.equal(env.state.items[8].hasRead, false, "landing row stays unread")
    assert.equal(env.document.activeElement.id, 8)
    assert.deepEqual(env.focusedIds, [2, 3, 4, 5, 6, 7, 8])
})

test("inert contexts never mark, focus or scroll", async () => {
    const env = makeHarness({ iids: [1, 2] })
    const item = env.state.items[1]
    const card = env.cards.get(1)
    const cases = [
        keyEvent({ target: cardTarget(card), isComposing: true }),
        keyEvent({ target: { tagName: "INPUT", closest: () => null } }),
        keyEvent({ target: cardTarget(card), metaKey: true }),
    ]
    for (const e of cases) await press(env, item, e)
    env.state.app.settings.display = true
    await press(env, item, keyEvent({ target: cardTarget(card) }))
    env.state.app.settings.display = false
    env.state.app.contextMenu.type = 2
    await press(env, item, keyEvent({ target: cardTarget(card) }))
    env.state.app.contextMenu.type = 0
    env.document.activeElement = { tagName: "WEBVIEW" }
    await press(env, item, keyEvent({ target: cardTarget(card) }))

    // Ctrl+L outside a list card never scrolls.
    env.document.activeElement = null
    await press(
        env,
        item,
        keyEvent({
            key: "l",
            ctrlKey: true,
            target: { tagName: "DIV", closest: () => null },
        })
    )

    assert.equal(env.state.items[1].hasRead, false)
    assert.equal(env.container.scrollTop, 0)
    assert.deepEqual(env.focusedIds, [])
})

test("b in the open article opens it even while its webview has focus", async () => {
    const env = makeHarness({ iids: [1, 2] })
    const opened = []
    globalThis.window.utils.openExternal = (url, background) =>
        opened.push([url, background])
    env.state.items[1].link = "https://example.com/a"
    env.document.activeElement = { tagName: "WEBVIEW" }
    // Keys forwarded from the webview have no DOM target yet.
    await env.dispatch(
        env.itemMod.itemShortcuts(
            env.state.items[1],
            keyEvent({ key: "b" }),
            "article"
        )
    )
    await settle()
    assert.deepEqual(opened, [["https://example.com/a", false]])
    assert.equal(env.state.items[1].hasRead, true)
})

test("list keys stay inert inside the open article", async () => {
    const env = makeHarness({ iids: [1, 2] })
    const opened = []
    globalThis.window.utils.openExternal = url => opened.push(url)
    env.document.activeElement = { tagName: "WEBVIEW" }
    const item = env.state.items[1]
    const card = env.cards.get(1)
    // A list-card b is still ignored while the webview has focus.
    await press(env, item, keyEvent({ key: "b" }))
    // r/p/n never act on the list from inside the article.
    for (const key of ["r", "n", "p"]) {
        await env.dispatch(
            env.itemMod.itemShortcuts(
                item,
                keyEvent({ key, target: cardTarget(card) }),
                "article"
            )
        )
    }
    await env.itemMod.whenMarkReadQueueIdle()
    env.flushRaf()
    await settle()
    assert.deepEqual(opened, [])
    assert.equal(env.state.items[1].hasRead, false)
    assert.deepEqual(env.focusedIds, [])
})
test("web mode paints the read state first and queues the write", async () => {
    const env = makeHarness({ iids: [1, 2] })
    env.web = true
    const item = env.state.items[1]
    // No network is available here at all: the optimistic dispatch must not
    // wait for one, and the request goes through the coalescing queue.
    await env.dispatch(env.itemMod.markRead(item))
    assert.equal(env.state.items[1].hasRead, true)
    assert.deepEqual(env.queuedReads, [{ id: 1, value: true }])
    assert.deepEqual(env.readBatches, [])
    await env.dispatch(env.itemMod.markUnread(env.state.items[1]))
    assert.equal(env.state.items[1].hasRead, false)
    assert.deepEqual(env.queuedReads, [
        { id: 1, value: true },
        { id: 1, value: false },
    ])
})

test("web mode marks a whole group read in one request", async () => {
    const env = makeHarness({ iids: [1, 2], sids: [7, 8] })
    env.web = true
    await env.dispatch(env.itemMod.markAllRead([7, 8]))
    assert.deepEqual(env.markedSources, [7, 8])
})

test("a focuses the open article's row without marking or scrolling", async () => {
    const env = makeHarness({ iids: [1, 2, 3], offsets: { 2: 1000 } })
    env.state.page.itemId = 2
    await env.dispatch(env.itemMod.focusArticleList(2))
    assert.equal(env.document.activeElement.id, 2)
    // Row 2 at 1000 is off screen with height 100 in a 600px viewport.
    assert.equal(env.container.scrollTop, 500)
    assert.deepEqual(env.focusedIds, [2])
    assert.equal(env.state.items[2].hasRead, false)
})

test("a leaves an already visible row and the scroll position untouched", async () => {
    const env = makeHarness({ iids: [1, 2, 3], offsets: { 2: 200 } })
    env.container.scrollTop = 0
    await env.dispatch(env.itemMod.focusArticleList(2))
    assert.equal(env.document.activeElement.id, 2)
    assert.equal(env.container.scrollTop, 0)
})

test("a falls back to the walk cursor, then to the first row", async () => {
    const env = makeHarness({ iids: [1, 2, 3] })
    env.document.activeElement = env.cards.get(3)
    await press(
        env,
        env.state.items[3],
        keyEvent({ key: "n", target: cardTarget(env.cards.get(3)) })
    )
    await settle()
    assert.equal(env.document.activeElement.id, 3)
    // No article open: the cursor row wins over the first row.
    await env.dispatch(env.itemMod.focusArticleList(null))
    assert.equal(env.document.activeElement.id, 3)
    // Cursor and DOM focus gone (category switch): the first row.
    env.document.activeElement = null
    env.itemMod.resetItemShortcutState()
    await env.dispatch(env.itemMod.focusArticleList(null))
    assert.equal(env.document.activeElement.id, 1)
})

test("a skips rows the current view no longer shows", async () => {
    const env = makeHarness({ iids: [10, 11] })
    await env.dispatch(env.itemMod.focusArticleList(99))
    assert.equal(env.document.activeElement.id, 10)
})

test("a waits for the article focus trap to unmount before focusing", async () => {
    const env = makeHarness({
        iids: [1, 2, 3],
        articleTrap: true,
        offsets: { 2: 1000 },
    })
    await env.dispatch(env.itemMod.focusArticleList(2))
    await settle()
    // The trap is still mounted: focusing now would be pulled back into it.
    assert.deepEqual(env.focusedIds, [])
    env.articleTrap = false
    env.flushRaf()
    await settle()
    assert.deepEqual(env.focusedIds, [2])
    assert.equal(env.container.scrollTop, 500)
})

test("a gives up after the trap never lifts", async () => {
    const env = makeHarness({ iids: [1, 2], articleTrap: true })
    const realNow = Date.now
    let clock = realNow()
    Date.now = () => clock
    try {
        await env.dispatch(env.itemMod.focusArticleList(1))
        await settle()
        for (let i = 0; i < 5; i += 1) {
            clock += 100
            env.flushRaf()
            await settle()
        }
        assert.deepEqual(
            env.focusedIds,
            [],
            "a trap that never unmounts must not steal focus from the article"
        )
    } finally {
        Date.now = realNow
    }
    // The row is still reachable once the trap finally goes away.
    env.articleTrap = false
    await env.dispatch(env.itemMod.focusArticleList(1))
    env.flushRaf()
    await settle()
    assert.equal(env.document.activeElement.id, 1)
})

test("a keeps the row focus is already on and only reveals it", async () => {
    const env = makeHarness({ iids: [1, 2, 3], offsets: { 2: 2000 } })
    env.document.activeElement = env.cards.get(2)
    await env.dispatch(env.itemMod.focusArticleList(1))
    assert.equal(env.document.activeElement.id, 2)
    assert.equal(env.container.scrollTop, 1500, "row 2 is revealed in place")
    assert.deepEqual(env.focusedIds, [], "no focus() on the row already focused")
})

test("a does nothing when the list has no rows", async () => {
    const env = makeHarness({ iids: [] })
    await env.dispatch(env.itemMod.focusArticleList(1))
    await settle()
    env.flushRaf()
    await settle()
    assert.deepEqual(env.focusedIds, [])
    assert.equal(env.container.scrollTop, 0)
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
