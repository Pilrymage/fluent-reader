// The article pane has two hosts: Electron's <webview> and, in the browser
// build, an <iframe>. Both must be sized by CSS. An <iframe> has no author
// default box, so a rule written only for <webview> leaves it at the UA default
// 300x150 — the article then opens in a stamp inside the white sheet. This guard
// checks that the stylesheet sizes the frame the React code actually renders,
// and that the toolbar offset still matches the toolbar the component draws.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.resolve(__dirname, "..")
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8")

const article = read("src/components/article.tsx")
const css = read("dist/styles/feeds.css").replace(/\/\*[\s\S]*?\*\//g, "")

// The browser branch must render an <iframe id="article">, not a <webview>.
const webBranch = article.slice(article.indexOf("isWebApp ? ("))
assert.ok(
    webBranch.includes("<iframe") && webBranch.includes('id="article"'),
    'browser build must render <iframe id="article">'
)

// Extract one rule's declarations by selector, ignoring comments.
function declarations(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = new RegExp(
        `(?:^|[,}])\\s*${escaped}\\s*(?:,\\s*[^{]+)?\\{([^}]*)\\}`
    )
    const found = match.exec(css)
    return found ? found[1] : null
}

const frame = declarations(".article iframe")
assert.ok(frame, ".article iframe must have its own sizing rule")
assert.match(frame, /width:\s*100%/, "frame must fill the sheet width")
assert.match(
    frame,
    /height:\s*calc\(100%\s*-\s*36px\)/,
    "frame must fill the sheet height minus the toolbar"
)
assert.match(
    frame,
    /border:\s*none/,
    "the UA 2px iframe border must be removed"
)
assert.match(frame, /display:\s*block/, "the frame must not be inline")

// The 36px subtracted above is the toolbar Stack in article.tsx; a mismatch
// would clip or float the frame against the article body.
const toolbar = /<Stack horizontal style=\{\{ height: (\d+) \}\}>/.exec(article)
assert.ok(toolbar, "article toolbar height must stay a literal in article.tsx")
assert.equal(
    Number(toolbar[1]),
    36,
    "feeds.css subtracts 36px for the toolbar; update both together"
)

// An error must hide the frame, or the prompt sits on top of a broken stamp.
assert.match(
    declarations(".article iframe.error") || "",
    /display:\s*none/,
    "an errored frame must be hidden like an errored webview"
)

// The Electron branch must keep its own rule untouched.
assert.match(
    declarations(".article webview") || "",
    /height:\s*calc\(100%\s*-\s*36px\)/,
    "the Electron <webview> rule must stay"
)

console.log(
    "PASS browser article frame is sized (width 100%, height calc(100% - 36px), no border) and hidden on error"
)
