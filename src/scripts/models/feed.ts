import { database, itemsTable } from "../db"
import { and, eq, inArray, desc, sql } from "drizzle-orm"
import {
    SourceActionTypes,
    INIT_SOURCES,
    ADD_SOURCE,
    DELETE_SOURCE,
    UNHIDE_SOURCE,
    HIDE_SOURCE,
} from "./source"
import {
    ItemActionTypes,
    FETCH_ITEMS,
    RSSItem,
    TOGGLE_HIDDEN,
    applyItemReduction,
} from "./item"
import { ActionStatus, AppThunk, mergeSortedArrays } from "../utils"
import { PageActionTypes, SELECT_PAGE, PageType, APPLY_FILTER } from "./page"
import { fetchItems, isWeb } from "./net/bff"
import type { ApiItem } from "./net/bff"
import { flushReadQueue } from "./net/read-queue"

export enum FilterType {
    None,
    ShowRead = 1 << 0,
    ShowNotStarred = 1 << 1,
    ShowHidden = 1 << 2,
    FullSearch = 1 << 3,
    CaseInsensitive = 1 << 4,
    CreatorSearch = 1 << 5,

    Default = ShowRead | ShowNotStarred,
    UnreadOnly = ShowNotStarred,
    StarredOnly = ShowRead,
    Toggles = ShowHidden | FullSearch | CaseInsensitive,
}
export class FeedFilter {
    type: FilterType
    search: string

    constructor(type: FilterType = null, search = "") {
        if (
            type === null &&
            (type = window.settings.getFilterType()) === null
        ) {
            type = FilterType.Default | FilterType.CaseInsensitive
        }
        this.type = type
        this.search = search
    }

    static testItem(filter: FeedFilter, item: RSSItem) {
        let type = filter.type
        let flag = true
        if (!(type & FilterType.ShowRead)) flag = flag && !item.hasRead
        if (!(type & FilterType.ShowNotStarred)) flag = flag && item.starred
        if (!(type & FilterType.ShowHidden)) flag = flag && !item.hidden
        if (filter.search !== "") {
            const flags = type & FilterType.CaseInsensitive ? "i" : ""
            const regex = RegExp(filter.search, flags)
            if (type & FilterType.FullSearch) {
                flag =
                    flag && (regex.test(item.title) || regex.test(item.snippet))
            } else if (type & FilterType.CreatorSearch) {
                flag = flag && regex.test(item.creator || "")
            } else {
                flag = flag && regex.test(item.title)
            }
        }
        return Boolean(flag)
    }
}

export const ALL = "ALL"
export const SOURCE = "SOURCE"

const LOAD_QUANTITY = 50

/**
 * Build an RSSItem from a BFF row. Object.create keeps the prototype (instance
 * helpers still work) without running the parser constructor.
 */
function toRssItem(raw: ApiItem): RSSItem {
    const item = Object.create(RSSItem.prototype) as RSSItem
    Object.assign(item, {
        _id: raw._id,
        source: raw.source,
        title: raw.title,
        link: raw.link,
        date: new Date(raw.date),
        fetchedDate: new Date(raw.date),
        thumb: raw.thumb ?? undefined,
        content: "",
        snippet: raw.snippet,
        creator: raw.creator ?? undefined,
        hasRead: raw.hasRead,
        starred: raw.starred,
        hidden: false,
        notify: false,
    })
    return item
}

/**
 * One page of a feed. `next` is the cursor the server reports for the following
 * page (null when it has no more); `carry` holds rows that were fetched but did
 * not fit the display quota, so the next page can show them without asking the
 * server for rows it already handed over.
 */
export type FeedPage = {
    items: RSSItem[]
    next: number | null
    carry: RSSItem[]
}

export type FeedLoadOptions = {
    /**
     * Drop rows the feed already lists. Only appended pages want this: the
     * first page replaces the order, so filtering it there would discard the
     * rows the caller is about to throw away anyway.
     */
    skipKnown?: boolean
}

// A group is a filter over one global list, so a page of 50 rows can be almost
// entirely foreign. Keep requesting until the quota is met instead of reporting
// a short page as "everything is loaded"; a narrow group stops after this many
// pages and continues on the next keypress/click.
const MAX_PAGES_PER_LOAD = 5

function pageOf(items: RSSItem[], next: number | null): FeedPage {
    return { items, next, carry: [] }
}

/**
 * Append a page to the visible order, skipping ids that are already listed.
 * Offsets are approximate while reads are in flight, so an overlapping page is
 * expected; a second copy of a row is not, because every focus helper resolves
 * an id with indexOf and would bounce between the copies.
 */
