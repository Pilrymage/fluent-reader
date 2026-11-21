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

function element(tagName, classes, extra = {}) {
    const cls = new Set((classes || "").split(/\s+/).filter(Boolean))
    const el = {
        tagName,
        isContentEditable: false,
        ...extra,
        closest(selector) {
            const simple = selector
                .split(",")
                .map(s => s.trim().replace(/^\./, ""))
            if (simple.some(c => cls.has(c))) return el
            return null
        },
    }
    return el
}

function card(classes = "list-card") {
    return element("DIV", `card ${classes}`)
}

function keyEvent(overrides = {}) {
    return {
        key: "r",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        keyCode: 82,
        target: card("list-card"),
        ...overrides,
    }
}

const tests = []
function test(name, fn) {
    tests.push([name, fn])
}

test("r on a middle card selects mark-read-and-next with the following id", () => {
    const kb = load("src/scripts/keyboard.ts")
    const e = keyEvent({ target: card("compact-card") })
    assert.equal(kb.getCardShortcutAction(e), "markReadAndNext")
    assert.equal(kb.getNextItemId([10, 11, 12], 11), 12)
})

test("r on the last card does not advance or wrap", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.getNextItemId([10, 11, 12], 12), null)
})

test("a missing current id yields no next id", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.getNextItemId([10, 11, 12], 99), null)
})

test("next id is snapshotted from the pre-removal view order", () => {
    const kb = load("src/scripts/keyboard.ts")
    const iids = [10, 11, 12]
    const e = keyEvent({ target: card("compact-card") })
    const plan = kb.getCardShortcutPlan(e, iids, 10)
    iids.splice(0, 1)
    assert.equal(plan.action, "markReadAndNext")
    assert.equal(plan.nextId, 11)
})

test("r on an already-read item still advances and has no unread/toggle path", () => {
    const kb = load("src/scripts/keyboard.ts")
    const item = { _id: 10, hasRead: true }
    const step = kb.planMarkReadStep([10, 11, 12], item._id, true)
    assert.equal(step.nextId, 11)
    assert.equal("unread" in step, false)
    assert.equal("toggle" in step, false)
})

test("after lazy loading, the first newly loaded row is the next id", () => {
    const kb = load("src/scripts/keyboard.ts")
    const before = [10, 11]
    const step = kb.planMarkReadStep(before, 11, false)
    assert.equal(step.nextId, null)
    assert.equal(step.loadMore, true)
    const after = [10, 11, 12, 13]
    assert.equal(kb.getNextItemId(after, 11), 12)
})

test("r on the last loaded card with more rows requests load-more", () => {
    const kb = load("src/scripts/keyboard.ts")
    const plan = kb.getCardShortcutPlan(keyEvent(), [10, 11], 11, false)
    assert.equal(plan.nextId, null)
    assert.equal(plan.loadMore, true)
})

test("r on the final card when all rows are loaded does not load more", () => {
    const kb = load("src/scripts/keyboard.ts")
    const plan = kb.getCardShortcutPlan(keyEvent(), [10, 11], 11, true)
    assert.equal(plan.nextId, null)
    assert.equal(plan.loadMore, false)
})

test("a mid-list card never requests load-more", () => {
    const kb = load("src/scripts/keyboard.ts")
    const plan = kb.getCardShortcutPlan(keyEvent(), [10, 11, 12], 11, false)
    assert.equal(plan.nextId, 12)
    assert.equal(plan.loadMore, false)
})

test("r accepts key-repeat keydowns so holding it advances", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ repeat: true })),
        "markReadAndNext"
    )
    const plan = kb.getCardShortcutPlan(
        keyEvent({ repeat: true }),
        [10, 11],
        10
    )
    assert.equal(plan.action, "markReadAndNext")
    assert.equal(plan.nextId, 11)
})

