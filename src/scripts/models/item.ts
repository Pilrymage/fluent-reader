import { getRulesForTarget } from "./rule"
import { eq, and, inArray, lte, gte } from "drizzle-orm"
import { database, itemsTable } from "../db"
import { getValidDate } from "../date"
import intl from "react-intl-universal"
import type { MyParserItem } from "../utils"
import {
    domParser,
    htmlDecode,
    ActionStatus,
    AppThunk,
    platformCtrl,
} from "../utils"
import { RSSSource, updateSource, updateUnreadCounts } from "./source"
import {
    fetchItemDetail,
    fetchItems as fetchItemsApi,
    isWeb,
    markSourcesRead,
    setStar,
} from "./net/bff"
import { queueReadState } from "./net/read-queue"
import { RSSFeed, initFeedSuccess } from "./feed"
import {
    getCardShortcutAction,
    getNextItemId,
    pickNextAfterRemoval,
    planMarkReadStep,
    navigationStillValid,
    isComposingEvent,
    isEditableTarget,
    isOverlayOpen,
    isWebviewActive,
    StepQueue,
    focusPositionCycle,
    resetPositionCycle,
    computeDirectionalScrollTop,
    computeCycleScrollTop,
    measureVisibleTopInset,
    ScrollMode,
    FocusPosition,
    ShortcutAppState,
} from "../keyboard"
import {
    FeedActionTypes,
    INIT_FEED,
    LOAD_MORE,
    dismissItems,
    loadMore,
} from "./feed"
import {
    pushNotification,
    setupAutoFetch,
    SettingsActionTypes,
    FREE_MEMORY,
} from "./app"
import {
    getServiceHooks,
    pushReadState,
    syncWithService,
    ServiceActionTypes,
    SYNC_LOCAL_ITEMS,
} from "./service"

export class RSSItem {
    _id: number
    source: number
    guid?: string
    title: string
    link: string
    date: Date
    fetchedDate: Date
    thumb?: string
    content: string
    snippet: string
    creator?: string
    hasRead: boolean
    starred: boolean
    hidden: boolean
    notify: boolean
    serviceRef?: string

    constructor(item: MyParserItem, source: RSSSource) {
        for (let field of ["title", "link", "creator", "author"]) {
            const content = item[field]
            if (content && typeof content !== "string") delete item[field]
        }
        this.source = source.sid
        if (!source.serviceRef) {
            this.guid = [item.guid, item.id].find(
                value => typeof value === "string" && value.trim().length > 0
            )
        }
        this.title = item.title || intl.get("article.untitled")
        this.link = item.link || ""
        this.fetchedDate = new Date()
        this.date = getValidDate(item.isoDate, item.pubDate, this.fetchedDate)
        this.creator = item.creator || item.author
        this.hasRead = false
        this.starred = false
        this.hidden = false
        this.notify = false
    }

    static parseContent(item: RSSItem, parsed: MyParserItem) {
        for (let field of ["thumb", "content", "fullContent"]) {
            const content = parsed[field]
            if (content && typeof content !== "string") delete parsed[field]
        }
        if (parsed.fullContent) {
            item.content = parsed.fullContent
            item.snippet = htmlDecode(parsed.fullContent)
        } else {
            item.content = parsed.content || ""
            item.snippet = htmlDecode(parsed.contentSnippet || "")
        }
        if (parsed.thumb) {
            item.thumb = parsed.thumb
        } else if (parsed.image?.$?.url) {
            item.thumb = parsed.image.$.url
        } else if (parsed.image && typeof parsed.image === "string") {
            item.thumb = parsed.image
        } else if (parsed.mediaContent) {
            let images = parsed.mediaContent.filter(
                c => c.$ && c.$.medium === "image" && c.$.url
            )
            if (images.length > 0) item.thumb = images[0].$.url
        }
        if (!item.thumb) {
            let dom = domParser.parseFromString(item.content, "text/html")
            let baseEl = dom.createElement("base")
            baseEl.setAttribute(
                "href",
                item.link.split("/").slice(0, 3).join("/")
            )
            dom.head.append(baseEl)
            let img = dom.querySelector("img")
            if (img && img.src) item.thumb = img.src
        }
        if (
            item.thumb &&
            !item.thumb.startsWith("https://") &&
            !item.thumb.startsWith("http://")
        ) {
            delete item.thumb
        }
    }
}

