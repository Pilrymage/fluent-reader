// Measures the browser build's article overlay: the card overlay (.article-container),
// the white sheet (.article-wrapper) and the article frame (#article).
// It exists to pin down "the article opens in a tiny box" layout bugs, so it
// reports geometry and computed styles instead of a pass/fail.
//
// usage: node tests/custom-e2e/probe-article-layout.cjs http://127.0.0.1:7799 [shot.png]
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const PORT = 9337
const BASE = process.argv[2] || "http://127.0.0.1:7799"
const SHOT = process.argv[3] || ""
// "authelia_session=<value>" for a public run: the headless profile has no SSO
// session of its own, and the site is behind forward_auth as a whole. The value
// carries $ # ! ^ and friends, which a shell would mangle, so it is read from
// FR_SESSION_COOKIE (env) before falling back to argv.
const SESSION_COOKIE = process.env.FR_SESSION_COOKIE || process.argv[4] || ""
const WINDOW = process.argv[5] || "1400,900"
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-article-"))
    const edge = spawn(
        EDGE,
        [
            "--headless=new",
            `--remote-debugging-port=${PORT}`,
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--hide-scrollbars=false",
            `--window-size=${WINDOW}`,
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
    // The local server speaks the same header contract as Caddy.
    if (BASE.startsWith("http://127.0.0.1")) {
        await send("Network.setExtraHTTPHeaders", {
            headers: { "X-Forwarded-Sso": "1", "Remote-User": "probe" },
        })
    }
    if (SESSION_COOKIE) {
        const eq = SESSION_COOKIE.indexOf("=")
        if (eq < 0) throw new Error("cookie must be name=value")
        // Scope by URL: a domain= entry without a leading dot skips subdomains.
        await send("Network.setCookie", {
            name: SESSION_COOKIE.slice(0, eq),
            value: SESSION_COOKIE.slice(eq + 1),
            url: new URL(BASE).origin + "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
        })
        console.log(`COOKIE ${new URL(BASE).origin} seeded`)
    }

    await send("Page.navigate", { url: BASE })
    await sleep(9000)

    const opened = await evaluate(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 60; i += 1) {
            if (document.querySelectorAll('[role="treeitem"]').length > 5) break;
            await wait(500);
        }
        const rows = [...document.querySelectorAll('[role="treeitem"]')];
        const row = rows.find(el => /\\d/.test(el.textContent || '')) || rows[0];
        if (!row) return JSON.stringify({ problem: 'no feed rows', body: (document.body.innerText||'').slice(0,300) });
        row.click();
        for (let i = 0; i < 60; i += 1) {
            if (document.querySelectorAll('[data-iid]').length > 0) break;
            await wait(500);
        }
        const card = document.querySelector('[data-iid]');
        if (!card) return JSON.stringify({ problem: 'no cards', body: (document.body.innerText||'').slice(0,300) });
        card.click();
        // Some feeds carry an empty body in Miniflux; the browser build only
        // mounts the frame once detailContent arrives, so walk the cards until
        // one actually has an article to render.
        let mounted = false;
        for (let attempt = 0; attempt < 8 && !mounted; attempt += 1) {
            for (let i = 0; i < 40; i += 1) {
                if (document.querySelector('#article')) { mounted = true; break; }
                await wait(250);
            }
            if (mounted) break;
            const next = [...document.querySelectorAll('[data-iid]')][attempt + 1];
            if (!next) break;
            document.querySelector('.article .ms-Button[title]');
            next.click();
        }
        if (!mounted) return JSON.stringify({ problem: 'frame never mounted', cards: document.querySelectorAll('[data-iid]').length, body: (document.body.innerText||'').slice(0,300) });
        await wait(2500);
        const round = (rect) => rect && ({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
        const one = sel => document.querySelector(sel);
        const describe = (sel) => {
            const el = one(sel);
            if (!el) return null;
            const cs = getComputedStyle(el);
            return {
                rect: round(el.getBoundingClientRect()),
                display: cs.display,
                position: cs.position,
                margin: cs.margin,
                padding: cs.padding,
                width: cs.width,
                height: cs.height,
                flexGrow: cs.flexGrow,
                tag: el.tagName.toLowerCase(),
                cls: el.className && String(el.className).slice(0, 120),
            };
        };
        const frame = one('#article');
        return JSON.stringify({
            viewport: { w: innerWidth, h: innerHeight },
            app: round(one('#app')?.getBoundingClientRect()),
            root: round(one('#root')?.getBoundingClientRect()),
            container: describe('.article-container'),
            wrapper: describe('.article-wrapper'),
            article: describe('.article'),
            toolbarStack: (() => {
                const el = one('.article-wrapper .ms-Stack') || one('.article > .ms-Stack');
                if (!el) return null;
                const cs = getComputedStyle(el);
                return { rect: round(el.getBoundingClientRect()), height: cs.height, flexShrink: cs.flexShrink, alignSelf: cs.alignSelf };
            })(),
            frame: frame && {
                rect: round(frame.getBoundingClientRect()),
                width: getComputedStyle(frame).width,
                height: getComputedStyle(frame).height,
                display: getComputedStyle(frame).display,
                src: frame.getAttribute('src'),
            },
            frameBodyText: (() => {
                try { return (frame.contentDocument?.body?.innerText || '').slice(0, 120); }
                catch (e) { return 'cross-origin: ' + e.message; }
            })(),
            stylesheets: [...document.styleSheets].map(s => s.href).slice(0, 12),
        });
    })()`)
    console.log("LAYOUT " + opened)
    console.log("LOGS " + JSON.stringify(logs.slice(-15), null, 1))

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