test("r is ignored for modifiers, IME, editable or non-card targets", () => {
    const kb = load("src/scripts/keyboard.ts")
    const cases = [
        keyEvent({ ctrlKey: true }),
        keyEvent({ altKey: true }),
        keyEvent({ metaKey: true }),
        keyEvent({ isComposing: true }),
        keyEvent({ isComposing: false, keyCode: 229 }),
        keyEvent({ target: element("INPUT", "") }),
        keyEvent({ target: element("TEXTAREA", "") }),
        keyEvent({ target: element("DIV", "article") }),
        keyEvent({ target: card("list-card"), shiftKey: true, key: "R" }),
    ]
    for (const e of cases) assert.equal(kb.getCardShortcutAction(e), null)
})

test("p/n and ArrowUp/ArrowDown map to movement and accept repeats", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.getCardShortcutAction(keyEvent({ key: "p" })), "moveUp")
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ key: "ArrowUp" })),
        "moveUp"
    )
    assert.equal(kb.getCardShortcutAction(keyEvent({ key: "n" })), "moveDown")
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ key: "ArrowDown" })),
        "moveDown"
    )
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ key: "n", repeat: true })),
        "moveDown"
    )
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ key: "ArrowUp", repeat: true })),
        "moveUp"
    )
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ key: "p", repeat: true })),
        "moveUp"
    )
})

test("movement shortcuts never resolve to mark-read", () => {
    const kb = load("src/scripts/keyboard.ts")
    for (const key of ["p", "n", "ArrowUp", "ArrowDown"]) {
        assert.notEqual(
            kb.getCardShortcutAction(keyEvent({ key })),
            "markReadAndNext"
        )
    }
})

test("Ctrl+L resolves the position cycle only in list context", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ key: "l", ctrlKey: true })),
        "cyclePosition"
    )
    assert.equal(
        kb.getCardShortcutAction(
            keyEvent({ key: "l", ctrlKey: true, altKey: true })
        ),
        null
    )
    assert.equal(
        kb.getCardShortcutAction(
            keyEvent({ key: "l", ctrlKey: true, metaKey: true })
        ),
        null
    )
    assert.equal(
        kb.getCardShortcutAction(
            keyEvent({ key: "l", ctrlKey: true, shiftKey: true })
        ),
        null
    )
    assert.equal(
        kb.getCardShortcutAction(
            keyEvent({
                key: "l",
                ctrlKey: true,
                target: element("DIV", "article"),
            })
        ),
        null
    )
})

test("all card shortcuts are inert in settings, menus, webview and editable targets", () => {
    const kb = load("src/scripts/keyboard.ts")
    const overlay = { settings: { display: true }, contextMenu: { type: 0 } }
    const menu = { settings: { display: false }, contextMenu: { type: 2 } }
    const webview = element("WEBVIEW", "")
    const editable = element("DIV", "list-card", { isContentEditable: true })
    const events = [
        keyEvent(),
        keyEvent({ key: "p" }),
        keyEvent({ key: "n" }),
        keyEvent({ key: "ArrowUp" }),
        keyEvent({ key: "ArrowDown" }),
        keyEvent({ key: "l", ctrlKey: true }),
    ]
    for (const e of events) {
        assert.equal(kb.getCardShortcutAction(e, overlay), null)
        assert.equal(kb.getCardShortcutAction(e, menu), null)
        assert.equal(kb.getCardShortcutAction(e, null, webview), null)
    }
    assert.equal(kb.getCardShortcutAction(keyEvent({ target: editable })), null)
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ isComposing: true })),
        null
    )
    assert.equal(kb.getCardShortcutAction(keyEvent({ keyCode: 229 })), null)
})

test("keybinding override changes r and reset restores it", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.getKeybindings().markReadAndNext, "r")
    assert.equal(kb.getKeybindings().markAllRead, "R")
    kb.setKeybindings({ markReadAndNext: "n" })
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ key: "n" })),
        "markReadAndNext"
    )
    assert.equal(kb.getCardShortcutAction(keyEvent({ key: "r" })), null)
    kb.resetKeybindings()
    assert.equal(
        kb.getCardShortcutAction(keyEvent({ key: "r" })),
        "markReadAndNext"
    )
    assert.equal(kb.getCardShortcutAction(keyEvent({ key: "n" })), "moveDown")
})

