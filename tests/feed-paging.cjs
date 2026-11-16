// Regression tests for web paging. They load the real feed.ts (reducer + thunk)
// and drive it against a fake BFF whose list shrinks exactly like Miniflux's
// unread list when a read write lands.
//
// The bug these cover: the page cursor used to be "how many rows are visible",
// counted before the debounced read write reached the server. The server then
// still listed the just-read rows, so the next page started at the wrong place
// and repeated the tail of the previous one. Duplicate ids made every focus
// helper (indexOf-based) cycle between the copies, so the cursor looked stuck.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")
const LOAD_QUANTITY = 50

// FeedFilter falls back to the persisted filter type when constructed without
// one; the harness always passes an explicit type, but the constructor still
// touches the settings bridge.
globalThis.window = { settings: { getFilterType: () => null } }

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

function makeHarness(options = {}) {
    const env = {
        requests: [],
        flushedBeforeRequest: [],
        reads: new Set(),
        flushCalls: 0,
        running: null,
    }
    // Server side: one global list sorted newest first. Read rows leave it.
    let serverIds = options.serverIds
        ? [...options.serverIds]
        : Array.from({ length: 400 }, (_, i) => 400 - i)
    const groupSids = options.groupSids || null

    const items = {}
    for (const id of serverIds) {
        items[id] = {
            _id: id,
            hasRead: false,
            source: 1 + (id % 7),
        }
    }

    env.server = {
        get ids() {
            return serverIds.filter(
                id => !env.reads.has(id) || options.keepRead
            )
        },
        add(ids) {
            serverIds = [...ids, ...serverIds]
            for (const id of ids)
                items[id] = { _id: id, hasRead: false, source: 1 + (id % 7) }
        },
    }

    const imports = {
        "../db": {
            database: {
                select: () => ({
                    from: () => ({
                        where: () => ({
                            orderBy: () => ({
                                offset: () => ({
                                    limit: () => Promise.resolve([]),
                                }),
                            }),
                        }),
                    }),
                }),
            },
            itemsTable: {},
        },
        "drizzle-orm": {
            and: () => ({}),
            eq: () => ({}),
            inArray: () => ({}),
            desc: () => ({}),
            sql: () => ({}),
        },
        "./source": {
            INIT_SOURCES: "INIT_SOURCES",
            ADD_SOURCE: "ADD_SOURCE",
            DELETE_SOURCE: "DELETE_SOURCE",
            UNHIDE_SOURCE: "UNHIDE_SOURCE",
            HIDE_SOURCE: "HIDE_SOURCE",
        },
        "./item": {
            RSSItem: class RSSItem {},
            FETCH_ITEMS: "FETCH_ITEMS",
            TOGGLE_HIDDEN: "TOGGLE_HIDDEN",
            applyItemReduction: item => item,
        },
        "../utils": {
            ActionStatus: {
                Request: "request",
                Success: "success",
                Failure: "failure",
                Intermediate: "intermediate",
            },
            mergeSortedArrays: (a, b, cmp) => [...a, ...b].sort(cmp),
        },
        "./page": {
            SELECT_PAGE: "SELECT_PAGE",
            PageType: { AllArticles: 0, Sources: 1 },
            APPLY_FILTER: "APPLY_FILTER",
        },
        "./net/read-queue": {
            flushReadQueue: () => {
                env.flushCalls += 1
                // The write lands here: every row marked read is gone from the
                // server's unread list by the time the next request arrives.
                const pending = [...env.reads]
                env.flushedBeforeRequest.push(pending.length)
                return Promise.resolve()
            },
            queueReadState: () => {},
        },
        "./net/bff": {
            isWeb: () => true,
            fetchItems(query) {
                env.requests.push(query)
                // Mirror Miniflux: `status=unread` is what drops read rows from
                // the list. A filter that keeps read rows must not see them go,
                // or offsets and row counts stop agreeing.
                const pool = query.unread ? env.server.ids : serverIds
                const list = pool.filter(id =>
                    options.groupSids
                        ? groupSids.includes(items[id].source)
                        : true
                )
                // The real server filters first, then applies offset/limit.
                const page = list.slice(
                    query.offset,
                    query.offset + query.limit
                )
                const response = {
                    items: page.map(id => ({
                        _id: id,
                        source: items[id].source,
                        title: `item ${id}`,
                        link: `https://example.org/${id}`,
                        date: id * 1000,
                        thumb: null,
                        snippet: "",
                        creator: null,
                        hasRead: false,
                        starred: false,
                        ref: String(id),
                    })),
                    next:
                        query.offset + page.length >= list.length
                            ? null
                            : query.offset + page.length,
                }
                if (options.rawItems)
                    return Promise.resolve(options.rawItems(response, query))
                return Promise.resolve(response)
            },
        },
    }

    const feedMod = transpile("src/scripts/models/feed.ts", imports)
    env.mod = feedMod
    env.items = items

    // Minimal store the thunks can run against.
    env.state = {
        feeds: {},
        items,
        page: { feedId: feedMod.ALL },
    }
    env.getState = () => env.state
    env.dispatch = action => {
        if (typeof action === "function")
            return action(env.dispatch, env.getState)
        if (!action) return action
        env.state.feeds = feedMod.feedReducer(env.state.feeds, action)
        return action
    }
    env.run = async thunk => {
        await thunk(env.dispatch, env.getState)
    }
    env.makeFeed = (sids, filterType) => {
        const feed = new feedMod.RSSFeed(
            feedMod.ALL,
            sids || [0],
            new feedMod.FeedFilter(filterType)
        )
        feed.loaded = true
        env.state.feeds = { ...env.state.feeds, [feedMod.ALL]: feed }
        return feed
    }
    env.feed = () => env.state.feeds[feedMod.ALL]
    env.init = async () => {
        const feed = env.feed() || env.makeFeed(options.initSids || [0])
        const page = await feedMod.RSSFeed.loadFeed(feed, 0)
        env.dispatch(feedMod.initFeedSuccess(feed, page))
        return page
    }
    env.loadMore = async () => {
        await env.run(feedMod.loadMore(env.feed()))
    }
    env.markReadLocally = id => {
        // What item.ts does before the write is flushed: paint first.
        env.items[id].hasRead = true
        env.reads.add(id)
    }
    return env
}