function appendUniqueIds(existing: number[], items: RSSItem[]): number[] {
    const seen = new Set(existing)
    const next = [...existing]
    for (const item of items ?? []) {
        if (seen.has(item._id)) continue
        seen.add(item._id)
        next.push(item._id)
    }
    return next
}

/**
 * A feed is exhausted when the server has no cursor left and nothing is held
 * back. A short page alone proves nothing: a group slices a global window, so it
 * can return fewer rows than the quota with plenty more still to come.
 */
function isFeedExhausted(
    next: number | null | undefined,
    carry: RSSItem[] | undefined,
    items: RSSItem[] | undefined
): boolean {
    if ((carry?.length ?? 0) > 0) return false
    if (next === null) return true
    if (next === undefined) return (items?.length ?? 0) < LOAD_QUANTITY
    return false
}

export class RSSFeed {
    _id: string
    loaded: boolean
    loading: boolean
    allLoaded: boolean
    sids: number[]
    iids: number[]
    filter: FeedFilter
    /** Server cursor for the next page. Null means the server has no more. */
    next: number | null
    /** Rows already fetched but not yet displayed, oldest first. */
    carry: number[]
    /** Read rows among iids at the moment `next` was issued. */
    readAtCursor: number

    constructor(id: string = null, sids = [], filter = null) {
        this._id = id
        this.sids = sids
        this.iids = []
        this.loaded = false
        this.allLoaded = false
        this.filter = filter === null ? new FeedFilter() : filter
        this.next = null
        this.carry = []
        this.readAtCursor = 0
    }

    static async loadFeed(
        feed: RSSFeed,
        cursor = 0,
        options: FeedLoadOptions = {}
    ): Promise<FeedPage> {
        if (feed.sids.length === 0) return pageOf([], null)
        const filter = feed.filter
        const type = filter.type
        if (isWeb()) {
            const single = feed.sids.length === 1
            const limit = single ? LOAD_QUANTITY : LOAD_QUANTITY * 4
            // An offset can only be approximate while reads are in flight, so a
            // page for "load more" may hand back rows that were just shown.
            // Skipping them keeps the page at LOAD_QUANTITY genuinely new rows
            // instead of shrinking to a handful and looking like the end.
            const known = options.skipKnown
                ? new Set(feed.iids ?? [])
                : new Set<number>()
            const collect = (page: RSSItem[]) =>
                page.filter(
                    item =>
                        !known.has(item._id) &&
                        (single || feed.sids.includes(item.source))
                )
            let taken = new Array<RSSItem>()
            let next: number | null = cursor
            for (let i = 0; i < MAX_PAGES_PER_LOAD; i += 1) {
                if (next === null || taken.length >= LOAD_QUANTITY) break
                const response = await fetchItems({
                    source: single ? feed.sids[0] : undefined,
                    unread: !(type & FilterType.ShowRead),
                    starred: !(type & FilterType.ShowNotStarred),
                    search: filter.search || undefined,
                    limit,
                    offset: next,
                })
                for (const item of collect(response.items.map(toRssItem))) {
                    known.add(item._id)
                    taken.push(item)
                }
                // Only an explicit null (or an empty page) ends the feed. A page
                // of nothing but foreign or already-shown rows says nothing
                // about whether the group/list has more.
                next =
                    response.next === null || response.items.length === 0
                        ? null
                        : response.next
            }
            const shown = taken.slice(0, LOAD_QUANTITY)
            const rest = taken.slice(LOAD_QUANTITY)
            return { items: shown, next, carry: rest }
        }
        const conditions = [inArray(itemsTable.source, feed.sids)]
        if (!(type & FilterType.ShowRead))
            conditions.push(eq(itemsTable.hasRead, false))
        if (!(type & FilterType.ShowNotStarred))
            conditions.push(eq(itemsTable.starred, true))
        if (!(type & FilterType.ShowHidden))
            conditions.push(eq(itemsTable.hidden, false))
        if (filter.search !== "") {
            const pattern = filter.search
            if (type & FilterType.FullSearch) {
                if (type & FilterType.CaseInsensitive) {
                    conditions.push(
                        sql`(regexpi(${pattern}, ${itemsTable.title}) OR regexpi(${pattern}, ${itemsTable.snippet}))`
                    )
                } else {
                    conditions.push(
                        sql`(regexp(${pattern}, ${itemsTable.title}) OR regexp(${pattern}, ${itemsTable.snippet}))`
                    )
                }
            } else if (type & FilterType.CreatorSearch) {
                if (type & FilterType.CaseInsensitive) {
                    conditions.push(
                        sql`regexpi(${pattern}, ${itemsTable.creator})`
                    )
                } else {
                    conditions.push(
                        sql`regexp(${pattern}, ${itemsTable.creator})`
                    )
                }
            } else {
                if (type & FilterType.CaseInsensitive) {
                    conditions.push(
                        sql`regexpi(${pattern}, ${itemsTable.title})`
                    )
                } else {
                    conditions.push(
                        sql`regexp(${pattern}, ${itemsTable.title})`
                    )
                }
            }
        }
        const local = (await database
            .select()
            .from(itemsTable)
            .where(and(...conditions))
            .orderBy(desc(itemsTable.date))
            .offset(cursor)
            .limit(LOAD_QUANTITY)) as unknown as RSSItem[]
        // SQLite pages by offset too, and a short page is the only end signal it
        // gives: the local list is already narrowed by the filter.
        const exhausted = local.length < LOAD_QUANTITY
        return pageOf(local, exhausted ? null : cursor + local.length)
    }
}