test("navigation is discarded when the category changed while it was in flight", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.navigationStillValid("ALL", "ALL"), true)
    assert.equal(kb.navigationStillValid("ALL", "SOURCE"), false)
    assert.equal(kb.navigationStillValid(3, 3), true)
    assert.equal(kb.navigationStillValid(3, 4), false)
})

test("repeat steps serialize, never overlap, and advance exactly one row each", async () => {
    const kb = load("src/scripts/keyboard.ts")
    const queue = new kb.StepQueue()
    const order = [1, 2, 3, 4]
    let current = 1
    const visited = []
    const step = async () => {
        visited.push(current)
        const next = kb.getNextItemId(order, current)
        if (next !== null) current = next
    }
    for (let i = 0; i < 3; i += 1) await queue.enqueue(step)
    assert.deepEqual(visited, [1, 2, 3])
    assert.equal(queue.maxConcurrent, 1)
})

test("a burst of repeats enqueues a bounded FIFO, not a single coalesced step", async () => {
    const kb = load("src/scripts/keyboard.ts")
    const queue = new kb.StepQueue(4)
    let active = 0
    let maxActive = 0
    let executed = 0
    let release
    const gate = new Promise(resolve => (release = resolve))
    const make = i => async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        if (i === 0) await gate
        executed += 1
        active -= 1
    }
    const promises = []
    for (let i = 0; i < 10; i += 1) promises.push(queue.enqueue(make(i)))
    assert.ok(queue.pendingCount <= 4, "pending must stay bounded")
    assert.ok(queue.maxPending <= 4, "max pending must stay bounded")
    release()
    await Promise.all(promises)
    await queue.whenIdle()
    assert.equal(maxActive, 1, "steps must never run concurrently")
    assert.equal(queue.maxConcurrent, 1)
    assert.equal(executed, 5, "first + four accepted pending steps")
    assert.equal(queue.activeCount, 0)
    assert.equal(queue.pendingCount, 0)
})

test("queue catches task errors, reports once, and keeps draining", async () => {
    const kb = load("src/scripts/keyboard.ts")
    const queue = new kb.StepQueue(8)
    const original = console.error
    let errors = 0
    console.error = () => {
        errors += 1
    }
    try {
        const seen = []
        queue.enqueue(async () => {
            seen.push(1)
            throw new Error("boom")
        })
        queue.enqueue(async () => {
            seen.push(2)
        })
        await queue.whenIdle()
        assert.deepEqual(seen, [1, 2])
        assert.equal(errors, 1)
        assert.equal(queue.activeCount, 0)
        assert.equal(queue.pendingCount, 0)
    } finally {
        console.error = original
    }
})

test("cancelPending drops a backlog but lets the in-flight step finish", async () => {
    const kb = load("src/scripts/keyboard.ts")
    const queue = new kb.StepQueue(8)
    let release
    const gate = new Promise(resolve => (release = resolve))
    const seen = []
    const first = queue.enqueue(async () => {
        seen.push(1)
        await gate
    })
    const rest = [
        queue.enqueue(async () => seen.push(2)),
        queue.enqueue(async () => seen.push(3)),
    ]
    assert.equal(queue.pendingCount, 2)
    queue.cancelPending()
    assert.equal(queue.pendingCount, 0)
    release()
    await Promise.all([first, ...rest])
    await queue.whenIdle()
    assert.deepEqual(seen, [1])
})

test("a jumps to the list even while the open article holds focus", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(
        kb.getListFocusShortcut(
            keyEvent({ key: "a", target: element("DIV", "article") }),
            appState()
        ),
        "focusList"
    )
    // Caps Lock reports "A" without Shift.
    assert.equal(
        kb.getListFocusShortcut(
            keyEvent({ key: "A", target: element("DIV", "main") }),
            appState()
        ),
        "focusList"
    )
    // The webview/iframe holds focus while the article is open; that is exactly
    // where a has to work, unlike r/p/n.
    assert.equal(
        kb.getListFocusShortcut(
            keyEvent({ key: "a" }),
            appState(),
            element("WEBVIEW", "")
        ),
        "focusList"
    )
})

