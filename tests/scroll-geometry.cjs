const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")

function load(file) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8")
    const code = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
    }).outputText
    const module = { exports: {} }
    new Function("require", "module", "exports", code)(
        require,
        module,
        module.exports
    )
    return module.exports
}

const tests = []
function test(name, fn) {
    tests.push([name, fn])
}

function scrollTop(kb, opts) {
    return kb.computeDirectionalScrollTop(
        opts.cardTop,
        opts.cardHeight,
        opts.scrollTop,
        opts.clientHeight,
        opts.topInset,
        opts.maxScrollTop,
        opts.mode
    )
}

// The real list layout: nav sits ABOVE the scroll container, so the visible
// content top inset is 0 (the container already starts below the nav).
const BASE = {
    cardHeight: 100,
    scrollTop: 0,
    clientHeight: 600,
    topInset: 0,
    maxScrollTop: 5000,
}

test("visible top inset is zero when the container starts below the nav", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.measureVisibleTopInset(32, 32, 600), 0)
    assert.equal(kb.measureVisibleTopInset(40, 32, 600), 0)
})

test("visible top inset reflects an overlay header that covers the container", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.measureVisibleTopInset(0, 32, 600), 32)
    assert.equal(kb.measureVisibleTopInset(0, 38, 600), 38)
})

test("visible top inset clamps to the container height and never goes negative", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.measureVisibleTopInset(0, 1000, 600), 600)
    assert.equal(kb.measureVisibleTopInset(100, 50, 600), 0)
})

test("moving down to a row crossing the bottom puts its top at the visible top", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = scrollTop(kb, { ...BASE, cardTop: 650, mode: "down" })
    assert.equal(top, 650)
})

test("down alignment respects a real top inset", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = scrollTop(kb, {
        ...BASE,
        topInset: 32,
        cardTop: 650,
        mode: "down",
    })
    assert.equal(top, 650 - 32)
})

test("moving down without crossing leaves scroll position untouched", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = scrollTop(kb, { ...BASE, cardTop: 100, mode: "down" })
    assert.equal(top, 0)
})

test("moving up to a row crossing the top puts it at the bottom of the viewport", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = scrollTop(kb, {
        ...BASE,
        scrollTop: 1000,
        cardTop: 990,
        mode: "up",
    })
    assert.equal(top, 990 + 100 - 600)
})

test("up alignment ignores the top inset because it aligns to the bottom", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = scrollTop(kb, {
        ...BASE,
        topInset: 38,
        scrollTop: 500,
        cardTop: 505,
        mode: "up",
    })
    assert.equal(top, 505 + 100 - 600)
})

test("moving up without crossing leaves scroll position untouched", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = scrollTop(kb, {
        ...BASE,
        scrollTop: 1000,
        cardTop: 1400,
        mode: "up",
    })
    assert.equal(top, 1000)
})

test("down alignment at the deepest row clamps to maxScrollTop", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = scrollTop(kb, {
        ...BASE,
        maxScrollTop: 500,
        cardTop: 1000,
        mode: "down",
    })
    assert.equal(top, 500)
})

test("up alignment near the first row clamps to zero, never negative", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = scrollTop(kb, {
        ...BASE,
        scrollTop: 0,
        cardTop: 10,
        cardHeight: 20,
        mode: "up",
    })
    assert.equal(top, 0)
})

test("page-step decision reports whether a directional move needs a scroll", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.pageStepNeeded(650, 100, 0, 600, 0, "down"), true)
    assert.equal(kb.pageStepNeeded(100, 100, 0, 600, 0, "down"), false)
    assert.equal(kb.pageStepNeeded(999, 100, 1000, 600, 0, "up"), true)
    assert.equal(kb.pageStepNeeded(1400, 100, 1000, 600, 0, "up"), false)
    assert.equal(kb.pageStepNeeded(1000, 100, 1000, 600, 32, "up"), true)
})

test("centered cycle position centers the card in the visible viewport", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = kb.computeCycleScrollTop("center", 1000, 100, 0, 600, 0, 5000)
    const visibleHeight = 600
    assert.equal(top, 1000 - (visibleHeight - 100) / 2)
})

test("centered cycle position subtracts an overlay header inset", () => {
    const kb = load("src/scripts/keyboard.ts")
    const top = kb.computeCycleScrollTop("center", 1000, 100, 0, 600, 32, 5000)
    const visibleHeight = 600 - 32
    assert.equal(top, 1000 - 32 - (visibleHeight - 100) / 2)
})

test("top cycle position aligns the row top at the visible top", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.computeCycleScrollTop("top", 1000, 100, 0, 600, 0, 5000), 1000)
    assert.equal(
        kb.computeCycleScrollTop("top", 1000, 100, 0, 600, 32, 5000),
        1000 - 32
    )
})

test("bottom cycle position aligns the row bottom at the visible bottom", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(
        kb.computeCycleScrollTop("bottom", 1000, 100, 0, 600, 0, 5000),
        1000 + 100 - 600
    )
    assert.equal(
        kb.computeCycleScrollTop("bottom", 1000, 100, 0, 600, 32, 5000),
        1000 + 100 - 600
    )
})

test("cycle positions clamp within the scrollable range", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.computeCycleScrollTop("top", -20, 100, 0, 600, 0, 5000), 0)
    assert.equal(
        kb.computeCycleScrollTop("bottom", 9000, 100, 0, 600, 0, 500),
        500
    )
})
;(async () => {
    for (const [name, fn] of tests) {
        await fn()
        console.log("PASS " + name)
    }
})().catch(err => {
    console.error(err)
    process.exit(1)
})