export type FeedState = {
    [_id: string]: RSSFeed
}

export const INIT_FEEDS = "INIT_FEEDS"
export const INIT_FEED = "INIT_FEED"
export const LOAD_MORE = "LOAD_MORE"
export const DISMISS_ITEMS = "DISMISS_ITEMS"

interface initFeedsAction {
    type: typeof INIT_FEEDS
    status: ActionStatus
}

interface initFeedAction {
    type: typeof INIT_FEED
    status: ActionStatus
    feed?: RSSFeed
    items?: RSSItem[]
    next?: number | null
    carry?: RSSItem[]
    readAtCursor?: number
    err?
}

interface loadMoreAction {
    type: typeof LOAD_MORE
    status: ActionStatus
    feed: RSSFeed
    items?: RSSItem[]
    next?: number | null
    carry?: RSSItem[]
    readAtCursor?: number
    err?
}

interface dismissItemsAction {
    type: typeof DISMISS_ITEMS
    fid: string
    iids: Set<number>
}

export type FeedActionTypes =
    | initFeedAction
    | initFeedsAction
    | loadMoreAction
    | dismissItemsAction

export function dismissItems(): AppThunk {
    return (dispatch, getState) => {
        const state = getState()
        let fid = state.page.feedId
        let filter = state.feeds[fid].filter
        let iids = new Set<number>()
        for (let iid of state.feeds[fid].iids) {
            let item = state.items[iid]
            if (!FeedFilter.testItem(filter, item)) {
                iids.add(iid)
            }
        }
        dispatch({
            type: DISMISS_ITEMS,
            fid: fid,
            iids: iids,
        })
    }
}

export function initFeedsRequest(): FeedActionTypes {
    return {
        type: INIT_FEEDS,
        status: ActionStatus.Request,
    }
}
export function initFeedsSuccess(): FeedActionTypes {
    return {
        type: INIT_FEEDS,
        status: ActionStatus.Success,
    }
}

export function initFeedSuccess(
    feed: RSSFeed,
    page: FeedPage
): FeedActionTypes {
    return {
        type: INIT_FEED,
        status: ActionStatus.Success,
        items: page.items,
        next: page.next,
        carry: page.carry,
        // A page fetched under the unread filter is all unread by definition.
        readAtCursor: 0,
        feed: feed,
    }
}

export function initFeedFailure(err): FeedActionTypes {
    return {
        type: INIT_FEED,
        status: ActionStatus.Failure,
        err: err,
    }
}

export function initFeeds(force = false): AppThunk<Promise<void>> {
    return (dispatch, getState) => {
        dispatch(initFeedsRequest())
        let promises = new Array<Promise<void>>()
        for (let feed of Object.values(getState().feeds)) {
            if (!feed.loaded || force) {
                let p = RSSFeed.loadFeed(feed)
                    .then(page => {
                        dispatch(initFeedSuccess(feed, page))
                    })
                    .catch(err => {
                        console.log(err)
                        dispatch(initFeedFailure(err))
                    })
                promises.push(p)
            }
        }
        return Promise.allSettled(promises).then(() => {
            dispatch(initFeedsSuccess())
        })
    }
}

export function loadMoreRequest(feed: RSSFeed): FeedActionTypes {
    return {
        type: LOAD_MORE,
        status: ActionStatus.Request,
        feed: feed,
    }
}