test("a stays inert where the letter must be typed or belongs to another widget", () => {
    const kb = load("src/scripts/keyboard.ts")
    const tree = {
        tagName: "DIV",
        isContentEditable: false,
        closest: selector =>
            /role="tree"/.test(selector) ? { tagName: "DIV" } : null,
    }
    const inert = [
        keyEvent({ key: "a", ctrlKey: true }),
        keyEvent({ key: "a", altKey: true }),
        keyEvent({ key: "a", metaKey: true }),
        keyEvent({ key: "a", isComposing: true }),
        keyEvent({ key: "a", isComposing: false, keyCode: 229 }),
        keyEvent({ key: "a", target: element("INPUT", "") }),
        keyEvent({ key: "a", target: element("TEXTAREA", "") }),
        keyEvent({ key: "a", target: tree }),
        keyEvent({ key: "r" }),
    ]
    for (const e of inert) {
        assert.equal(kb.getListFocusShortcut(e, appState()), null)
    }
    // A selected tree entry keeps its type-ahead.
    assert.equal(
        kb.getListFocusShortcut(keyEvent({ key: "a" }), appState(), tree),
        null
    )
    assert.equal(
        kb.getListFocusShortcut(
            keyEvent({ key: "a" }),
            appState({ settings: { display: true } })
        ),
        null
    )
    assert.equal(
        kb.getListFocusShortcut(
            keyEvent({ key: "a" }),
            appState({ contextMenu: { type: 2 } })
        ),
        null
    )
    // The notifications callout is only an overlay for keys that would move
    // focus away from it.
    assert.equal(
        kb.getListFocusShortcut(
            keyEvent({ key: "a" }),
            appState({ logMenu: { display: true } })
        ),
        null
    )
    assert.equal(
        kb.getCardShortcutAction(
            keyEvent({ target: card("list-card") }),
            appState({ logMenu: { display: true } })
        ),
        "markReadAndNext"
    )
})

test("a lands on the open article, then the cursor, then the first row", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(kb.pickListFocusId([10, 11, 12], [11, 10]), 11)
    assert.equal(kb.pickListFocusId([10, 11, 12], [null, 12]), 12)
    assert.equal(kb.pickListFocusId([10, 11, 12], [null, null]), 10)
    // A row that is no longer in the view (filter/category change) is skipped.
    assert.equal(kb.pickListFocusId([10, 11], [99, 11]), 11)
    assert.equal(kb.pickListFocusId([10, 11], [99, 98]), 10)
    assert.equal(kb.pickListFocusId([], [10, 11]), null)
    assert.equal(kb.pickListFocusId(null, [10, 11]), null)
})

test("Ctrl+L cycle applies center, top, bottom, then center again", () => {    const kb = load("src/scripts/keyboard.ts")
    const cycle = new kb.FocusPositionCycle()
    assert.equal(cycle.current, "center")
    assert.equal(cycle.applyCurrent(), "center")
    assert.equal(cycle.applyCurrent(), "top")
    assert.equal(cycle.applyCurrent(), "bottom")
    assert.equal(cycle.applyCurrent(), "center")
    cycle.reset()
    assert.equal(cycle.current, "center")
    assert.equal(cycle.applyCurrent(), "center")
    assert.equal(kb.nextFocusPosition("center"), "top")
    assert.equal(kb.nextFocusPosition("top"), "bottom")
    assert.equal(kb.nextFocusPosition("bottom"), "center")
})