export type ItemState = {
    [_id: number]: RSSItem
}

export const FETCH_ITEMS = "FETCH_ITEMS"
export const MARK_READ = "MARK_READ"
export const MARK_ALL_READ = "MARK_ALL_READ"
export const MARK_UNREAD = "MARK_UNREAD"
export const TOGGLE_STARRED = "TOGGLE_STARRED"
export const TOGGLE_HIDDEN = "TOGGLE_HIDDEN"

interface FetchItemsAction {
    type: typeof FETCH_ITEMS
    status: ActionStatus
    fetchCount?: number
    items?: RSSItem[]
    itemState?: ItemState
    errSource?: RSSSource
    err?
}

interface MarkReadAction {
    type: typeof MARK_READ
    item: RSSItem
}

interface MarkAllReadAction {
    type: typeof MARK_ALL_READ
    sids: number[]
    time?: number
    before?: boolean
}

interface MarkUnreadAction {
    type: typeof MARK_UNREAD
    item: RSSItem
}

interface ToggleStarredAction {
    type: typeof TOGGLE_STARRED
    item: RSSItem
}

interface ToggleHiddenAction {
    type: typeof TOGGLE_HIDDEN
    item: RSSItem
}

export type ItemActionTypes =
    | FetchItemsAction
    | MarkReadAction
    | MarkAllReadAction
    | MarkUnreadAction
    | ToggleStarredAction
    | ToggleHiddenAction

export function fetchItemsRequest(fetchCount = 0): ItemActionTypes {
    return {
        type: FETCH_ITEMS,
        status: ActionStatus.Request,
        fetchCount: fetchCount,
    }
}

export function fetchItemsSuccess(
    items: RSSItem[],
    itemState: ItemState
): ItemActionTypes {
    return {
        type: FETCH_ITEMS,
        status: ActionStatus.Success,
        items: items,
        itemState: itemState,
    }
}

export function fetchItemsFailure(source: RSSSource, err): ItemActionTypes {
    return {
        type: FETCH_ITEMS,
        status: ActionStatus.Failure,
        errSource: source,
        err: err,
    }
}

export function fetchItemsIntermediate(): ItemActionTypes {
    return {
        type: FETCH_ITEMS,
        status: ActionStatus.Intermediate,
    }
}

export async function insertItems(items: RSSItem[]): Promise<RSSItem[]> {
    if (items.length === 0) return []
    // Service integrations construct articles without going through RSSItem.
    for (const item of items) {
        item.fetchedDate = getValidDate(item.fetchedDate, item.date)
        item.date = getValidDate(item.date, item.fetchedDate)
    }
    items.sort((a, b) => a.date.getTime() - b.date.getTime())
    const values = items.map(item => ({
        source: item.source,
        guid: item.guid || null,
        title: item.title,
        link: item.link,
        date: item.date,
        fetchedDate: item.fetchedDate,
        thumb: item.thumb || null,
        content: item.content,
        snippet: item.snippet,
        creator: item.creator || null,
        hasRead: item.hasRead,
        starred: item.starred,
        hidden: item.hidden,
        notify: item.notify,
        serviceRef: item.serviceRef || null,
    }))
    return (await database
        .insert(itemsTable)
        .values(values)
        .returning()) as unknown as RSSItem[]
}