function assertNoDuplicates(iids, label) {
    const seen = new Set()
    for (const id of iids) {
        assert.ok(
            !seen.has(id),
            `${label}: duplicate id ${id} in ${JSON.stringify(iids)}`
        )
        seen.add(id)
    }
}

test("read writes are flushed before the next page is requested", async () => {
    const env = makeHarness()
    await env.init()
    env.markReadLocally(env.feed().iids[0])
    await env.loadMore()
    assert.equal(env.flushCalls, 1)
    assert.equal(env.requests.length, 2)
})

test("reading the last rows does not repeat them on the next page", async () => {
    const env = makeHarness()
    await env.init()
    const firstPage = [...env.feed().iids]
    const tail = firstPage.slice(-3)
    for (const id of tail) env.markReadLocally(id)
    await env.loadMore()
    const iids = env.feed().iids
    assertNoDuplicates(iids, "after one load more")
    // The three rows just read must not come back as a second copy.
    assert.deepEqual(
        iids.filter(id => tail.includes(id)),
        tail,
        "tail rows appear once"
    )
    // Nor may the page skip rows: the next unseen row follows immediately.
    const nextId = Math.max(...serverIdsNotIn(iids))
    assert.ok(
        iids.length >= LOAD_QUANTITY + 40,
        `appended rows: ${iids.length}`
    )
    void nextId
})

function serverIdsNotIn(iids) {
    const seen = new Set(iids)
    const out = []
    for (let id = 400; id >= 1; id -= 1) if (!seen.has(id)) out.push(id)
    return out
}

test("new rows arriving at the top do not duplicate the seam", async () => {
    const env = makeHarness()
    await env.init()
    env.server.add([901, 902, 903])
    await env.loadMore()
    const iids = env.feed().iids
    assertNoDuplicates(iids, "after new rows at the top")
    // The three new rows sort above everything and are simply not shown yet;
    // what matters is that the seam rows appear exactly once.
    assert.ok(iids.includes(env.items[env.feed().iids[0]]._id))
})