test("pickNextAfterRemoval follows the surviving suffix then appended rows", () => {
    const kb = load("src/scripts/keyboard.ts")
    // The anchor was removed by an unread filter; the next surviving suffix row
    // wins first.
    assert.equal(kb.pickNextAfterRemoval([10, 11, 12], [10, 12, 13], 11), 12)
    // Suffix exhausted, appended rows land at the old index.
    assert.equal(kb.pickNextAfterRemoval([10, 11], [10, 12, 13], 11), 12)
    // Truly exhausted.
    assert.equal(kb.pickNextAfterRemoval([10, 11], [10], 11), null)
    assert.equal(kb.pickNextAfterRemoval([10, 11], [], 11), null)
})

function appState(overrides = {}) {
    return {
        settings: { display: false },
        contextMenu: { type: 0 },
        ...overrides,
    }
}

function shiftR(overrides = {}) {
    return keyEvent({
        key: "R",
        shiftKey: true,
        target: element("DIV", "main"),
        ...overrides,
    })
}

test("R marks the current view read and is guarded globally", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(
        kb.getGlobalShortcutAction(shiftR(), appState()),
        "markAllRead"
    )
    assert.equal(kb.getCardShortcutAction(shiftR()), null)
    assert.equal(
        kb.getGlobalShortcutAction(keyEvent({ key: "r" }), appState()),
        null
    )
    const blocked = [
        shiftR({ repeat: true }),
        shiftR({ ctrlKey: true }),
        shiftR({ altKey: true }),
        shiftR({ metaKey: true }),
        shiftR({ isComposing: true }),
        shiftR({ isComposing: false, keyCode: 229 }),
        keyEvent({ key: "R", shiftKey: true, target: element("INPUT", "") }),
    ]
    for (const e of blocked) {
        assert.equal(kb.getGlobalShortcutAction(e, appState()), null)
    }
    assert.equal(
        kb.getGlobalShortcutAction(
            shiftR(),
            appState({ settings: { display: true } })
        ),
        null
    )
    assert.equal(
        kb.getGlobalShortcutAction(
            shiftR(),
            appState({ contextMenu: { type: 2 } })
        ),
        null
    )
    assert.equal(
        kb.getGlobalShortcutAction(
            shiftR(),
            appState(),
            element("WEBVIEW", "")
        ),
        null
    )
})

test("CapsLock uppercase R without Shift is the card shortcut, not mark-all", () => {
    const kb = load("src/scripts/keyboard.ts")
    const caps = shiftR({ shiftKey: false })
    assert.equal(kb.getGlobalShortcutAction(caps, appState()), null)
    assert.equal(
        kb.getCardShortcutAction(
            keyEvent({
                key: "R",
                shiftKey: false,
                target: card("magazine-card"),
            })
        ),
        "markReadAndNext"
    )
})

test("Shift is required for mark-all, including CapsLock+Shift yielding lowercase r", () => {
    const kb = load("src/scripts/keyboard.ts")
    assert.equal(
        kb.getGlobalShortcutAction(shiftR(), appState()),
        "markAllRead"
    )
    assert.equal(
        kb.getGlobalShortcutAction(shiftR({ key: "r" }), appState()),
        "markAllRead"
    )
})

function heldKeyHarness(kb) {
    const tracker = new kb.HeldKeyTracker()
    let marks = 0
    return {
        down(e) {
            if (
                kb.getGlobalShortcutAction(e, appState()) === "markAllRead" &&
                !tracker.has(e)
            ) {
                tracker.add(e)
                marks++
            }
        },
        up(e) {
            tracker.delete(e)
        },
        blur() {
            tracker.clear()
        },
        get marks() {
            return marks
        },
    }
}

test("mixed-case keyup releases a latched Shift+R after Shift is released first", () => {
    const kb = load("src/scripts/keyboard.ts")
    const h = heldKeyHarness(kb)
    h.down(shiftR({ code: "KeyR" }))
    assert.equal(h.marks, 1)
    h.up(keyEvent({ key: "r", code: "KeyR" }))
    h.down(shiftR({ code: "KeyR" }))
    assert.equal(h.marks, 2)
})

