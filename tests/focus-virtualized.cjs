// Regression test for focus over a *virtualized* list.
//
// The feed renders with office-ui-fabric's List, which only materializes pages
// near the viewport. A row appended by "load more" therefore has no DOM node
// until the container scrolls toward it. focusCardWhenReady() used to wait
// passively for that node to appear, which never happens, and every further
// keypress re-anchored on the old card: the cursor looked stuck in a loop and
// could not reach the rows below.
//
// This harness reproduces the rendering rule: querySelector('[data-iid="N"]')
// only answers within the rendered window, and the window follows scrollTop.
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

const ROWS = 120
const ROW_HEIGHT = 60
const VIEWPORT = 300
const WINDOW_ROWS = VIEWPORT / ROW_HEIGHT
// Rows per "load more" page.
const PAGE = 30

const rafQueue = []
globalThis.requestAnimationFrame = callback => {
    rafQueue.push(callback)
    return rafQueue.length
}
globalThis.setTimeout = fn => {
    rafQueue.push(fn)
    return rafQueue.length
}
function flushFrames(rounds = 60) {
    for (let i = 0; i < rounds; i += 1) {
        const pending = rafQueue.splice(0)
        if (pending.length === 0) return
        for (const callback of pending) callback(0)
    }
}

// Virtualized container: `rendered` is derived from scrollTop on demand.
const container = {
    id: "refocus",
    _scrollTop: 0,
    // The list's scroll height follows the rows it actually holds, not the
    // server total: that is what makes the ratio estimate meaningful.
    scrollHeight: PAGE * ROW_HEIGHT,
    clientHeight: VIEWPORT,
    offsetHeight: VIEWPORT,
    get scrollTop() {
        return this._scrollTop
    },
    set scrollTop(value) {
        const max = this.scrollHeight - this.clientHeight
        this._scrollTop = Math.max(0, Math.min(max, value))
        rendered.clear()
        for (const id of idsInWindow()) rendered.add(id)
    },
    getBoundingClientRect: () => ({
        top: 0,
        bottom: VIEWPORT,
        height: VIEWPORT,
    }),
}
const rendered = new Set()
const idsInWindow = () => {
    const first = Math.max(0, Math.floor(container._scrollTop / ROW_HEIGHT))
    const last = Math.min(ROWS - 1, first + Math.ceil(WINDOW_ROWS) - 1)
    const out = []
    for (let index = first; index <= last; index += 1) out.push(index + 1)
    return out
}
for (const id of idsInWindow()) rendered.add(id)

// Cards exist as objects for every row, but only rendered rows are queryable —
// exactly what the virtualized List does to the DOM.
const cards = new Map()
function cardFor(id) {
    if (!cards.has(id)) {
        cards.set(id, {
            tagName: "DIV",
            isContentEditable: false,
            attrs: { "data-iid": String(id) },
            closest(selector) {
                return /list-card|compact-card|magazine-card|default-card/.test(
                    selector
                )
                    ? this
                    : null
            },
            getAttribute(name) {
                return name in this.attrs ? this.attrs[name] : null
            },
            hasAttribute(name) {
                return name in this.attrs
            },
            setAttribute(name, value) {
                this.attrs[name] = value
            },
            focus() {
                document.activeElement = this
                focused.push(id)
            },
            getBoundingClientRect() {
                const top = (id - 1) * ROW_HEIGHT - container.scrollTop
                return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT }
            },
        })
    }
    return cards.get(id)
}

const document = {
    activeElement: null,
    documentElement: {},
    getElementById: id => (id === "refocus" ? container : null),
    querySelector(selector) {
        if (selector === "nav") return null
        const match = /^\[data-iid="(\d+)"\]$/.exec(selector)
        if (!match) return null
        const id = Number(match[1])
        // The virtualizer keeps rendered nodes; everything else is absent.
        if (!rendered.has(id)) return null
        return cardFor(id)
    },
    addEventListener() {},
    removeEventListener() {},
}
globalThis.document = document
globalThis.window = {
    innerWidth: 1200,
    settings: { getFilterType: () => null },
    utils: { openExternal() {} },
}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" })

const focused = []
const items = {}
for (let id = 1; id <= ROWS; id += 1) {
    items[id] = { _id: id, hasRead: false, source: 1 }
}
// The feed starts with one page; the rest arrives through "load more".
const state = {
    page: { feedId: "ALL", itemId: null },
    feeds: {
        ALL: {
            _id: "ALL",
            iids: Array.from({ length: PAGE }, (_, i) => i + 1),
            sids: [1],
            allLoaded: false,
            loading: false,
            loaded: true,
        },
    },
    items,
    app: { settings: { display: false }, contextMenu: { type: 0 } },
    sources: { 1: { textDir: 0 } },
    rules: {},
    groups: {},
}
const dispatch = action => {
    if (typeof action === "function") return action(dispatch, () => state)
    if (!action) return action
    if (action.type === "MARK_READ") {
        const item = state.items[action.item._id]
        if (item) item.hasRead = true
    }
    return action
}