export function fetchItems(
    background = false,
    sids: number[] = null
): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        if (isWeb()) {
            // The server is the fetcher. Ask Miniflux for a round, then reload
            // the feed the user is looking at from the BFF.
            const state = getState()
            const feed = state.feeds[state.page.feedId]
            try {
                await fetch(`${location.origin}/api/refresh`, {
                    method: "POST",
                })
                if (feed) {
                    const page = await RSSFeed.loadFeed(feed)
                    dispatch(initFeedSuccess({ ...feed, loaded: true }, page))
                }
                dispatch(updateUnreadCounts())
            } catch (err) {
                console.log(err)
            }
            return
        }
        let promises = new Array<Promise<RSSItem[]>>()
        const initState = getState()
        if (!initState.app.fetchingItems && !initState.app.syncing) {
            if (
                sids === null ||
                sids.filter(
                    sid => initState.sources[sid].serviceRef !== undefined
                ).length > 0
            )
                await dispatch(syncWithService(background))
            let timenow = new Date().getTime()
            const sourcesState = getState().sources
            let sources =
                sids === null
                    ? Object.values(sourcesState).filter(s => {
                          let last = s.lastFetched ? s.lastFetched.getTime() : 0
                          return (
                              !s.serviceRef &&
                              (last > timenow ||
                                  last + (s.fetchFrequency || 0) * 60000 <=
                                      timenow)
                          )
                      })
                    : sids
                          .map(sid => sourcesState[sid])
                          .filter(s => !s.serviceRef)
            for (let source of sources) {
                const state = getState()
                let promise = RSSSource.fetchItems(
                    source,
                    getRulesForTarget(state.rules, state.groups, {
                        type: "source",
                        sid: source.sid,
                    })
                )
                promise.then(() =>
                    dispatch(
                        updateSource({ ...source, lastFetched: new Date() })
                    )
                )
                promise.finally(() => dispatch(fetchItemsIntermediate()))
                promises.push(promise)
            }
            dispatch(fetchItemsRequest(promises.length))
            const results = await Promise.allSettled(promises)
            return await new Promise<void>((resolve, reject) => {
                let items = new Array<RSSItem>()
                results.map((r, i) => {
                    if (r.status === "fulfilled") items.push(...r.value)
                    else {
                        console.log(r.reason)
                        dispatch(fetchItemsFailure(sources[i], r.reason))
                    }
                })
                insertItems(items)
                    .then(inserted => {
                        dispatch(
                            fetchItemsSuccess(
                                inserted.reverse(),
                                getState().items
                            )
                        )
                        resolve()
                        if (background) {
                            for (let item of inserted) {
                                if (item.notify) {
                                    dispatch(pushNotification(item))
                                }
                            }
                        } else {
                            dispatch(dismissItems())
                        }
                        dispatch(setupAutoFetch())
                    })
                    .catch(err => {
                        dispatch(fetchItemsSuccess([], getState().items))
                        window.utils.showErrorBox(
                            "A database error has occurred.",
                            String(err)
                        )
                        console.log(err)
                        reject(err)
                    })
            })
        }
    }
}

const markReadDone = (item: RSSItem): ItemActionTypes => ({
    type: MARK_READ,
    item: item,
})

const markUnreadDone = (item: RSSItem): ItemActionTypes => ({
    type: MARK_UNREAD,
    item: item,
})

export function markRead(item: RSSItem): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        item = getState().items[item._id]
        if (!item.hasRead) {
            if (isWeb()) {
                // Paint first, write later: a keypress must not wait for a
                // round trip, and the queue folds bursts into one request.
                dispatch(markReadDone(item))
                const id = item._id
                queueReadState(id, true, () =>
                    dispatch(markUnreadDone(getState().items[id]))
                )
            } else {
                await database
                    .update(itemsTable)
                    .set({ hasRead: true })
                    .where(eq(itemsTable._id, item._id))
                dispatch(markReadDone(item))
            }
            if (item.serviceRef) dispatch(pushReadState(item, true))
        }
    }
}

export function markAllRead(
    sids: number[] = null,
    date: Date = null,
    before = true
): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        let state = getState()
        if (sids === null) {
            let feed = state.feeds[state.page.feedId]
            sids = feed.sids
        }
        if (sids.length === 0) return
        const action = dispatch(getServiceHooks()).markAllRead?.(
            sids,
            date,
            before
        )
        if (action) await dispatch(action)
        const conditions = [
            inArray(itemsTable.source, sids),
            eq(itemsTable.hasRead, false),
        ]
        if (date) {
            conditions.push(
                before ? lte(itemsTable.date, date) : gte(itemsTable.date, date)
            )
        }
        if (isWeb()) {
            // One request for the whole group instead of one per source. The
            // date cutoff is not honored by the BFF.
            await markSourcesRead(sids)
        } else {
            await database
                .update(itemsTable)
                .set({ hasRead: true })
                .where(and(...conditions))
        }
        if (date) {
            dispatch({
                type: MARK_ALL_READ,
                sids: sids,
                time: date.getTime(),
                before: before,
            })
            dispatch(updateUnreadCounts())
        } else {
            dispatch({
                type: MARK_ALL_READ,
                sids: sids,
            })
        }
    }
}

