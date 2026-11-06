import { ServiceConfigs } from "../../../schema-types"

// Read/unread changes made locally that the sync service has not confirmed
// yet, keyed by the item's serviceRef. A sync treats the service's unread list
// as the source of truth, so without this a change whose request failed, or
// was still in flight, is reverted by the next sync.
const STORAGE_KEY = "pendingServiceReadStates"
const MAX_ENTRIES = 20000

type StorageLike = {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

function browserStorage(): StorageLike | undefined {
    try {
        return typeof localStorage === "undefined" ? undefined : localStorage
    } catch {
        return undefined
    }
}

// Changes only carry over while the same account on the same service is used.
export function serviceScope(configs: ServiceConfigs): string {
    const c = (configs || {}) as ServiceConfigs & {
        endpoint?: string
        username?: string
    }
    return [c.type, c.endpoint || "", c.username || ""].join("|")
}

export class PendingReadStates {
    private states = new Map<string, boolean>()
    private scope: string | null = null
    private inflight = new Set<Promise<unknown>>()

    constructor(
        private readonly storage: () => StorageLike | undefined = browserStorage
    ) {}

    // Selects the current service, restoring changes an earlier session left.
    use(configs: ServiceConfigs): this {
        const scope = serviceScope(configs)
        if (scope === this.scope) return this
        this.scope = scope
        this.states = new Map()
        try {
            const raw = this.storage()?.getItem(STORAGE_KEY)
            const saved = raw ? JSON.parse(raw) : null
            if (
                saved &&
                saved.scope === scope &&
                Array.isArray(saved.entries)
            ) {
                for (const entry of saved.entries) {
                    if (
                        Array.isArray(entry) &&
                        typeof entry[0] === "string" &&
                        typeof entry[1] === "boolean"
                    ) {
                        this.states.set(entry[0], entry[1])
                    }
                }
            }
        } catch {
            // Unreadable storage only loses protection across restarts.
        }
        return this
    }

    get size(): number {
        return this.states.size
    }

    get(ref: string): boolean | undefined {
        return this.states.get(ref)
    }

    refs(): string[] {
        return [...this.states.keys()]
    }

    set(refs: Iterable<string>, read: boolean): void {
        let changed = false
        for (const ref of refs) {
            if (!ref) continue
            // Re-inserting keeps the newest changes when the oldest are trimmed.
            this.states.delete(ref)
            this.states.set(ref, read)
            changed = true
        }
        if (!changed) return
        while (this.states.size > MAX_ENTRIES) {
            this.states.delete(this.states.keys().next().value)
        }
        this.save()
    }

    // Drops changes the service applied, unless a newer local change for the
    // same item replaced them in the meantime.
    confirm(refs: string | Iterable<string>, read: boolean): void {
        let changed = false
        for (const ref of typeof refs === "string" ? [refs] : refs) {
            if (this.states.get(ref) !== read) continue
            this.states.delete(ref)
            changed = true
        }
        if (changed) this.save()
    }

    // Makes the service's unread list reflect the changes it has not seen.
    applyTo(unreadRefs: Set<string>): void {
        for (const [ref, read] of this.states) {
            if (read) unreadRefs.delete(ref)
            else unreadRefs.add(ref)
        }
    }

    track<T>(promise: Promise<T>): Promise<T> {
        this.inflight.add(promise)
        const done = () => this.inflight.delete(promise)
        promise.then(done, done)
        return promise
    }

    // Waits for the requests already on the wire, ignoring their outcome.
    async settled(): Promise<void> {
        const pending = [...this.inflight]
        await Promise.all(pending.map(p => p.catch(() => undefined)))
    }

    private save(): void {
        try {
            const storage = this.storage()
            if (!storage) return
            if (this.states.size === 0) {
                storage.removeItem(STORAGE_KEY)
            } else {
                storage.setItem(
                    STORAGE_KEY,
                    JSON.stringify({
                        scope: this.scope,
                        entries: [...this.states],
                    })
                )
            }
        } catch {
            // Quota or privacy errors must never break marking items.
        }
    }
}

export const pendingReadStates = new PendingReadStates()
