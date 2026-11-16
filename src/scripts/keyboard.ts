export type Keybindings = {
    markReadAndNext: string
    markAllRead: string
}

export const DEFAULT_KEYBINDINGS: Keybindings = {
    markReadAndNext: "r",
    markAllRead: "R",
}

let bindings: Keybindings = { ...DEFAULT_KEYBINDINGS }

export function getKeybindings(): Keybindings {
    return { ...bindings }
}

export function setKeybindings(partial: Partial<Keybindings>): void {
    bindings = { ...bindings, ...partial }
}

export function resetKeybindings(): void {
    bindings = { ...DEFAULT_KEYBINDINGS }
}

export type CardShortcutAction =
    | "markReadAndNext"
    | "moveUp"
    | "moveDown"
    | "cyclePosition"

export function isEditableTarget(target): boolean {
    if (!target || typeof target !== "object") return false
    const tag = String((target as any).tagName || "").toUpperCase()
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
    if ((target as any).isContentEditable) return true
    const closest = (target as any).closest
    if (typeof closest === "function") {
        return Boolean(
            closest.call(
                target,
                'input, textarea, select, [contenteditable="true"]'
            )
        )
    }
    return false
}

export function isComposingEvent(e): boolean {
    return Boolean(e && (e.isComposing || e.keyCode === 229))
}

export function hasModifier(e): boolean {
    return Boolean(e && (e.ctrlKey || e.altKey || e.metaKey))
}

export function isRepeatEvent(e): boolean {
    return Boolean(e && e.repeat)
}

export function isListCardTarget(target): boolean {
    if (!target || typeof (target as any).closest !== "function") return false
    return Boolean(
        (target as any).closest(
            ".list-card, .compact-card, .magazine-card, .default-card"
        )
    )
}

function requiresShiftForBinding(binding: string): boolean {
    return /[A-Z]/.test(String(binding))
}

export type ShortcutAppState = {
    settings?: { display?: boolean }
    contextMenu?: { type?: number }
}

export function isOverlayOpen(app: ShortcutAppState): boolean {
    if (!app) return false
    if (app.settings && app.settings.display) return true
    return Boolean(app.contextMenu && (app.contextMenu.type || 0) !== 0)
}

export function isWebviewActive(activeElement): boolean {
    if (!activeElement) return false
    return (
        // An Electron webview or, in the browser build, the article iframe.
        ["WEBVIEW", "IFRAME"].includes(
            String((activeElement as any).tagName || "").toUpperCase()
        )
    )
}

function isInertContext(e, app: ShortcutAppState, activeElement?): boolean {
    if (!e) return true
    if (isComposingEvent(e)) return true
    if (isEditableTarget(e.target) || isEditableTarget(activeElement)) {
        return true
    }
    if (isOverlayOpen(app)) return true
    if (isWebviewActive(activeElement)) return true
    return false
}

export function getCardShortcutAction(
    e,
    app: ShortcutAppState = null,
    activeElement = null
): CardShortcutAction | null {
    if (isInertContext(e, app, activeElement)) return null
    if (!isListCardTarget(e.target)) return null

    const key = String(e.key || "")
    const lower = key.toLowerCase()

    if (e.ctrlKey) {
        if (e.altKey || e.metaKey || e.shiftKey) return null
        return lower === "l" ? "cyclePosition" : null
    }
    if (e.altKey || e.metaKey || e.shiftKey) return null

    if (lower === String(bindings.markReadAndNext).toLowerCase()) {
        return "markReadAndNext"
    }
    if (lower === "p" || key === "ArrowUp") return "moveUp"
    if (lower === "n" || key === "ArrowDown") return "moveDown"
    return null
}

// `b` pressed on the open article's own controls, such as its toolbar. Keys
// typed into the article's webview reach the renderer through the main
// process instead.
export function isArticleOpenExternalKey(e): boolean {
    if (!e || isComposingEvent(e) || hasModifier(e)) return false
    if (e.key !== "b" && e.key !== "B") return false
    if (isEditableTarget(e.target) || isWebviewActive(e.target)) return false
    return true
}

function isTreeItemTarget(target): boolean {
    return Boolean(
        target &&
            typeof target.getAttribute === "function" &&
            target.getAttribute("role") === "treeitem"
    )
}

// p/n move through the sources menu the way ArrowUp/ArrowDown do.
export function getTreeNavigationStep(e): -1 | 1 | null {
    if (!e || isComposingEvent(e) || hasModifier(e) || e.shiftKey) return null
    if (!isTreeItemTarget(e.target)) return null
    const key = String(e.key || "").toLowerCase()
    if (key === "n") return 1
    if (key === "p") return -1
    return null
}