const kb = transpile("src/scripts/keyboard.ts", {})
const itemMod = transpile("src/scripts/models/item.ts", {
    "../keyboard": kb,
    "../db": {
        database: {
            update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        },
        itemsTable: {},
    },
    "drizzle-orm": {
        eq: () => ({}),
        and: () => ({}),
        inArray: () => ({}),
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
        loadMore: feed => async (dispatch, getState) => {
            // "Load more" appends the next page: the rows exist in the feed and
            // in the container immediately, but the virtualizer does not create
            // their DOM nodes until the container scrolls toward them.
            const appended = []
            for (
                let id = feed.iids.length + 1;
                id <= feed.iids.length + PAGE;
                id += 1
            ) {
                if (id > ROWS) break
                appended.push(id)
            }
            const next = [...feed.iids, ...appended]
            state.feeds.ALL = {
                ...feed,
                iids: next,
                loading: false,
                allLoaded: next.length >= ROWS,
            }
            container.scrollHeight = next.length * ROW_HEIGHT
            for (const id of appended)
                items[id] = { _id: id, hasRead: false, source: 1 }
            return {
                items: appended,
                next: next.length >= ROWS ? null : next.length,
                carry: [],
                allLoaded: next.length >= ROWS,
            }
        },
    },
    "./app": {
        pushNotification: () => ({ type: "PUSH" }),
        setupAutoFetch: () => ({ type: "AUTO" }),
        SettingsActionTypes: {},
        FREE_MEMORY: "FREE_MEMORY",
    },
    "./net/bff": {
        isWeb: () => false,
        markSourcesRead: () => Promise.resolve(),
        setReadBatch: () => Promise.resolve(),
        setStar: () => Promise.resolve(),
        fetchItemDetail: () => Promise.resolve(null),
        fetchItems: () => Promise.resolve({ items: [], next: null }),
    },
    "./net/read-queue": { queueReadState: () => {} },
})

function keyEvent(id) {
    const card = cardFor(id)
    return {
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
        target: {
            tagName: "DIV",
            isContentEditable: false,
            closest: selector =>
                /list-card|compact-card|magazine-card|default-card/.test(
                    selector
                )
                    ? card
                    : null,
        },
    }
}

async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i += 1) {
        await Promise.resolve()
        flushFrames(20)
        await Promise.resolve()
    }
}

// Second scenario: focus never lands at all (the target row is never rendered,
// e.g. the container cannot scroll). This is the "cursor stuck in a loop"
// report: every press must still advance the logical cursor instead of
// re-anchoring on the stale card and recomputing the same target.
async function stuckScenario() {
    const realQuery = document.querySelector.bind(document)
    document.querySelector = selector => {
        const match = /^\[data-iid="(\d+)"\]$/.exec(selector)
        // Rows past the initially rendered window never exist: no scroll can
        // reveal them, so the focus attempt always fails.
        if (match && Number(match[1]) > WINDOW_ROWS) return null
        return realQuery(selector)
    }
    // Start the scenario from a clean slate: the first scenario marked rows read
    // and left the walk cursor past the end of the shorter feed.
    itemMod.resetItemShortcutState()
    for (const item of Object.values(state.items)) item.hasRead = false
    document.activeElement = cardFor(1)
    state.feeds.ALL = {
        ...state.feeds.ALL,
        iids: Array.from({ length: PAGE }, (_, i) => i + 1),
        allLoaded: true,
    }
    const advances = []
    let current = 1
    for (let i = 0; i < 10; i += 1) {
        await dispatch(
            itemMod.itemShortcuts(state.items[current], keyEvent(current))
        )
        await settle()
        const marked = Object.values(state.items).filter(
            item => item.hasRead
        ).length
        advances.push(marked)
    }
    document.querySelector = realQuery
    const distinctMarks = new Set(advances)
    console.log(`rows marked read over 10 presses: ${advances.join(",")}`)
    assert.ok(
        advances[advances.length - 1] >= 10,
        `each press must still consume a row even when focus cannot land (marked ${
            advances[advances.length - 1]
        })`
    )
    assert.equal(
        distinctMarks.size,
        advances.length,
        "every press must advance, not repeat the same row"
    )
    console.log("PASS stuck-focus presses keep advancing the cursor")
}

async function main() {
    document.activeElement = cardFor(1)
    let current = 1
    const trail = [current]
    const PRESSES = PAGE + 15
    for (let i = 0; i < PRESSES; i += 1) {
        const event = keyEvent(current)
        await dispatch(itemMod.itemShortcuts(state.items[current], event))
        await settle()
        const activeId = Number(document.activeElement.getAttribute("data-iid"))
        if (activeId !== current) {
            current = activeId
            trail.push(current)
        }
    }
    console.log(`focus trail: ${trail.join(" -> ")}`)
    console.log(
        `scrollTop after walk: ${container.scrollTop}, feed rows: ${state.feeds.ALL.iids.length}`
    )
    assert.ok(
        Math.max(...trail) > WINDOW_ROWS + 2,
        `focus must pass the initial rendered window (reached ${Math.max(
            ...trail
        )}, window was ${WINDOW_ROWS} rows)`
    )
    // The real complaint: after "load more" the cursor sat in a loop and could
    // not reach the rows that were just appended.
    assert.ok(
        state.feeds.ALL.iids.length > PAGE,
        "the walk must have triggered load more"
    )
    assert.ok(
        Math.max(...trail) > PAGE,
        `focus must reach rows appended by load more (last page is ${PAGE} rows, focus reached ${Math.max(
            ...trail
        )})`
    )
    assert.deepEqual(
        trail,
        [...trail].sort((a, b) => a - b),
        "focus must never move backwards"
    )
    assert.ok(container.scrollTop > 0, "the container must have scrolled")
    console.log(
        `PASS virtualized focus advanced ${trail.length} rows to ${Math.max(
            ...trail
        )}, across the load-more seam at ${PAGE}`
    )
    await stuckScenario()
}

main().catch(err => {
    console.error("FAIL:", err && err.message ? err.message : err)
    process.exit(1)
})
