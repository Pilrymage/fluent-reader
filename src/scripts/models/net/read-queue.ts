// Coalescing writer for read state.
//
// Paging through an unread list is one keypress per row, and each keypress used
// to wait for its own request. The UI now updates first and this queue folds
// everything pressed within a short window into one request, so holding "r"
// costs one round trip instead of one per row.
import { setReadBatch } from "./bff"

const FLUSH_DELAY_MS = 120
// A reader can hold the key down for a long time; the delay alone would keep
// postponing the write, so a flush is forced at least this often.
const MAX_DELAY_MS = 400
const MAX_BATCH = 200

/** Undo the optimistic update when the write never reaches the server. */
type Revert = () => void

const pending = new Map<number, boolean>()
const reverts = new Map<number, Revert>()
let timer: ReturnType<typeof setTimeout> | null = null
let firstQueuedAt = 0
let flushing: Promise<void> | null = null

export function queueReadState(
    id: number,
    value: boolean,
    onFailure?: Revert
): void {
    pending.set(id, value)
    if (onFailure) reverts.set(id, onFailure)
    else reverts.delete(id)
    const now = Date.now()
    if (pending.size === 1) firstQueuedAt = now
    if (now - firstQueuedAt >= MAX_DELAY_MS) {
        void flushReadQueue()
        return
    }
    // Trailing debounce: keep folding keypresses into one request.
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
        timer = null
        void flushReadQueue()
    }, FLUSH_DELAY_MS)
}

async function send(ids: number[], value: boolean): Promise<void> {
    if (ids.length === 0) return
    try {
        await setReadBatch(ids, value)
        // Keep the revert hook when a newer keypress already queued this row.
        for (const id of ids) {
            if (!pending.has(id)) reverts.delete(id)
        }
    } catch (err) {
        console.error("[read-queue] write failed:", err)
        for (const id of ids) {
            const revert = reverts.get(id)
            reverts.delete(id)
            if (!pending.has(id)) revert?.()
        }
    }
}

/** Send what is queued now. Safe to call concurrently. */
export function flushReadQueue(): Promise<void> {
    if (flushing) return flushing
    if (timer !== null) {
        clearTimeout(timer)
        timer = null
    }
    if (pending.size === 0) return Promise.resolve()
    // One pass only. Keypresses that arrive while this request is in flight are
    // left to the debounce, or a fast reader would chain request after request
    // back to back instead of folding them together.
    const batch = [...pending.entries()].slice(0, MAX_BATCH)
    for (const [id] of batch) pending.delete(id)
    flushing = Promise.all([
        send(
            batch.filter(([, read]) => read).map(([id]) => id),
            true
        ),
        send(
            batch.filter(([, read]) => !read).map(([id]) => id),
            false
        ),
    ])
        .then(() => undefined)
        .finally(() => {
            flushing = null
            if (pending.size === 0) {
                firstQueuedAt = 0
                return
            }
            if (timer === null) {
                timer = setTimeout(() => {
                    timer = null
                    void flushReadQueue()
                }, FLUSH_DELAY_MS)
            }
        })
    return flushing
}

export function pendingReadCount(): number {
    return pending.size
}

/**
 * The queue is a client-side convenience, not durable state, so a navigation
 * must flush it before the page goes away.
 */
function flushOnHide(): void {
    if (pending.size === 0) return
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return
    const batch = [...pending.entries()]
    pending.clear()
    reverts.clear()
    for (const value of [true, false]) {
        const ids = batch.filter(([, read]) => read === value).map(([id]) => id)
        if (ids.length === 0) continue
        const payload = new Blob([JSON.stringify({ ids, value })], {
            type: "application/json",
        })
        navigator.sendBeacon("/api/items/read", payload)
    }
}

if (typeof addEventListener === "function") {
    addEventListener("pagehide", flushOnHide)
    addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushOnHide()
    })
}