export function markUnread(item: RSSItem): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        item = getState().items[item._id]
        if (item.hasRead) {
            if (isWeb()) {
                dispatch(markUnreadDone(item))
                const id = item._id
                queueReadState(id, false, () =>
                    dispatch(markReadDone(getState().items[id]))
                )
            } else {
                await database
                    .update(itemsTable)
                    .set({ hasRead: false })
                    .where(eq(itemsTable._id, item._id))
                dispatch(markUnreadDone(item))
            }
            if (item.serviceRef) dispatch(pushReadState(item, false))
        }
    }
}

const toggleStarredDone = (item: RSSItem): ItemActionTypes => ({
    type: TOGGLE_STARRED,
    item: item,
})

export function toggleStarred(item: RSSItem): AppThunk<Promise<void>> {
    return async dispatch => {
        if (isWeb()) {
            await setStar(item._id, !item.starred)
        } else {
            await database
                .update(itemsTable)
                .set({ starred: !item.starred })
                .where(eq(itemsTable._id, item._id))
        }
        dispatch(toggleStarredDone(item))
        if (item.serviceRef) {
            const hooks = dispatch(getServiceHooks())
            if (item.starred) dispatch(hooks.unstar?.(item))
            else dispatch(hooks.star?.(item))
        }
    }
}

const toggleHiddenDone = (item: RSSItem): ItemActionTypes => ({
    type: TOGGLE_HIDDEN,
    item: item,
})

export function toggleHidden(item: RSSItem): AppThunk<Promise<void>> {
    return async dispatch => {
        // "Hidden" is a local preference; the BFF has no field for it.
        if (!isWeb()) {
            await database
                .update(itemsTable)
                .set({ hidden: !item.hidden })
                .where(eq(itemsTable._id, item._id))
        }
        dispatch(toggleHiddenDone(item))
    }
}

const FOCUS_RETRY_TIMEOUT = 1200
const FOCUS_RETRY_INTERVAL = 50
// How many scroll nudges may accompany a pending focus. Together with the grace
// frames this covers a full viewport of virtualized pages.
const FOCUS_FORCE_RENDER_TRIES = 8 + 3

let keyboardFocusId: number | null = null
let lastFeedId: string | number | null = null
let focusGeneration = 0
const markReadQueue = new StepQueue()

type FocusScrollIntent = { mode: ScrollMode } | { position: FocusPosition }

type ShortcutState = {
    page?: {
        feedId?: string | number
        itemId?: number | null
        viewType?: number
    }
    feeds?: any
    app?: ShortcutAppState
}

function scheduleFocusAttempt(attempt: () => void) {
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(attempt)
    } else if (typeof setTimeout === "function") {
        setTimeout(attempt, FOCUS_RETRY_INTERVAL)
    }
}

// The row a focus attempt is currently travelling to. While it is pending the
// DOM still holds focus on the previous card, so a keypress arriving from that
// card must not re-anchor the walk there: doing so recomputes the same target
// and the cursor looks stuck in a loop.
let pendingFocusId: number | null = null

function clearPendingFocus() {
    pendingFocusId = null
}

function getActiveCardId(): number | null {
    if (typeof document === "undefined" || !document.activeElement) return null
    const el = document.activeElement as HTMLElement
    if (typeof el.getAttribute !== "function") return null
    const raw = el.getAttribute("data-iid")
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) ? id : null
}

function getScrollContainer(): HTMLElement | null {
    if (typeof document === "undefined" || !document.getElementById) {
        return null
    }
    return document.getElementById("refocus")
}

function getNavBottom(containerTop: number): number {
    if (typeof document === "undefined" || !document.querySelector) {
        return containerTop
    }
    const nav = document.querySelector("nav") as HTMLElement | null
    if (!nav || typeof nav.getBoundingClientRect !== "function") {
        return containerTop
    }
    const rect = nav.getBoundingClientRect()
    return Number.isFinite(rect.bottom) ? rect.bottom : containerTop
}