export function loadMoreSuccess(
    feed: RSSFeed,
    page: FeedPage,
    readAtCursor = 0
): FeedActionTypes {
    return {
        type: LOAD_MORE,
        status: ActionStatus.Success,
        feed: feed,
        items: page.items,
        next: page.next,
        carry: page.carry,
        readAtCursor,
    }
}

export function loadMoreFailure(feed: RSSFeed, err): FeedActionTypes {
    return {
        type: LOAD_MORE,
        status: ActionStatus.Failure,
        feed: feed,
        err: err,
    }
}

export function loadMore(feed: RSSFeed): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        if (!feed.loaded || feed.loading || feed.allLoaded) {
            return Promise.reject()
        }
        dispatch(loadMoreRequest(feed))
        // A pending read write moves rows out of the server's unread list, so an
        // offset taken before it lands would overlap the page just shown and
        // duplicate rows. Send them first, then page from the server's cursor.
        await flushReadQueue()
        const state = getState()
        const carried = (feed.carry ?? [])
            .map(iid => state.items[iid])
            .filter(Boolean)
        // Carried rows were already handed over by the server; show them before
        // asking for anything new, or a group feed would keep re-requesting the
        // same global window.
        const shown = carried.slice(0, LOAD_QUANTITY)
        const rest = carried.slice(LOAD_QUANTITY)
        if (shown.length >= LOAD_QUANTITY || feed.next === null) {
            dispatch(
                loadMoreSuccess(
                    feed,
                    {
                        items: shown,
                        next: feed.next ?? null,
                        carry: rest,
                    },
                    readCount(feed, state)
                )
            )
            return
        }
        return RSSFeed.loadFeed(feed, pageCursor(feed, state), {
            skipKnown: true,
        })
            .then(page => {
                const latest = getState()
                dispatch(
                    loadMoreSuccess(
                        feed,
                        {
                            items: [...shown, ...page.items],
                            next: page.next,
                            carry: page.carry,
                        },
                        // Baseline for the next page: every row read from here on
                        // leaves the server's unread list and shifts it earlier.
                        readCount(feed, latest)
                    )
                )
            })
            .catch(e => {
                console.log(e)
                dispatch(loadMoreFailure(feed, e))
            })
    }
}

/** Rows already listed that the current filter still shows. */
function visibleCount(feed: RSSFeed, state): number {
    return (feed.iids ?? []).filter(iid => {
        const item = state.items[iid]
        return item && FeedFilter.testItem(feed.filter, item)
    }).length
}

/** Read rows among the ids a feed already consumed (displayed or carried). */
function readCount(feed: RSSFeed, state): number {
    const ids = [...(feed.iids ?? []), ...(feed.carry ?? [])]
    return ids.filter(iid => state.items[iid] && state.items[iid].hasRead)
        .length
}

/**
 * The offset to request next.
 *
 * The local SQLite path keeps using "how many matching rows are already shown":
 * the database is the very list being paged, so counting is exact.
 *
 * The web path pages a server list and has to stay in the server's coordinates.
 * That cursor was issued when the current page arrived, and every row read since
 * then has left the server's unread list, shifting the following page one row
 * earlier. `readAtCursor` records how many rows were already read back then, so
 * the difference is exactly the shift. Undercounting only overlaps (harmless
 * here, the append de-duplicates); overcounting would skip rows unseen.
 */
function pageCursor(feed: RSSFeed, state): number {
    if (!isWeb() || feed.next === undefined || feed.next === null) {
        return visibleCount(feed, state)
    }
    // A filter that keeps read rows pages a list the reads do not shrink.
    if (feed.filter.type & FilterType.ShowRead) return feed.next
    const shift = readCount(feed, state) - (feed.readAtCursor ?? 0)
    return Math.max(0, feed.next - Math.max(0, shift))
}