// The neighbour of `current` in document order, clamped at both ends.
export function pickAdjacentElement<T>(
    items: T[],
    current: T,
    step: -1 | 1
): T | null {
    const index = items.indexOf(current)
    if (index < 0) return null
    const next = items[index + step]
    return next === undefined ? null : next
}

export function getNextItemId(
    iids: number[],
    currentId: number
): number | null {
    const index = iids.indexOf(currentId)
    if (index < 0) return null
    const next = iids[index + 1]
    return next === undefined ? null : next
}

// Picks the row to focus after a mark-read even when the current anchor was
// removed from the refreshed order (e.g. while an unread-only filter is on).
export function pickNextAfterRemoval(
    previousOrder: number[],
    newOrder: number[],
    currentId: number
): number | null {
    const currentIndex = previousOrder.indexOf(currentId)
    const suffixStart = currentIndex >= 0 ? currentIndex + 1 : 0
    const available = new Set(newOrder)
    for (let i = suffixStart; i < previousOrder.length; i += 1) {
        const id = previousOrder[i]
        if (available.has(id)) return id
    }
    const fallbackStart = currentIndex >= 0 ? currentIndex : 0
    if (fallbackStart < newOrder.length) return newOrder[fallbackStart]
    return null
}

export type MarkReadStepPlan = {
    nextId: number | null
    loadMore: boolean
}

export function planMarkReadStep(
    iids: number[],
    currentId: number,
    allLoaded = true
): MarkReadStepPlan {
    const nextId = getNextItemId(iids, currentId)
    const index = iids.indexOf(currentId)
    const loadMore =
        nextId === null && index >= 0 && index === iids.length - 1 && !allLoaded
    return { nextId, loadMore }
}

export type CardShortcutPlan = {
    action: CardShortcutAction
    nextId: number | null
    loadMore: boolean
}

export function getCardShortcutPlan(
    e,
    iids: number[],
    currentId: number,
    allLoaded = true
): CardShortcutPlan | null {
    const action = getCardShortcutAction(e)
    if (action !== "markReadAndNext") return null
    const step = planMarkReadStep(iids, currentId, allLoaded)
    return { action, nextId: step.nextId, loadMore: step.loadMore }
}

export function navigationStillValid(
    startFeedId: string | number,
    currentFeedId: string | number
): boolean {
    return startFeedId === currentFeedId
}

export type GlobalShortcutAction = "markAllRead"

export class HeldKeyTracker {
    private held = new Set<string>()

    private idsFor(e): string[] {
        if (!e) return []
        const ids = new Array<string>()
        const code = typeof e.code === "string" ? e.code : ""
        if (code) ids.push(`code:${code.toUpperCase()}`)
        const key = typeof e.key === "string" ? e.key : ""
        if (key) ids.push(`key:${key.toLowerCase()}`)
        return ids
    }

    has(e): boolean {
        return this.idsFor(e).some(id => this.held.has(id))
    }

    add(e): void {
        for (const id of this.idsFor(e)) this.held.add(id)
    }

    delete(e): void {
        for (const id of this.idsFor(e)) this.held.delete(id)
    }

    clear(): void {
        this.held.clear()
    }
}

export function getGlobalShortcutAction(
    e,
    app: ShortcutAppState,
    activeElement = null
): GlobalShortcutAction | null {
    if (!e) return null
    const binding = String(bindings.markAllRead)
    const key = String(e.key)
    if (requiresShiftForBinding(binding)) {
        if (!e.shiftKey) return null
        if (key.toUpperCase() !== binding.toUpperCase()) return null
    } else if (key !== binding) {
        return null
    }
    if (isRepeatEvent(e) || isComposingEvent(e) || hasModifier(e)) return null
    if (isEditableTarget(e.target) || isEditableTarget(activeElement)) {
        return null
    }
    if (isOverlayOpen(app)) return null
    if (isWebviewActive(activeElement)) return null
    return "markAllRead"
}

type QueuedStep = {
    task: () => Promise<void>
    resolve: () => void
}

const DEFAULT_MAX_PENDING_STEPS = 16

export class StepQueue {
    private queue = new Array<QueuedStep>()
    private running = false
    private active = 0
    private maxActive = 0
    private maxPendingSeen = 0
    private idleWaiters = new Array<() => void>()
    private readonly pendingLimit: number

    constructor(maxPending = DEFAULT_MAX_PENDING_STEPS) {
        this.pendingLimit = Math.max(1, maxPending)
    }

    get activeCount(): number {
        return this.active
    }

    get pendingCount(): number {
        return this.queue.length
    }

    get maxConcurrent(): number {
        return this.maxActive
    }