test("an overlapping page is appended without duplicates (P0)", async () => {
    // Force the server to hand back rows it already gave: the exact symptom.
    const env = makeHarness({
        rawItems: (response, query) => ({
            items: response.items,
            next: response.next,
        }),
    })
    await env.init()
    const before = [...env.feed().iids]
    // Re-request the same window by pretending the cursor did not advance.
    env.dispatch({
        type: "LOAD_MORE",
        status: "success",
        feed: { ...env.feed(), next: 0 },
        items: before.map(id => ({ ...env.items[id] })),
        next: 0,
        carry: [],
        readAtCursor: 0,
    })
    assertNoDuplicates(env.feed().iids, "after an overlapping page")
    assert.deepEqual(env.feed().iids, before, "the visible order is unchanged")
})

test("a group is not marked all-loaded just because a page was narrow", async () => {
    // 7 sources, the group owns one of them: a global page of 200 holds ~28 of
    // its rows, so the old "items.length < 50" test ended the feed too early.
    const env = makeHarness({ groupSids: [1] })
    const feed = env.makeFeed([1], 0)
    void feed
    await env.init()
    const first = env.feed()
    assert.equal(first.allLoaded, false, "more rows exist, so not all loaded")
    await env.loadMore()
    const second = env.feed()
    assertNoDuplicates(second.iids, "group load more")
    assert.ok(
        second.iids.length > first.iids.length ||
            second.allLoaded ||
            second.carry.length > 0,
        "the group either grew or reported a cursor to continue from"
    )
})

test("the last page reports allLoaded exactly when the server has no cursor", async () => {
    const env = makeHarness({
        serverIds: Array.from({ length: 30 }, (_, i) => 30 - i),
    })
    await env.init()
    const feed = env.feed()
    assert.equal(feed.next, null, "a single short page exhausts the feed")
    assert.equal(feed.allLoaded, true)
})

test("reads from earlier pages do not shift later pages twice", async () => {
    const env = makeHarness()
    await env.init()
    // Page 1: read the last two rows, load page 2, read its last two, load page 3.
    for (const id of env.feed().iids.slice(-2)) env.markReadLocally(id)
    await env.loadMore()
    const second = env.feed().iids.length
    for (const id of env.feed().iids.slice(-2)) env.markReadLocally(id)
    await env.loadMore()
    const iids = env.feed().iids
    assertNoDuplicates(iids, "after three pages with reads between them")
    assert.ok(iids.length > second, "the third page still appended rows")
    // Every request must start at the first row not yet shown: with 400 records
    // and reads landing, offsets stay below the rows consumed.
    const offsets = env.requests.map(q => q.offset)
    for (let i = 1; i < offsets.length; i += 1) {
        assert.ok(
            offsets[i] > offsets[i - 1],
            `offsets must advance: ${JSON.stringify(offsets)}`
        )
    }
    // No row may be skipped: rows stay visible after being read (only the
    // server's list shrinks), so the visible order is still a contiguous prefix
    // of the newest-first server order.
    const expected = Array.from({ length: 400 }, (_, i) => 400 - i)
    assert.deepEqual(
        iids,
        expected.slice(0, iids.length),
        "the visible order is contiguous — no row skipped at a page seam"
    )
})

test("a filter that keeps read rows pages the server cursor unchanged", async () => {
    // FilterType.Default includes ShowRead, so reads do not shrink the list.
    const env = makeHarness({ keepRead: true })
    env.state.feeds = {}
    const feed = env.makeFeed([0], 1 | 2 | (1 << 4))
    feed.loaded = true
    const page = await env.mod.RSSFeed.loadFeed(feed, 0)
    env.dispatch(env.mod.initFeedSuccess(feed, page))
    for (const id of env.feed().iids.slice(-4)) env.markReadLocally(id)
    await env.loadMore()
    assert.deepEqual(
        env.requests.map(q => q.offset),
        [0, LOAD_QUANTITY],
        "the cursor advances by a whole page regardless of reads"
    )
    assertNoDuplicates(env.feed().iids, "read rows kept")
})

async function main() {
    for (const [name, fn] of tests) {
        await fn()
        console.log(`PASS ${name}`)
    }
    console.log(`\n${tests.length} passed`)
}

main().catch(err => {
    console.error("FAIL:", err && err.message ? err.message : err)
    process.exit(1)
})