export function feedReducer(
    state: FeedState = { [ALL]: new RSSFeed(ALL) },
    action:
        | SourceActionTypes
        | ItemActionTypes
        | FeedActionTypes
        | PageActionTypes
): FeedState {
    switch (action.type) {
        case INIT_SOURCES:
            switch (action.status) {
                case ActionStatus.Success:
                    return {
                        ...state,
                        [ALL]: new RSSFeed(
                            ALL,
                            Object.values(action.sources)
                                .filter(s => !s.hidden)
                                .map(s => s.sid)
                        ),
                    }
                default:
                    return state
            }
        case ADD_SOURCE:
        case UNHIDE_SOURCE:
            switch (action.status) {
                case ActionStatus.Success:
                    return {
                        ...state,
                        [ALL]: new RSSFeed(
                            ALL,
                            [...state[ALL].sids, action.source.sid],
                            state[ALL].filter
                        ),
                    }
                default:
                    return state
            }
        case DELETE_SOURCE:
        case HIDE_SOURCE: {
            let nextState = {}
            for (let [id, feed] of Object.entries(state)) {
                nextState[id] = new RSSFeed(
                    id,
                    feed.sids.filter(sid => sid != action.source.sid),
                    feed.filter
                )
            }
            return nextState
        }
        case APPLY_FILTER: {
            let nextState = {}
            for (let [id, feed] of Object.entries(state)) {
                nextState[id] = {
                    ...feed,
                    filter: action.filter,
                }
            }
            return nextState
        }
        case FETCH_ITEMS:
            switch (action.status) {
                case ActionStatus.Success: {
                    let nextState = { ...state }
                    for (let feed of Object.values(state)) {
                        if (feed.loaded) {
                            let items = action.items.filter(
                                i =>
                                    feed.sids.includes(i.source) &&
                                    FeedFilter.testItem(feed.filter, i)
                            )
                            if (items.length > 0) {
                                let oldItems = feed.iids.map(
                                    id => action.itemState[id]
                                )
                                let nextItems = mergeSortedArrays(
                                    oldItems,
                                    items,
                                    (a, b) =>
                                        b.date.getTime() - a.date.getTime()
                                )
                                nextState[feed._id] = {
                                    ...feed,
                                    iids: nextItems.map(i => i._id),
                                }
                            }
                        }
                    }
                    return nextState
                }
                default:
                    return state
            }
        case DISMISS_ITEMS:
            let nextState = { ...state }
            let feed = state[action.fid]
            nextState[action.fid] = {
                ...feed,
                iids: feed.iids.filter(iid => !action.iids.has(iid)),
            }
            return nextState
        case INIT_FEED:
            switch (action.status) {
                case ActionStatus.Success: {
                    const iids = appendUniqueIds([], action.items)
                    return {
                        ...state,
                        [action.feed._id]: {
                            ...action.feed,
                            loaded: true,
                            allLoaded: isFeedExhausted(
                                action.next,
                                action.carry,
                                action.items
                            ),
                            iids,
                            next: action.next ?? null,
                            carry: (action.carry ?? []).map(i => i._id),
                            readAtCursor: action.readAtCursor ?? 0,
                        },
                    }
                }
                default:
                    return state
            }
        case LOAD_MORE:
            switch (action.status) {
                case ActionStatus.Request:
                    return {
                        ...state,
                        [action.feed._id]: {
                            ...action.feed,
                            loading: true,
                        },
                    }
                case ActionStatus.Success: {
                    // Never append an id the feed already lists: a repeated row
                    // would make indexOf-based navigation cycle between copies.
                    const iids = appendUniqueIds(action.feed.iids, action.items)
                    return {
                        ...state,
                        [action.feed._id]: {
                            ...action.feed,
                            loading: false,
                            allLoaded: isFeedExhausted(
                                action.next,
                                action.carry,
                                action.items
                            ),
                            iids,
                            next: action.next ?? null,
                            carry: (action.carry ?? []).map(i => i._id),
                            readAtCursor: action.readAtCursor ?? 0,
                        },
                    }
                }
                case ActionStatus.Failure:
                    return {
                        ...state,
                        [action.feed._id]: {
                            ...action.feed,
                            loading: false,
                        },
                    }
                default:
                    return state
            }
        case TOGGLE_HIDDEN: {
            let nextItem = applyItemReduction(action.item, action.type)
            let filteredFeeds = Object.values(state).filter(
                feed =>
                    feed.loaded && !FeedFilter.testItem(feed.filter, nextItem)
            )
            if (filteredFeeds.length > 0) {
                let nextState = { ...state }
                for (let feed of filteredFeeds) {
                    nextState[feed._id] = {
                        ...feed,
                        iids: feed.iids.filter(id => id != nextItem._id),
                    }
                }
                return nextState
            } else {
                return state
            }
        }
        case SELECT_PAGE:
            switch (action.pageType) {
                case PageType.Sources:
                    return {
                        ...state,
                        [SOURCE]: new RSSFeed(
                            SOURCE,
                            action.sids,
                            action.filter
                        ),
                    }
                case PageType.AllArticles:
                    return action.init
                        ? {
                              ...state,
                              [ALL]: {
                                  ...state[ALL],
                                  loaded: false,
                                  filter: action.filter,
                              },
                          }
                        : state
                default:
                    return state
            }
        default:
            return state
    }
}
