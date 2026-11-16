// Headless probe for the browser build: verifies that source icons actually
// decode and that the Miniflux categories show up as menu groups.
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const PORT = 9333
const URL_TO_OPEN = process.argv[2]
// "authelia_session=<value>" — copied from a logged-in browser. The headless
// profile has no SSO session of its own, and <img> icons cannot carry a Bearer
// header, so the cookie is the only way to exercise them.
const SESSION_COOKIE = process.argv[3] || ""
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getJson(pathname) {
    const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`)
    if (!response.ok) throw new Error(`${pathname} -> ${response.status}`)
    return response.json()
}

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-probe-"))
    const edge = spawn(
        EDGE,
        [
            "--headless=new",
            `--remote-debugging-port=${PORT}`,
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--window-size=1400,900",
            "about:blank",
        ],
        { stdio: "ignore", detached: false }
    )

    let page = null
    for (let i = 0; i < 60 && !page; i += 1) {
        await sleep(500)
        try {
            const list = await getJson("/json/list")
            page = list.find(t => t.type === "page")
        } catch {
            // DevTools endpoint not up yet.
        }
    }
    if (!page) throw new Error("no page target")

    const socket = new WebSocket(page.webSocketDebuggerUrl)
    const pending = new Map()
    const logs = []
    let nextId = 1
    await new Promise((resolve, reject) => {
        socket.onopen = resolve
        socket.onerror = reject
    })
    socket.onmessage = event => {
        const message = JSON.parse(event.data)
        if (message.id && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id)
            pending.delete(message.id)
            if (message.error) reject(new Error(JSON.stringify(message.error)))
            else resolve(message.result)
            return
        }
        if (message.method === "Runtime.consoleAPICalled") {
            const text = (message.params.args ?? [])
                .map(a => a.value ?? a.description ?? a.type)
                .join(" ")
            logs.push(`${message.params.type}: ${text}`)
        }
        if (message.method === "Runtime.exceptionThrown") {
            logs.push(
                "exception: " +
                    (message.params.exceptionDetails?.exception?.description ??
                        message.params.exceptionDetails?.text)
            )
        }
    }
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = nextId++
            pending.set(id, { resolve, reject })
            socket.send(JSON.stringify({ id, method, params }))
        })

    await send("Runtime.enable")
    await send("Page.enable")

    // Icons are <img> tags: they carry the SSO cookie, never the bearer header.
    // The probe therefore has to start with an Authelia session, which the headless
    // profile cannot create on its own.
    if (SESSION_COOKIE) {
        const eq = SESSION_COOKIE.indexOf("=")
        if (eq < 0) throw new Error("cookie must be name=value")
        // Scope by URL, not by bare domain: a domain= entry without a leading
        // dot does not apply to subdomains, and the probe then bounces to SSO.
        const origin = new URL(URL_TO_OPEN).origin + "/"
        await send("Network.enable")
        await send("Network.setCookie", {
            name: SESSION_COOKIE.slice(0, eq),
            value: SESSION_COOKIE.slice(eq + 1),
            url: origin,
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
        })
        console.log(`COOKIE ${origin} seeded`)
    }

    await send("Page.navigate", { url: URL_TO_OPEN })
    await sleep(12000)

    const script = `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 40; i += 1) {
            const tree = document.querySelector('[role="tree"]');
            if (tree && tree.querySelectorAll('[role="treeitem"]').length > 5) break;
            await wait(500);
        }
        const items = [...document.querySelectorAll('[role="treeitem"]')];
        const labels = items.map(el => (el.textContent || '').trim().slice(0, 40));
        const imgs = [...document.querySelectorAll('img[src*="/api/sources/"]')];
        let loaded = 0, broken = 0;
        for (const img of imgs) {
            if (img.naturalWidth > 0) loaded += 1;
            else broken += 1;
        }
        return JSON.stringify({
            treeItems: items.length,
            labels: labels.slice(0, 24),
            iconImgs: imgs.length,
            iconsLoaded: loaded,
            iconsBroken: broken,
            brokenSrc: imgs.filter(i => !i.naturalWidth).map(i => i.getAttribute('src')).slice(0, 6),
            path: location.pathname,
        });
    })()`
    const result = await send("Runtime.evaluate", {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
    })
    console.log("RESULT " + result.result.value)
    console.log("LOGS " + JSON.stringify(logs.slice(-25), null, 1))

    socket.close()
    edge.kill()
    await sleep(500)
    process.exit(0)
}

main().catch(err => {
    console.error("PROBE FAILED:", err)
    process.exit(1)
})
