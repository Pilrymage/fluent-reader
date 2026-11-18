// Measures the browser build's list-view article pane (.side-article-wrapper).
// It reuses the same <iframe id="article"> as the card overlay, but inside a
// column-reverse flex container, so its geometry has to be checked separately.
//
// usage: node tests/custom-e2e/probe-side-article.cjs http://127.0.0.1:7799 [shot.png]
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const PORT = 9338
const BASE = process.argv[2] || "http://127.0.0.1:7799"
const SHOT = process.argv[3] || ""
const VIEW = Number(process.argv[4] ?? 1) // ViewType: 1 = List
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-side-"))
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
        { stdio: "ignore" }
    )

    let page = null
    for (let i = 0; i < 60 && !page; i += 1) {
        await sleep(500)
        try {
            const list = await (
                await fetch(`http://127.0.0.1:${PORT}/json/list`)
            ).json()
            page = list.find(t => t.type === "page")
        } catch {}
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
    const evaluate = async expression => {
        const out = await send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        })
        if (out.exceptionDetails) {
            throw new Error(
                out.exceptionDetails.exception?.description ??
                    out.exceptionDetails.text
            )
        }
        return out.result.value
    }

    await send("Runtime.enable")
    await send("Page.enable")
    if (BASE.startsWith("http://127.0.0.1")) {
        await send("Network.enable")
        await send("Network.setExtraHTTPHeaders", {
            headers: { "X-Forwarded-Sso": "1", "Remote-User": "probe" },
        })
    }

    await send("Page.navigate", { url: BASE })
    await sleep(3000)
    // Seed the view mode before the app reads it.
    await evaluate(
        `localStorage.setItem('fr-web:view', '${JSON.stringify(
            VIEW
        )}'), location.reload()`
    )
    await sleep(9000)

    const result = await evaluate(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 60; i += 1) {
            if (document.querySelectorAll('[role="treeitem"]').length > 5) break;
            await wait(500);
        }
        const row = [...document.querySelectorAll('[role="treeitem"]')][0];
        if (!row) return JSON.stringify({ problem: 'no rows', body: (document.body.innerText||'').slice(0,200) });
        row.click();
        for (let i = 0; i < 60; i += 1) {
            if (document.querySelectorAll('.list-card, .compact-card, .magazine-card, [data-iid]').length) break;
            await wait(500);
        }
        const card = document.querySelector('[data-iid]');
        if (!card) return JSON.stringify({ problem: 'no cards', body: (document.body.innerText||'').slice(0,200) });
        card.click();
        for (let i = 0; i < 80; i += 1) {
            if (document.querySelector('.side-article-wrapper #article')) break;
            await wait(250);
        }
        await wait(2500);
        const round = r => r && ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
        const frame = document.querySelector('#article');
        const side = document.querySelector('.side-article-wrapper');
        const article = document.querySelector('.side-article-wrapper .article');
        return JSON.stringify({
            viewport: { w: innerWidth, h: innerHeight },
            storedView: localStorage.getItem('fr-web:view'),
            side: side && { rect: round(side.getBoundingClientRect()), display: getComputedStyle(side).display },
            article: article && { rect: round(article.getBoundingClientRect()), display: getComputedStyle(article).display, flexDirection: getComputedStyle(article).flexDirection },
            frame: frame && {
                rect: round(frame.getBoundingClientRect()),
                width: getComputedStyle(frame).width,
                height: getComputedStyle(frame).height,
                display: getComputedStyle(frame).display,
                tag: frame.tagName.toLowerCase(),
            },
            bodyText: (() => { try { return (frame.contentDocument?.body?.innerText || '').slice(0, 100) } catch (e) { return 'cross-origin' } })(),
        });
    })()`)
    console.log("SIDE " + result)
    if (logs.length)
        console.log("LOGS " + JSON.stringify(logs.slice(-10), null, 1))

    if (SHOT) {
        const shot = await send("Page.captureScreenshot", { format: "png" })
        fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"))
        console.log("SHOT " + SHOT)
    }

    socket.close()
    edge.kill()
    await sleep(300)
    process.exit(0)
}

main().catch(err => {
    console.error("PROBE FAILED:", err)
    process.exit(1)
})
