// Regression test for the first page: INIT_FEED replaces the visible order, so
// loadFeed() must not filter out rows the feed happens to list already. On a
// long-lived tab the feed keeps its old iids, and filtering there dropped the
// whole first page (the list visibly jumped to whatever offset came next).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")
globalThis.window = { settings: { getFilterType: () => null } }

function transpile(file, imports) {
    const code = ts.transpileModule(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
            },
        }
    ).outputText
    const module = { exports: {} }
    new Function("require", "module", "exports", code)(
        id => imports[id] || {},
        module,
        module.exports
    )
    return module.exports
}

const requests = []
const serverIds = Array.from({ length: 400 }, (_, i) => 400 - i)
const imports = {
    "../db": { database: {}, itemsTable: {} },
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
        RSSItem: class {},
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
        PageType: {},
        APPLY_FILTER: "APPLY_FILTER",
    },
    "./net/read-queue": {
        flushReadQueue: () => Promise.resolve(),
        queueReadState: () => {},
    },
    "./net/bff": {
        isWeb: () => true,
        fetchItems(query) {
            requests.push(query)
            const page = serverIds.slice(
                query.offset,
                query.offset + query.limit
            )
            return Promise.resolve({
                items: page.map(id => ({
                    _id: id,
                    source: 1,
                    title: `item ${id}`,
                    link: "",
                    date: id * 1000,
                    thumb: null,
                    snippet: "",
                    creator: null,
                    hasRead: false,
                    starred: false,
                    ref: String(id),
                })),
                next:
                    query.offset + page.length >= serverIds.length
                        ? null
                        : query.offset + page.length,
            })
        },
    },
}

const mod = transpile("src/scripts/models/feed.ts", imports)

async function main() {
    const filter = new mod.FeedFilter(1 << 1) // UnreadOnly
    // A tab that already loaded a page: the same 50 rows are still listed.
    const stale = serverIds.slice(0, 50)
    const feed = new mod.RSSFeed(mod.ALL, [1], filter)
    feed.loaded = true
    feed.iids = [...stale]

    const page = await mod.RSSFeed.loadFeed(feed, 0)
    assert.equal(
        page.items.length,
        50,
        `the first page must be complete, got ${page.items.length}`
    )
    assert.deepEqual(
        page.items.map(i => i._id),
        serverIds.slice(0, 50),
        "the first page starts at the newest row"
    )

    // Load more does skip rows already listed, so an overlapping server page
    // still yields fresh rows: offset 45 overlaps the 50 rows already shown.
    const appended = await mod.RSSFeed.loadFeed(feed, 45, { skipKnown: true })
    const appendedIds = appended.items.map(i => i._id)
    for (const id of appendedIds) {
        assert.ok(!stale.includes(id), `load more re-sent id ${id}`)
    }
    assert.deepEqual(
        appendedIds,
        serverIds.slice(50, 100),
        "the overlapping page is trimmed so the appended rows continue the list"
    )
    console.log(
        `PASS first page complete (${page.items.length} rows); ` +
            `load more skipped ${
                100 - 45 - appendedIds.length
            } already-listed rows`
    )
}

main().catch(err => {
    console.error("FAIL:", err && err.message ? err.message : err)
    process.exit(1)
})