test("keyup without a code still releases through the normalized key fallback", () => {
    const kb = load("src/scripts/keyboard.ts")
    const h = heldKeyHarness(kb)
    h.down(shiftR({ code: "", key: "R" }))
    h.up(keyEvent({ key: "r", code: "" }))
    h.down(shiftR({ code: "", key: "R" }))
    assert.equal(h.marks, 2)
})

test("window blur clears tracked keys so the next Shift+R marks again", () => {
    const kb = load("src/scripts/keyboard.ts")
    const h = heldKeyHarness(kb)
    h.down(shiftR({ code: "KeyR" }))
    h.blur()
    h.down(shiftR({ code: "KeyR" }))
    assert.equal(h.marks, 2)
})

test("tracker dedupes repeated keydowns for the same physical key", () => {
    const kb = load("src/scripts/keyboard.ts")
    const h = heldKeyHarness(kb)
    h.down(shiftR({ code: "KeyR" }))
    h.down(shiftR({ code: "KeyR" }))
    assert.equal(h.marks, 1)
})

test("read text style returns gray for read and nothing for unread", () => {
    const rs = load("src/scripts/read-style.ts")
    assert.equal(rs.READ_TEXT_COLOR, "var(--neutralTertiary)")
    assert.deepEqual(rs.getReadTextStyle(true), {
        color: "var(--neutralTertiary)",
    })
    assert.equal(rs.getReadTextStyle(false), undefined)
})

test("b on the open article's own controls opens it externally", () => {
    const kb = load("src/scripts/keyboard.ts")
    const button = element("BUTTON", "ms-Button")
    assert.equal(
        kb.isArticleOpenExternalKey(keyEvent({ key: "b", target: button })),
        true
    )
    assert.equal(
        kb.isArticleOpenExternalKey(
            keyEvent({ key: "B", shiftKey: true, target: button })
        ),
        true
    )
    const inert = [
        keyEvent({ key: "r", target: button }),
        keyEvent({ key: "b", ctrlKey: true, target: button }),
        keyEvent({ key: "b", altKey: true, target: button }),
        keyEvent({ key: "b", metaKey: true, target: button }),
        keyEvent({ key: "b", isComposing: true, target: button }),
        keyEvent({ key: "b", target: element("INPUT", "") }),
        keyEvent({ key: "b", target: element("WEBVIEW", "") }),
    ]
    for (const e of inert) assert.equal(kb.isArticleOpenExternalKey(e), false)
})

function treeItem(name) {
    return {
        name,
        tagName: "DIV",
        isContentEditable: false,
        getAttribute: attr => (attr === "role" ? "treeitem" : null),
        closest: () => null,
    }
}

test("p and n step through the sources menu tree items", () => {
    const kb = load("src/scripts/keyboard.ts")
    const item = treeItem("a")
    const step = key =>
        kb.getTreeNavigationStep(keyEvent({ key, target: item }))
    assert.equal(step("n"), 1)
    assert.equal(step("p"), -1)
    // Caps Lock reports upper case without Shift.
    assert.equal(step("N"), 1)
    const inert = [
        keyEvent({ key: "N", shiftKey: true, target: item }),
        keyEvent({ key: "n", ctrlKey: true, target: item }),
        keyEvent({ key: "n", isComposing: true, target: item }),
        keyEvent({ key: "j", target: item }),
        // The unread filter toggle inside the tree keeps its own keys.
        keyEvent({ key: "n", target: element("BUTTON", "") }),
    ]
    for (const e of inert) assert.equal(kb.getTreeNavigationStep(e), null)
})

test("tree navigation moves to the neighbour and clamps at both ends", () => {
    const kb = load("src/scripts/keyboard.ts")
    const items = ["search", "all", "g-1", "s-2", "s-3"]
    assert.equal(kb.pickAdjacentElement(items, "all", 1), "g-1")
    assert.equal(kb.pickAdjacentElement(items, "all", -1), "search")
    assert.equal(kb.pickAdjacentElement(items, "s-3", 1), null)
    assert.equal(kb.pickAdjacentElement(items, "search", -1), null)
    assert.equal(kb.pickAdjacentElement(items, "missing", 1), null)
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