function scrollCardIntoPlace(target: HTMLElement, intent: FocusScrollIntent) {
    const container = getScrollContainer()
    if (!container || !intent) return
    const cardRect = target.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const cardTop = cardRect.top - containerRect.top + container.scrollTop
    const cardHeight = cardRect.height || target.offsetHeight || 0
    const topInset = measureVisibleTopInset(
        containerRect.top,
        getNavBottom(containerRect.top),
        container.clientHeight
    )
    const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
    )
    const nextTop =
        "position" in intent
            ? computeCycleScrollTop(
                  intent.position,
                  cardTop,
                  cardHeight,
                  container.scrollTop,
                  container.clientHeight,
                  topInset,
                  maxScrollTop
              )
            : computeDirectionalScrollTop(
                  cardTop,
                  cardHeight,
                  container.scrollTop,
                  container.clientHeight,
                  topInset,
                  maxScrollTop,
                  intent.mode
              )
    container.scrollTop = nextTop
}

function isFocusContextActive(
    getState: () => any,
    feedId: string | number,
    id: number
): boolean {
    const state: ShortcutState = getState()
    if (!state || !state.page) return false
    if (state.page.feedId !== feedId) return false
    if (isOverlayOpen(state.app as ShortcutAppState)) return false
    const feed = state.feeds ? state.feeds[feedId] : null
    if (!feed || !Array.isArray(feed.iids) || !feed.iids.includes(id)) {
        return false
    }
    return true
}

/** Where the row with `index` should sit, given only the container's height. */
function estimateCardScrollTop(
    container: HTMLElement,
    index: number,
    count: number
): number | null {
    if (index < 0 || count <= 0) return null
    const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
    )
    if (maxScrollTop <= 0) return null
    const ratio = (index + 0.5) / count
    const target = ratio * container.scrollHeight - container.clientHeight / 2
    return Math.max(0, Math.min(maxScrollTop, target))
}

/**
 * Offsets (in viewport heights) tried around the estimated position. Virtualized
 * lists only materialize pages near the viewport and the ratio above is only an
 * approximation of the row height, so the first guess can be off by a page.
 * Scanning both ways a few times lands on the target without assuming the
 * estimate is exact.
 */
const FORCE_RENDER_OFFSETS = [0, -0.5, 0.5, -1, 1, -1.5, 1.5, -2]

// Frames to let React flush before concluding that the row will never appear on
// its own. Rows that are about to be rendered arrive within this grace period,
// and scrolling first would yank the list out from under an ordinary keypress.
const FOCUS_RENDER_GRACE_FRAMES = 3

/**
 * Move the container so the list materializes the row we are about to focus.
 *
 * The feed keeps lists virtualized: only pages near the viewport exist in the
 * DOM, so a row below the fold has no node to focus. Scrolling is what makes the
 * list render it, so waiting for the node to appear on its own deadlocks — the
 * cursor stops at the last rendered row and each further keypress re-anchors
 * there.
 */
function scrollToForceRender(
    container: HTMLElement,
    anchor: number,
    attempt: number,
    intent?: FocusScrollIntent
): boolean {
    const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
    )
    if (maxScrollTop <= 0) return false
    const step =
        FORCE_RENDER_OFFSETS[Math.min(attempt, FORCE_RENDER_OFFSETS.length - 1)]
    const bias = intent && "mode" in intent && intent.mode === "up" ? -1 : 1
    const before = container.scrollTop
    const target = anchor + step * container.clientHeight * bias
    container.scrollTop = Math.max(0, Math.min(maxScrollTop, target))
    return Math.abs(container.scrollTop - before) > 1
}

