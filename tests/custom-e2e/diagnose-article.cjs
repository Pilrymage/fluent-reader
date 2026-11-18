// Diagnoses why the browser build's article pane shows an empty white sheet:
// reports whether the iframe exists, what the network did for the detail call,
// and what the article component actually rendered.
//
// usage: FR_SESSION_COOKIE=authelia_session=... node tests/custom-e2e/diagnose-article.cjs https://reader.pilrymage.com
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const PORT = 9339
const BASE = process.argv[2] || "https://reader.pilrymage.com"
const SESSION_COOKIE = process.env.FR_SESSION_COOKIE || ""
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-diag-"))
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
    const apiCalls = []
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
            logs.push(
                message.params.type +
                    ": " +
                    (message.params.args ?? [])
                        .map(a => a.value ?? a.description ?? a.type)
                        .join(" ")
            )
        }
        if (message.method === "Runtime.exceptionThrown") {
            logs.push(
                "exception: " +
                    (message.params.exceptionDetails?.exception?.description ??
                        message.params.exceptionDetails?.text)
            )
        }
        if (
            message.method === "Network.responseReceived" &&
            /\/api\//.test(message.params.response.url)
        ) {
            apiCalls.push({
                url: message.params.response.url.replace(BASE, ""),
                status: message.params.response.status,
                mime: message.params.response.mimeType,
            })
        }
        if (message.method === "Network.loadingFailed") {
            apiCalls.push({
                url: message.params.requestId,
                error: message.params.errorText,
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
        await send("Network.setCookie", {
            name: SESSION_COOKIE.slice(0, eq),
            value: SESSION_COOKIE.slice(eq + 1),
            url: new URL(BASE).origin + "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
        })
    }

    await send("Page.navigate", { url: BASE })
    await sleep(9000)

    const out = await evaluate(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 60; i += 1) {
            if (document.querySelectorAll('[role="treeitem"]').length > 5) break;
            await wait(500);
        }
        const rows = [...document.querySelectorAll('[role="treeitem"]')];
        const row = rows.find(el => /\\d/.test(el.textContent || '')) || rows[0];
        row.click();
        for (let i = 0; i < 60; i += 1) {
            if (document.querySelectorAll('[data-iid]').length > 0) break;
            await wait(500);
        }
        const snapshot = () => {
            const art = document.querySelector('.article');
            return {
                iframes: document.querySelectorAll('iframe').length,
                webviews: document.querySelectorAll('webview').length,
                articleChildren: art ? [...art.children].map(c => c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + '.' + String(c.className).split(' ').filter(Boolean).join('.')) : null,
                errorPrompt: !!document.querySelector('.error-prompt'),
                errorText: (document.querySelector('.error-prompt')?.innerText || '').slice(0, 120),
                spinner: !!document.querySelector('.fui-Spinner'),
            };
        };
        const card = document.querySelector('[data-iid]');
        card.click();
        const states = [];
        for (let i = 0; i < 6; i += 1) { await wait(1000); states.push(snapshot()); }
        return JSON.stringify({ states, sourceName: (document.querySelector('.source-name')?.innerText || '').slice(0, 40) });
    })()`)

    console.log("DIAG " + out)
    console.log("API " + JSON.stringify(apiCalls.slice(-20), null, 1))
    console.log("LOGS " + JSON.stringify(logs.slice(-20), null, 1))

    socket.close()
    edge.kill()
    await sleep(300)
    process.exit(0)
}

main().catch(err => {
    console.error("DIAG FAILED:", err)
    process.exit(1)
})
