// Measures what pressing "r" costs: how many requests a burst of keypresses
// produces, and how long the focus move waits for the network.
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const PORT = 9334
const BASE = process.argv[2]
// "authelia_session=<value>" from a logged-in browser; the probe has no SSO
// session of its own and there is no app-level login form any more.
const SESSION_COOKIE = process.argv[3] || ""
const FEED_LABEL = process.argv[4] || "Linux.do"
const PRESSES = Number(process.argv[5] || 10)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-keys-"))
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
    const posts = []
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
        if (
            message.method === "Network.requestWillBeSent" &&
            message.params.request.method === "POST" &&
            message.params.request.url.includes("/api/items/read")
        ) {
            posts.push({
                at: Date.now(),
                body: message.params.request.postData,
            })
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
    await send("Network.enable")
    await send("Page.enable")

    if (SESSION_COOKIE) {
        const eq = SESSION_COOKIE.indexOf("=")
        if (eq < 0) throw new Error("cookie must be name=value")
        const origin = new URL(BASE).origin + "/"
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

    await send("Page.navigate", { url: BASE })
    await sleep(10000)

    const opened = await evaluate(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 40; i += 1) {
            if (document.querySelectorAll('[role="treeitem"]').length > 5) break;
            await wait(500);
        }
        const items = [...document.querySelectorAll('[role="treeitem"]')];
        const row = items.find(el => (el.textContent || '').includes(${JSON.stringify(
            FEED_LABEL
        )}));
        if (!row) return JSON.stringify({
            problem: 'feed row not found',
            path: location.pathname,
            treeItems: items.length,
            labels: items.slice(0, 8).map(el => (el.textContent || '').slice(0, 30)),
            body: (document.body.innerText || '').slice(0, 200),
        });
        row.click();
        for (let i = 0; i < 40; i += 1) {
            if (document.querySelectorAll('[data-iid]').length > 3) break;
            await wait(250);
        }
        const card = document.querySelector('[data-iid]');
        if (!card) return 'no cards';
        card.setAttribute('tabindex', '-1');
        card.focus();
        return JSON.stringify({
            cards: document.querySelectorAll('[data-iid]').length,
            focused: card.getAttribute('data-iid'),
        });
    })()`)
    console.log("OPENED " + opened)
    if (typeof opened === "string" && !opened.startsWith("{")) {
        throw new Error(opened)
    }

    const before = Date.now()
    const marks = []
    for (let i = 0; i < PRESSES; i += 1) {
        const previous = await evaluate(
            `document.activeElement && document.activeElement.getAttribute('data-iid')`
        )
        const started = Date.now()
        await send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "r",
            code: "KeyR",
            windowsVirtualKeyCode: 82,
            nativeVirtualKeyCode: 82,
            text: "r",
        })
        await send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "r",
            code: "KeyR",
            windowsVirtualKeyCode: 82,
            nativeVirtualKeyCode: 82,
        })
        // How long until focus lands on a different card.
        let moved = 0
        for (let poll = 0; poll < 400; poll += 1) {
            const current = await evaluate(
                `document.activeElement && document.activeElement.getAttribute('data-iid')`
            )
            if (current && current !== previous) {
                moved = Date.now() - started
                break
            }
            await sleep(5)
        }
        marks.push(moved)
        await sleep(40)
    }
    const elapsed = Date.now() - before
    await sleep(2500)

    const ids = []
    for (const post of posts) {
        try {
            const body = JSON.parse(post.body ?? "{}")
            if (Array.isArray(body.ids)) ids.push(...body.ids)
        } catch {}
    }
    console.log(
        `PRESSES ${PRESSES}  posts=${posts.length}  ids=${ids.length}  ` +
            `elapsed=${elapsed}ms  focusMove=${JSON.stringify(marks)}`
    )

    // Undo the marks so the probe leaves the real account untouched.
    const reverted = await evaluate(
        `fetch('/api/items/read', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: ${JSON.stringify(
                ids
            )}, value: false }) })
            .then(r => r.status).catch(e => String(e))`
    )
    console.log("REVERT " + reverted)

    socket.close()
    edge.kill()
    await sleep(300)
    process.exit(0)
}

main().catch(err => {
    console.error("PROBE FAILED:", err)
    process.exit(1)
})