function focusCardWhenReady(
    getState: () => any,
    id: number,
    intent?: FocusScrollIntent
) {
    if (typeof document === "undefined" || !document.querySelector) return
    const state: ShortcutState = getState()
    if (!state || !state.page) return
    const feedId = state.page.feedId
    const token = ++focusGeneration
    const selector = `[data-iid="${id}"]`
    const deadline = Date.now() + FOCUS_RETRY_TIMEOUT
    const findCard = () =>
        document.querySelector(selector) as HTMLElement | null
    const container = getScrollContainer()
    const feed = state.feeds ? state.feeds[feedId] : null
    const iids: number[] = feed && Array.isArray(feed.iids) ? feed.iids : []
    // Anchor the scan where the row should be, falling back to where we are.
    const anchor =
        (container &&
            estimateCardScrollTop(container, iids.indexOf(id), iids.length)) ??
        (container ? container.scrollTop : 0)
    let forced = 0
    pendingFocusId = id

    const finish = () => {
        if (pendingFocusId === id) pendingFocusId = null
    }

    const attempt = () => {
        if (token !== focusGeneration) return
        if (!isFocusContextActive(getState, feedId, id)) {
            finish()
            return
        }
        const target = findCard()
        if (target) {
            // FocusZone assigns tabindex only after it observes a card. Newly
            // appended virtualized cards have none yet, and focus() is a no-op
            // without it.
            if (!target.hasAttribute("tabindex")) {
                target.setAttribute("tabindex", "-1")
            }
            scrollCardIntoPlace(target, intent)
            try {
                target.focus({ preventScroll: true })
            } catch {
                target.focus()
            }
            finish()
            return
        }
        if (Date.now() >= deadline) {
            finish()
            return
        }
        // The card is not rendered yet. Give React a couple of frames first: a
        // row that is about to render must not yank the list around. Only then
        // assume it sits outside the virtualized window, where scrolling is the
        // only thing that makes the list create its node.
        const waited = forced + 1
        if (
            container &&
            waited > FOCUS_RENDER_GRACE_FRAMES &&
            forced < FOCUS_FORCE_RENDER_TRIES
        ) {
            scrollToForceRender(
                container,
                anchor,
                forced - FOCUS_RENDER_GRACE_FRAMES,
                intent
            )
        }
        forced = waited
        scheduleFocusAttempt(attempt)
    }

    attempt()
}

export function cancelPendingMarkRead(): void {
    markReadQueue.cancelPending()
}

export function resetItemShortcutState(): void {
    markReadQueue.cancelPending()
    keyboardFocusId = null
    clearPendingFocus()
    resetPositionCycle()
}

export function noteCardFocus(id: number | null): void {
    if (id === null || !Number.isFinite(id)) return
    // Real DOM focus is the ground truth: a click, Tab or a landed programmatic
    // focus all report here. Keeping the walk cursor in sync with it is what
    // makes an ordinary keypress safe to act on without re-anchoring, and it
    // stops a failed focus attempt from pinning the cursor to a stale row.
    keyboardFocusId = id
    clearPendingFocus()
    resetPositionCycle()
}

export function whenMarkReadQueueIdle(): Promise<void> {
    return markReadQueue.whenIdle()
}

function enqueueMarkReadAndNext(
    dispatch,
    getState,
    item: RSSItem,
    repeat: boolean
) {
    const startFeedId = getState().page.feedId
    // The walk cursor — not the card that fired the keydown — says where the
    // reader is. focusin (noteCardFocus) keeps it in sync with real DOM focus,
    // so the two only differ while a programmatic focus is still travelling to
    // a row the virtualized list has not rendered yet. Re-anchoring on the old
    // card there would recompute the same target forever: the stuck loop.
    if (keyboardFocusId === null) keyboardFocusId = item._id
    markReadQueue.enqueue(async () => {
        const state = getState()
        if (!navigationStillValid(startFeedId, state.page.feedId)) return
        const currentId = keyboardFocusId
        if (currentId === null) return
        const feed = state.feeds[startFeedId]
        const currentItem = state.items[currentId] || item
        if (!feed || !currentItem) return
        const order = [...feed.iids]
        const step = planMarkReadStep(order, currentItem._id, feed.allLoaded)
        const nextId = step.nextId
        const needLoadMore = step.loadMore
        // Mark read is never a toggle: an already-read row stays read.
        await dispatch(markRead(currentItem))
        if (!navigationStillValid(startFeedId, getState().page.feedId)) return
        if (nextId !== null) {
            keyboardFocusId = nextId
            focusCardWhenReady(getState, nextId, { mode: "down" })
            return
        }
        if (!needLoadMore) return
        try {
            await dispatch(loadMore(feed))
        } catch {
            return
        }
        if (!navigationStillValid(startFeedId, getState().page.feedId)) return
        const nextFeed = getState().feeds[startFeedId]
        if (!nextFeed) return
        // Under an unread filter the just-read anchor disappears from iids, so
        // follow the surviving suffix / newly appended rows instead.
        const anchorPreserved = nextFeed.iids.includes(currentItem._id)
        const loadedNextId = anchorPreserved
            ? getNextItemId(nextFeed.iids, currentItem._id)
            : pickNextAfterRemoval(order, nextFeed.iids, currentItem._id)
        if (loadedNextId !== null) {
            keyboardFocusId = loadedNextId
            focusCardWhenReady(getState, loadedNextId, { mode: "down" })
        }
    })
}

