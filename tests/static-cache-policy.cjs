// Cross-checks the static cache policy against the CDN that fronts this site.
//
// Cloudflare's "Browser Cache TTL" zone setting (14400s on pilrymage.com) does
// not merely cap the browser cache: when a response carries no `private` it
// REWRITES `no-cache` into `max-age=14400` and then caches the file at the edge.
// Measured on 2026-11-18 with one session cookie, only the response header
// varying:
//
//   private, max-age=31536000, immutable  -> cf-cache-status: BYPASS (untouched)
//   no-cache, must-revalidate             -> max-age=14400, cf: MISS/EXPIRED
//
// So a deploy of an unhashed asset (styles/*.css, article/*, index.css) would
// keep serving the previous build for up to four hours. `private` is the switch
// that makes the edge bypass; `no-cache` alone is not enough. This test loads
// the real handler, so the rule cannot regress silently.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")

function loadApi() {
    const source = fs.readFileSync(path.join(ROOT, "server/src/api.ts"), "utf8")
    const code = ts.transpileModule(source, {
        fileName: "api.ts",
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText
    const module = { exports: {} }
    // api.ts pulls the SQLite helpers in at module scope; the static-file path
    // under test never touches them, so a stub keeps this a pure unit test.
    const stub = id => {
        if (id.endsWith("/db.ts") || id === "./db.ts")
            return { upsertSource: () => 0 }
        return require(id)
    }
    new Function("require", "module", "exports", code)(
        stub,
        module,
        module.exports
    )
    return module.exports
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// A scratch root shaped like the deployed webRoot + staticRoot pair.
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-static-"))
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html>")
    fs.writeFileSync(path.join(root, "index.css"), "/* unhashed */")
    fs.writeFileSync(path.join(root, "main.c75b7003.js"), "// hashed bundle")
    fs.writeFileSync(path.join(root, "main.abc123.js"), "// short suffix")
    fs.writeFileSync(path.join(root, "griffel.1e32a3c7.css"), "/* hashed */")
    fs.mkdirSync(path.join(root, "styles"))
    fs.writeFileSync(path.join(root, "styles", "feeds.css"), "/* unhashed */")
    fs.mkdirSync(path.join(root, "article"))
    fs.writeFileSync(
        path.join(root, "article", "mercury.web.js"),
        "// unhashed"
    )
    return root
}

// Minimal ServerResponse capture: serveStatic only writes head + end.
function capture() {
    return {
        statusCode: 0,
        headers: {},
        body: null,
        writeHead(status, headers) {
            this.statusCode = status
            this.headers = headers
            return this
        },
        end(body) {
            this.body = body
        },
    }
}

const config = webRoot => ({
    backend: "local",
    minifluxUrl: "",
    minifluxToken: "",
    minifluxTimeoutMs: 0,
    port: 0,
    host: "127.0.0.1",
    token: "DUMMY",
    dbFile: path.join(webRoot, "unused.db"),
    migrationsDir: webRoot,
    webRoot,
    staticRoot: webRoot,
    refreshIntervalMs: 0,
    concurrency: 1,
    fetchTimeoutMs: 0,
    corsOrigin: "*",
})

let serveStatic
let root

async function serve(pathname) {
    const res = capture()
    const ok = await serveStatic(pathname, res, config(root))
    return { ok, res, cc: res.headers["cache-control"] ?? "" }
}

test("a hashed bundle is immutable and private", async () => {
    const { ok, cc } = await serve("/main.c75b7003.js")
    assert.equal(ok, true)
    assert.match(cc, /private/, "hashed bundle must stay private")
    assert.match(cc, /immutable/, "hashed bundle must be immutable")
    assert.match(cc, /max-age=31536000/)
})

// The regression that caused a four-hour stale deploy on 2026-11-18.
test("unhashed assets are private, not just no-cache", async () => {
    for (const p of [
        "/styles/feeds.css",
        "/article/mercury.web.js",
        "/index.css",
        "/index.html",
    ]) {
        const { ok, cc } = await serve(p)
        assert.equal(ok, true, p + " must be served")
        assert.match(
            cc,
            /private/,
            p +
                " must send `private`; a bare no-cache is rewritten by " +
                "Cloudflare's Browser Cache TTL into max-age=14400"
        )
        assert.match(cc, /no-cache/, p + " must still revalidate")
    }
})

test("the unhashed branch never carries a positive max-age", async () => {
    for (const p of ["/styles/feeds.css", "/index.css", "/index.html"]) {
        const { cc } = await serve(p)
        assert.doesNotMatch(
            cc,
            /max-age=[1-9]/,
            p +
                ": a positive max-age would let the edge and the browser " +
                "serve the previous build after a deploy"
        )
    }
})

test("hash detection only fires on a real content hash", async () => {
    const short = await serve("/main.abc123.js")
    assert.doesNotMatch(
        short.cc,
        /immutable/,
        "a 6-char suffix is not a content hash"
    )
    assert.match(short.cc, /no-cache/, "a short suffix must revalidate")
})

test("path traversal stays rejected", async () => {
    const { ok } = await serve("/../../etc/passwd")
    assert.equal(ok, false)
})

test("a missing file reports not-served so the caller can 404", async () => {
    const { ok, res } = await serve("/styles/nope.css")
    assert.equal(ok, false)
    assert.equal(res.statusCode, 0, "nothing must be written for a miss")
})
;(async () => {
    const api = loadApi()
    serveStatic = api.serveStatic
    assert.equal(
        typeof serveStatic,
        "function",
        "api.ts must export serveStatic so this policy is testable"
    )
    root = fixture()
    let failures = 0
    for (const [name, fn] of tests) {
        try {
            await fn()
            console.log("PASS " + name)
        } catch (err) {
            failures += 1
            console.log("FAIL " + name + ": " + err.message)
        }
    }
    fs.rmSync(root, { recursive: true, force: true })
    console.log("FAILURES " + failures)
    process.exit(failures ? 1 : 0)
})().catch(err => {
    console.error(err)
    process.exit(1)
})