    get maxPending(): number {
        return this.maxPendingSeen
    }

    enqueue(task: () => Promise<void>): Promise<void> {
        return new Promise<void>(resolve => {
            // Bounded FIFO: every accepted keydown gets exactly one step, and
            // overflow is dropped rather than coalesced.
            if (this.queue.length >= this.pendingLimit) {
                resolve()
                return
            }
            this.queue.push({ task, resolve })
            this.maxPendingSeen = Math.max(
                this.maxPendingSeen,
                this.queue.length
            )
            if (!this.running) {
                this.running = true
                void this.drainNext()
            }
        })
    }

    cancelPending(): void {
        const pending = this.queue
        this.queue = []
        for (const entry of pending) entry.resolve()
    }

    whenIdle(): Promise<void> {
        if (!this.running) return Promise.resolve()
        return new Promise<void>(resolve => this.idleWaiters.push(resolve))
    }

    private async drainNext(): Promise<void> {
        const entry = this.queue.shift()
        if (!entry) {
            this.running = false
            const waiters = this.idleWaiters
            this.idleWaiters = []
            for (const waiter of waiters) waiter()
            return
        }
        this.active += 1
        this.maxActive = Math.max(this.maxActive, this.active)
        try {
            await entry.task()
        } catch (err) {
            console.error(err)
        } finally {
            this.active -= 1
            entry.resolve()
            await this.drainNext()
        }
    }
}

export type FocusPosition = "center" | "top" | "bottom"

export function nextFocusPosition(current: FocusPosition): FocusPosition {
    switch (current) {
        case "center":
            return "top"
        case "top":
            return "bottom"
        default:
            return "center"
    }
}

export class FocusPositionCycle {
    private position: FocusPosition = "center"

    get current(): FocusPosition {
        return this.position
    }

    // Apply-then-advance: the first press uses the starting position ("center")
    // and only then advances the cycle.
    applyCurrent(): FocusPosition {
        const result = this.position
        this.position = nextFocusPosition(this.position)
        return result
    }

    reset(): void {
        this.position = "center"
    }
}

export const focusPositionCycle = new FocusPositionCycle()

export function resetPositionCycle(): void {
    focusPositionCycle.reset()
}

export type ScrollMode = "up" | "down"

function clampScroll(value: number, maxScrollTop: number): number {
    if (!Number.isFinite(value)) return 0
    if (!Number.isFinite(maxScrollTop)) return Math.max(0, value)
    return Math.max(0, Math.min(maxScrollTop, value))
}

// The real visible top inset of a scroll container: how much of the
// container's top is covered by the nav (or an overlay header). In the normal
// list layout the nav sits above the container, so this is 0.
export function measureVisibleTopInset(
    containerTop: number,
    navBottom: number,
    clientHeight: number
): number {
    if (!Number.isFinite(containerTop) || !Number.isFinite(navBottom)) return 0
    const inset = navBottom - containerTop
    if (!Number.isFinite(inset)) return 0
    const maxInset = Number.isFinite(clientHeight)
        ? Math.max(0, clientHeight)
        : inset
    return Math.max(0, Math.min(maxInset, inset))
}

export function pageStepNeeded(
    cardTop: number,
    cardHeight: number,
    scrollTop: number,
    clientHeight: number,
    topInset: number,
    mode: ScrollMode
): boolean {
    if (mode === "down") {
        return cardTop + cardHeight > scrollTop + clientHeight
    }
    return cardTop < scrollTop + topInset
}

export function computeDirectionalScrollTop(
    cardTop: number,
    cardHeight: number,
    scrollTop: number,
    clientHeight: number,
    topInset: number,
    maxScrollTop: number,
    mode: ScrollMode
): number {
    if (
        !pageStepNeeded(
            cardTop,
            cardHeight,
            scrollTop,
            clientHeight,
            topInset,
            mode
        )
    ) {
        return clampScroll(scrollTop, maxScrollTop)
    }
    const target =
        mode === "down"
            ? cardTop - topInset
            : cardTop + cardHeight - clientHeight
    return clampScroll(target, maxScrollTop)
}

export function computeCycleScrollTop(
    position: FocusPosition,
    cardTop: number,
    cardHeight: number,
    scrollTop: number,
    clientHeight: number,
    topInset: number,
    maxScrollTop: number
): number {
    let target: number
    switch (position) {
        case "top":
            target = cardTop - topInset
            break
        case "bottom":
            target = cardTop + cardHeight - clientHeight
            break
        default: {
            const visibleHeight = clientHeight - topInset
            target = cardTop - topInset - (visibleHeight - cardHeight) / 2
        }
    }
    return clampScroll(target, maxScrollTop)
}