function moveFocus(
    dispatch,
    getState,
    item: RSSItem,
    e: KeyboardEvent,
    direction: -1 | 1
) {
    e.preventDefault()
    resetPositionCycle()
    const state = getState()
    const feedId = state.page.feedId
    const feed = state.feeds[feedId]
    if (!feed) return
    // Same rule as mark-read-and-next: the walk cursor is authoritative, and
    // focusin keeps it equal to the real DOM focus whenever focus actually
    // lands. A keypress from a card the cursor has already left therefore moves
    // on instead of stepping back.
    if (keyboardFocusId === null) keyboardFocusId = item._id
    let index = feed.iids.indexOf(keyboardFocusId)
    if (index < 0) {
        keyboardFocusId = item._id
        index = feed.iids.indexOf(keyboardFocusId)
    }
    if (index < 0) return
    const anchorId = keyboardFocusId
    const targetIndex = index + direction
    if (targetIndex < 0) {
        keyboardFocusId = feed.iids[0]
        focusCardWhenReady(getState, feed.iids[0], { mode: "up" })
        return
    }
    if (targetIndex >= feed.iids.length) {
        if (direction > 0 && !feed.allLoaded && !feed.loading) {
            dispatch(loadMore(feed))
                .then(() => {
                    const nextState = getState()
                    if (!navigationStillValid(feedId, nextState.page.feedId))
                        return
                    const nextFeed = nextState.feeds[feedId]
                    if (!nextFeed) return
                    const loadedNextId = getNextItemId(nextFeed.iids, anchorId)
                    if (loadedNextId !== null) {
                        keyboardFocusId = loadedNextId
                        focusCardWhenReady(getState, loadedNextId, {
                            mode: "down",
                        })
                    }
                })
                .catch(() => {})
        }
        return
    }
    const nextId = feed.iids[targetIndex]
    keyboardFocusId = nextId
    focusCardWhenReady(getState, nextId, {
        mode: direction > 0 ? "down" : "up",
    })
}

function cycleFocusedPosition(
    getState: () => any,
    item: RSSItem,
    e: KeyboardEvent
) {
    e.preventDefault()
    const state: ShortcutState = getState()
    const feed = state.feeds ? state.feeds[state.page.feedId] : null
    const iids: number[] = feed && Array.isArray(feed.iids) ? feed.iids : []
    const activeId = getActiveCardId()
    // Prefer the row the user actually has focused, then the tracked id, then
    // the card that fired the event — but only when it belongs to this feed.
    const candidates = [activeId, keyboardFocusId, item._id]
    let targetId: number | null = null
    for (const candidate of candidates) {
        if (
            candidate !== null &&
            candidate !== undefined &&
            iids.includes(candidate)
        ) {
            targetId = candidate
            break
        }
    }
    if (targetId === null) return
    // A different row than the cycle was running on means the user moved focus;
    // start the cycle over at center for it.
    if (keyboardFocusId !== null && keyboardFocusId !== targetId) {
        resetPositionCycle()
    }
    keyboardFocusId = targetId
    focusCardWhenReady(getState, targetId, {
        position: focusPositionCycle.applyCurrent(),
    })
}

// "list": a key pressed on a focused list card, acting on that card's item.
// "article": a key pressed in the open article, including keys forwarded from
// its webview, acting on the open item.
export type ItemShortcutOrigin = "list" | "article"

