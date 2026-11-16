import http from "node:http"

// Minimal Miniflux stand-in for end-to-end tests of the reader-server contract.
// It records every mutating call so a test can assert the read/star write-through.

const calls = []
const feeds = [
    {
        id: 1,
        title: "Feed One",
        feed_url: "https://one.example/rss",
        site_url: "https://one.example",
        icon: { icon_id: 7 },
    },
    {
        id: 2,
        title: "Feed Two",
        feed_url: "http://127.0.0.1:18082/rss/abc",
        site_url: "https://two.example",
        icon: null,
    },
]

const entries = [
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
        return send(200, {
            unread: { "1": 1, "2": 1 },
            read: { "1": 1, "2": 0 },
        })
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
        let rows = entries
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
        calls.push({ method: "setStatus", body: JSON.parse(body) })
        res.writeHead(204).end()
        return
    }
    if (
        /^\/v1\/entries\/\d+\/bookmark$/.test(url.pathname) &&
        req.method === "PUT"
    ) {
        calls.push({ method: "bookmark", path: url.pathname })
        res.writeHead(204).end()
        return
    }
    if (url.pathname === "/__calls") return send(200, calls)

    send(404, { error: "not found", path: url.pathname })
})

const port = Number(process.argv[2] ?? 17555)
server.listen(port, "127.0.0.1", () => console.log(`stub miniflux on ${port}`))
