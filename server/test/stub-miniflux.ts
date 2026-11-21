import http from "node:http"

// Minimal Miniflux stand-in for tests of the reader-server contract. Unlike a
// plain recorder it MUTATES entry state like the real thing — PUT /v1/entries
// flips statuses — so paging and draining loops can be exercised end to end.
// Every mutating call is still recorded on /__calls for assertions.

const calls: { method: string; body?: unknown }[] = []

const feeds = [
    {
        id: 1,
        title: "Feed One",
        feed_url: "https://one.example/rss",
        site_url: "https://one.example",
        icon: { icon_id: 7 },
        category: { id: 11, title: "中文" },
    },
    {
        id: 2,
        title: "Feed Two",
        feed_url: "http://127.0.0.1:18082/rss/abc",
        site_url: "https://two.example",
        icon: null,
        category: { id: 12, title: "外文" },
    },
    {
        id: 3,
        title: "Feed Three",
        feed_url: "https://three.example/rss",
        site_url: "https://three.example",
        icon: null,
        category: { id: 12, title: "外文" },
    },
]

interface StubEntry {
    id: number
    feed_id: number
    title: string
    url: string
    published_at: string
    content: string
    author: string
    status: string
    starred: boolean
}

const entries: StubEntry[] = [
    {
        id: 101,
        feed_id: 1,
        title: "First 文章",
        url: "https://one.example/a",
        published_at: "2026-11-14T02:00:00Z",
        content: '<p>Hello <img src="https://one.example/i.png"> world</p>',
        author: "Alice",
        status: "unread",
        starred: false,
    },
    {
        id: 102,
        feed_id: 1,
        title: "Second",
        url: "https://one.example/b",
        published_at: "2026-11-13T02:00:00Z",
        content: "<p>Body two</p>",
        author: "",
        status: "read",
        starred: true,
    },
    {
        id: 201,
        feed_id: 2,
        title: "Bilingual entry",
        url: "https://two.example/c",
        published_at: "2026-11-12T02:00:00Z",
        content: "<p>双语句子</p>",
        author: "Bob",
        status: "unread",
        starred: false,
    },
]
// A backlog larger than one page, so draining loops must page to finish.
for (let i = 0; i < 250; i += 1) {
    entries.push({
        id: 300 + i,
        feed_id: 3,
        title: `Article ${i + 1}`,
        url: `https://three.example/a/${i + 1}`,
        published_at: "2026-11-10T02:00:00Z",
        content: "<p>Body</p>",
        author: "",
        status: "unread",
        starred: false,
    })
}

// Miniflux names these "reads"/"unreads"; the BFF reads .unreads.
function counters() {
    const reads: Record<string, number> = {}
    const unreads: Record<string, number> = {}
    for (const entry of entries) {
        const map = entry.status === "unread" ? unreads : reads
        const key = String(entry.feed_id)
        map[key] = (map[key] ?? 0) + 1
    }
    return { reads, unreads }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
    }

    if (req.headers["x-auth-token"] !== "test-token")
        return send(401, { error: "unauthorized" })

    if (url.pathname === "/v1/feeds" && req.method === "GET")
        return send(200, feeds)
    if (url.pathname === "/v1/feeds/counters") {
        return send(200, counters())
    }
    if (url.pathname === "/v1/feeds/refresh" && req.method === "PUT") {
        calls.push({ method: "refresh" })
        res.writeHead(204).end()
        return
    }
    if (/^\/v1\/feeds\/\d+\/icon$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "image/png" })
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        return
    }
    if (url.pathname === "/v1/entries" && req.method === "GET") {
        const feedId = url.searchParams.get("feed_id")
        const status = url.searchParams.get("status")
        const starred = url.searchParams.get("starred")
        const offset = Number(url.searchParams.get("offset") ?? 0)
        const limit = Number(url.searchParams.get("limit") ?? 50)
        let rows: StubEntry[] = entries
        if (feedId) rows = rows.filter(e => e.feed_id === Number(feedId))
        if (status) rows = rows.filter(e => e.status === status)
        if (starred) rows = rows.filter(e => e.starred)
        return send(200, {
            total: rows.length,
            entries: rows.slice(offset, offset + limit),
        })
    }
    if (url.pathname === "/v1/entries" && req.method === "PUT") {
        let body = ""
        for await (const chunk of req) body += chunk
        const payload = JSON.parse(body)
        calls.push({ method: "setStatus", body: payload })
        for (const entry of entries) {
            if (payload.entry_ids.includes(entry.id))
                entry.status = payload.status
        }
        res.writeHead(204).end()
        return
    }
    if (
        /^\/v1\/entries\/\d+\/bookmark$/.test(url.pathname) &&
        req.method === "PUT"
    ) {
        calls.push({ method: "bookmark", path: url.pathname })
        const id = Number(url.pathname.split("/")[3])
        for (const entry of entries) {
            if (entry.id === id) entry.starred = !entry.starred
        }
        res.writeHead(204).end()
        return
    }
    if (url.pathname === "/__calls") return send(200, calls)

    send(404, { error: "not found", path: url.pathname })
})

const port = Number(process.argv[2] ?? 0)
server.listen(port, "127.0.0.1", () => {
    const address = server.address()
    const actual = typeof address === "object" && address ? address.port : port
    console.log(`stub miniflux on ${actual}`)
})