export function itemShortcuts(
    item: RSSItem,
    e: KeyboardEvent,
    origin: ItemShortcutOrigin = "list"
): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const fromArticle = origin === "article"
        if (e.metaKey) return
        const state = getState()
        const feedId = state.page.feedId
        if (lastFeedId !== null && lastFeedId !== feedId) {
            // Never carry a focus id, position cycle or backlog across feeds.
            resetItemShortcutState()
            focusGeneration += 1
        }
        lastFeedId = feedId
        const activeElement =
            typeof document !== "undefined" ? document.activeElement : null
        if (
            isComposingEvent(e) ||
            isEditableTarget(e.target) ||
            isEditableTarget(activeElement) ||
            isOverlayOpen(state.app) ||
            // The open article's webview holds focus while it is shown, so
            // only list keys are inert there.
            (!fromArticle && isWebviewActive(activeElement))
        ) {
            return
        }
        const action = fromArticle
            ? null
            : getCardShortcutAction(e, state.app, activeElement)
        switch (action) {
            case "markReadAndNext":
                e.preventDefault()
                e.stopPropagation()
                enqueueMarkReadAndNext(dispatch, getState, item, e.repeat)
                return
            case "moveUp":
                e.stopPropagation()
                moveFocus(dispatch, getState, item, e, -1)
                return
            case "moveDown":
                e.stopPropagation()
                moveFocus(dispatch, getState, item, e, 1)
                return
            case "cyclePosition":
                e.stopPropagation()
                cycleFocusedPosition(getState, item, e)
                return
        }
        if (e.ctrlKey || e.altKey) return
        switch (e.key) {
            case "m":
            case "M":
                if (item.hasRead) dispatch(markUnread(item))
                else dispatch(markRead(item))
                break
            case "b":
            case "B":
                if (!item.hasRead) dispatch(markRead(item))
                window.utils.openExternal(item.link, platformCtrl(e))
                break
            case "s":
            case "S":
                dispatch(toggleStarred(item))
                break
            case "h":
            case "H":
                if (!item.hasRead && !item.hidden) dispatch(markRead(item))
                dispatch(toggleHidden(item))
                break
        }
    }
}

export function applyItemReduction(item: RSSItem, type: string) {
    let nextItem = { ...item }
    switch (type) {
        case MARK_READ:
        case MARK_UNREAD: {
            nextItem.hasRead = type === MARK_READ
            break
        }
        case TOGGLE_STARRED: {
            nextItem.starred = !item.starred
            break
        }
        case TOGGLE_HIDDEN: {
            nextItem.hidden = !item.hidden
            break
        }
    }
    return nextItem
}

export function itemReducer(
    state: ItemState = {},
    action:
        | ItemActionTypes
        | FeedActionTypes
        | ServiceActionTypes
        | SettingsActionTypes
): ItemState {
    switch (action.type) {
        case FETCH_ITEMS:
            switch (action.status) {
                case ActionStatus.Success: {
                    let newMap = {}
                    for (let i of action.items) {
                        newMap[i._id] = i
                    }
                    return { ...newMap, ...state }
                }
                default:
                    return state
            }
        case MARK_UNREAD:
        case MARK_READ:
        case TOGGLE_STARRED:
        case TOGGLE_HIDDEN: {
            return {
                ...state,
                [action.item._id]: applyItemReduction(
                    state[action.item._id],
                    action.type
                ),
            }
        }
        case MARK_ALL_READ: {
            let nextState = { ...state }
            let sids = new Set(action.sids)
            for (let item of Object.values(state)) {
                if (sids.has(item.source) && !item.hasRead) {
                    if (
                        !action.time ||
                        (action.before
                            ? item.date.getTime() <= action.time
                            : item.date.getTime() >= action.time)
                    ) {
                        nextState[item._id] = {
                            ...item,
                            hasRead: true,
                        }
                    }
                }
            }
            return nextState
        }
        case LOAD_MORE:
        case INIT_FEED: {
            switch (action.status) {
                case ActionStatus.Success: {
                    let nextState = { ...state }
                    // A page can hand back rows it did not display yet (the feed
                    // keeps them for the next "load more"). They must be in the
                    // item store already, or that page has nothing to show.
                    for (let i of [
                        ...(action.items ?? []),
                        ...(action.carry ?? []),
                    ]) {
                        nextState[i._id] = i
                    }
                    return nextState
                }
                default:
                    return state
            }
        }
        case SYNC_LOCAL_ITEMS: {
            let nextState = { ...state }
            for (let item of Object.values(state)) {
                // Local SQLite rows also have serviceRef, with a null value.
                if (item.serviceRef) {
                    const nextItem = { ...item }
                    nextItem.hasRead = !action.unreadIds.has(item.serviceRef)
                    nextItem.starred = action.starredIds.has(item.serviceRef)
                    nextState[item._id] = nextItem
                }
            }
            return nextState
        }
        case FREE_MEMORY: {
            const nextState: ItemState = {}
            for (let item of Object.values(state)) {
                if (action.iids.has(item._id)) nextState[item._id] = item
            }
            return nextState
        }
        default:
            return state
    }
}
