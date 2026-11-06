import * as React from "react"
import { useState, useEffect, useCallback, useRef } from "react"
import intl from "react-intl-universal"
import { useSelector, useDispatch } from "react-redux"
import { Icon } from "@fluentui/react/lib/Icon"
import { IObjectWithKey } from "@fluentui/react"
import { RootState } from "../scripts/reducer"
import {
    fetchItems,
    markAllRead,
    cancelPendingMarkRead,
    noteCardFocus,
    resetItemShortcutState,
} from "../scripts/models/item"
import {
    makeStyles,
    mergeClasses,
    ProgressBar,
} from "@fluentui/react-components"
import {
    toggleMenu,
    toggleLogMenu,
    toggleSettings,
    openViewMenu,
    openMarkAllMenu,
} from "../scripts/models/app"
import { toggleSearch } from "../scripts/models/page"
import { ViewType, WindowStateListenerType } from "../schema-types"
import {
    getGlobalShortcutAction,
    HeldKeyTracker,
    resetPositionCycle,
} from "../scripts/keyboard"
import { FlatButton } from "./utils/FlatButton"
import { FlatButtonGroup } from "./utils/FlatButtonGroup"
import { FlatButtonSeparator } from "./utils/FlatButtonSeparator"
import { useIsWideScreen } from "./utils/hooks/useIsWideScreen"
import {
    AppWindowFocusChangeEvent,
    useIsBlurred,
} from "./utils/hooks/useIsBlurred"

const useClasses = makeStyles({
    progress: {
        position: "fixed",
        top: 0,
        left: 0,
        zIndex: 10,
        width: "100%",
        overflow: "hidden",
        background: "none",
    },
    navBlurred: {
        "--black": "var(--neutralSecondaryAlt)",
    },
    navBtn: {
        height: "var(--navHeight)",
        lineHeight: "var(--navHeight)",
        zIndex: 1,
        position: "relative",
    },
    navBtnSystem: {
        position: "relative",
        zIndex: 10,
    },
    navBtnSystemItemOn: {
        color: "var(--whiteConstant)",
    },
    navBtnMinimize: {
        fontSize: "12px",
    },
    navGroupFirst: {
        marginLeft: "72px",
    },
    navGroupRight: {
        float: "right",
    },
})

const Nav: React.FC = () => {
    const classes = useClasses()
    const dispatch = useDispatch()
    const state = useSelector((state: RootState) => state.app)
    const itemShown = useSelector(
        (state: RootState) =>
            state.page.itemId && state.page.viewType !== ViewType.List
    )
    const [maximized, setMaximized] = useState(globalThis.utils.isMaximized())
    const isWideScreen = useIsWideScreen()
    const isBlurred = useIsBlurred()
    const [isFullscreen, setIsFullscreen] = useState(() =>
        globalThis.utils.isFullscreen()
    )
    const isDarwin = globalThis.utils.platform === "darwin"

    const setBodyFullscreenState = useCallback((fullscreen: boolean) => {
        if (fullscreen) document.body.classList.remove("not-fullscreen")
        else document.body.classList.add("not-fullscreen")
    }, [])

    const windowStateListener = useCallback(
        (type: WindowStateListenerType, windowState: boolean) => {
            switch (type) {
                case WindowStateListenerType.Maximized:
                    setMaximized(windowState)
                    break
                case WindowStateListenerType.Fullscreen:
                    setIsFullscreen(windowState)
                    setBodyFullscreenState(windowState)
                    break
                case WindowStateListenerType.Focused:
                    globalThis.dispatchEvent(
                        new CustomEvent<AppWindowFocusChangeEvent["detail"]>(
                            "app-window-focus-change",
                            { detail: { focused: windowState } }
                        )
                    )
                    break
            }
        },
        [setBodyFullscreenState]
    )

    const canFetch = useCallback(
        () =>
            state.sourceInit &&
            state.feedInit &&
            !state.syncing &&
            !state.fetchingItems,
        [state.sourceInit, state.feedInit, state.syncing, state.fetchingItems]
    )

    const fetch = useCallback(() => {
        if (canFetch()) dispatch(fetchItems())
    }, [canFetch, dispatch])

    const menu = useCallback(() => dispatch(toggleMenu()), [dispatch])
    const logs = useCallback(() => dispatch(toggleLogMenu()), [dispatch])
    const search = useCallback(() => dispatch(toggleSearch()), [dispatch])
    const settings = useCallback(() => dispatch(toggleSettings()), [dispatch])
    const markAll = useCallback(() => dispatch(openMarkAllMenu()), [dispatch])
    const feedSids = useSelector(
        (state: RootState) => state.feeds[state.page.feedId]?.sids
    )
    const feedId = useSelector((state: RootState) => state.page.feedId)
    // Capture the category's sources when the key fires so a late completion
    // can never mark a different category the user switched to.
    const markAllDirect = useCallback(
        () => dispatch(markAllRead(feedSids ? [...feedSids] : null)),
        [dispatch, feedSids]
    )
    const heldMarkAll = useRef(new HeldKeyTracker())
    const views = useCallback(() => {
        if (state.contextMenu.event !== "#view-toggle") {
            dispatch(openViewMenu())
        }
    }, [state.contextMenu.event, dispatch])

    const navShortcutsHandler = useCallback(
        (e: KeyboardEvent | IObjectWithKey) => {
            if (!state.settings.display) {
                switch (e.key) {
                    case "F1":
                        menu()
                        break
                    case "F2":
                        search()
                        break
                    case "F5":
                        fetch()
                        break
                    case "F6":
                        markAllDirect()
                        break
                    case "F7":
                        if (!itemShown) logs()
                        break
                    case "F8":
                        if (!itemShown) views()
                        break
                    case "F9":
                        if (!itemShown) settings()
                        break
                }
                if (
                    getGlobalShortcutAction(
                        e as KeyboardEvent,
                        state,
                        document.activeElement
                    ) === "markAllRead"
                ) {
                    if (!heldMarkAll.current.has(e)) {
                        heldMarkAll.current.add(e)
                        markAllDirect()
                    }
                }
            }
        },
        [
            state.settings.display,
            state.contextMenu.type,
            itemShown,
            menu,
            search,
            fetch,
            markAllDirect,
            logs,
            views,
            settings,
        ]
    )

    useEffect(() => {
        setBodyFullscreenState(globalThis.utils.isFullscreen())
        globalThis.utils.addWindowStateListener(windowStateListener)

        return () => {
            // Cleanup will be handled by the event listener removal effect
        }
    }, [setBodyFullscreenState, windowStateListener])

    useEffect(() => {
        const releaseHeldKey = (e: KeyboardEvent) => {
            heldMarkAll.current.delete(e)
            // Releasing r stops a backlog of queued mark-read steps.
            if (e && (e.key === "r" || e.key === "R" || e.code === "KeyR")) {
                cancelPendingMarkRead()
            }
        }
        const clearHeldKeys = () => {
            heldMarkAll.current.clear()
            cancelPendingMarkRead()
        }
        document.addEventListener("keyup", releaseHeldKey)
        window.addEventListener("blur", clearHeldKeys)
        return () => {
            document.removeEventListener("keyup", releaseHeldKey)
            window.removeEventListener("blur", clearHeldKeys)
        }
    }, [])

    useEffect(() => {
        const resetCycle = () => resetPositionCycle()
        document.addEventListener("mousedown", resetCycle)
        return () => {
            document.removeEventListener("mousedown", resetCycle)
        }
    }, [])

    useEffect(() => {
        // Moving focus to a different row (mouse, Tab, programmatic) restarts
        // the Ctrl+L position cycle for that row.
        const onFocusIn = (e: FocusEvent) => {
            const target = e.target as HTMLElement
            if (!target || typeof target.closest !== "function") return
            const card = target.closest(
                ".list-card, .compact-card, .magazine-card, .default-card"
            )
            if (!card || typeof (card as HTMLElement).getAttribute !== "function")
                return
            const raw = (card as HTMLElement).getAttribute("data-iid")
            if (!raw) return
            noteCardFocus(Number(raw))
        }
        document.addEventListener("focusin", onFocusIn)
        return () => {
            document.removeEventListener("focusin", onFocusIn)
        }
    }, [])

    useEffect(() => {
        // A category switch must not carry focus, cycle position or backlog.
        resetItemShortcutState()
    }, [feedId])

    useEffect(() => {
        document.addEventListener("keydown", navShortcutsHandler)
        if (globalThis.utils.platform === "darwin")
            globalThis.utils.addTouchBarEventsListener(navShortcutsHandler)

        return () => {
            document.removeEventListener("keydown", navShortcutsHandler)
        }
    }, [navShortcutsHandler])

    const minimize = () => {
        globalThis.utils.minimizeWindow()
    }

    const maximize = () => {
        globalThis.utils.maximizeWindow()
        setMaximized(!maximized)
    }

    const close = () => {
        globalThis.utils.closeWindow()
    }

    const isFetching = !canFetch()

    const getClassNames = () => {
        const classNames = new Array<string>()
        if (state.settings.display) classNames.push("hide-btns")
        if (state.menu) classNames.push("menu-on")
        if (itemShown) classNames.push("item-on")
        if (isBlurred) classNames.push(classes.navBlurred)
        return classNames.join(" ")
    }

    const getProgress = () => {
        return state.fetchingTotal > 0
            ? state.fetchingProgress / state.fetchingTotal
            : undefined
    }

    const isNonNavButtonShown = !state.settings.display
    const menuOn = state.menu
    const systemItemOnClass = itemShown ? classes.navBtnSystemItemOn : undefined
    const firstGroupClass = mergeClasses(
        isDarwin && !isFullscreen ? classes.navGroupFirst : undefined
    )

    return (
        <nav className={getClassNames()}>
            {(!isWideScreen || !menuOn) && isNonNavButtonShown && (
                <FlatButtonGroup styleClass={firstGroupClass}>
                    <FlatButton
                        styleClass={classes.navBtn}
                        title={intl.get("nav.menu")}
                        onClick={menu}>
                        <Icon
                            iconName={
                                isDarwin ? "SidePanel" : "GlobalNavButton"
                            }
                        />
                    </FlatButton>
                </FlatButtonGroup>
            )}
            <span className="title">{state.title}</span>
            <FlatButtonGroup styleClass={classes.navGroupRight}>
                {isNonNavButtonShown && (
                    <>
                        <FlatButton
                            styleClass={classes.navBtn}
                            fetching={isFetching}
                            disabled={isFetching}
                            onClick={fetch}
                            title={intl.get("nav.refresh")}>
                            <Icon iconName="Refresh" />
                        </FlatButton>
                        <FlatButton
                            styleClass={classes.navBtn}
                            id="mark-all-toggle"
                            onClick={markAll}
                            title={intl.get("nav.markAllRead")}
                            onMouseDown={e => {
                                if (
                                    state.contextMenu.event ===
                                    "#mark-all-toggle"
                                )
                                    e.stopPropagation()
                            }}>
                            <Icon iconName="InboxCheck" />
                        </FlatButton>
                        <FlatButton
                            styleClass={classes.navBtn}
                            id="log-toggle"
                            title={intl.get("nav.notifications")}
                            onClick={logs}>
                            {state.logMenu.notify ? (
                                <Icon iconName="RingerSolid" />
                            ) : (
                                <Icon iconName="Ringer" />
                            )}
                        </FlatButton>
                        <FlatButton
                            styleClass={classes.navBtn}
                            id="view-toggle"
                            title={intl.get("nav.view")}
                            onClick={views}
                            onMouseDown={e => {
                                if (state.contextMenu.event === "#view-toggle")
                                    e.stopPropagation()
                            }}>
                            <Icon iconName="View" />
                        </FlatButton>
                        <FlatButton
                            styleClass={classes.navBtn}
                            title={intl.get("nav.settings")}
                            onClick={settings}>
                            <Icon iconName="Settings" />
                        </FlatButton>
                    </>
                )}
                {!isDarwin && (
                    <>
                        {!isDarwin && <FlatButtonSeparator />}
                        <FlatButton
                            variant="system"
                            styleClass={mergeClasses(
                                classes.navBtn,
                                classes.navBtnSystem,
                                classes.navBtnMinimize,
                                systemItemOnClass
                            )}
                            title={intl.get("nav.minimize")}
                            onClick={minimize}>
                            <Icon iconName="Remove" />
                        </FlatButton>
                        <FlatButton
                            variant="system"
                            styleClass={mergeClasses(
                                classes.navBtn,
                                classes.navBtnSystem,
                                systemItemOnClass
                            )}
                            title={intl.get("nav.maximize")}
                            onClick={maximize}>
                            {maximized ? (
                                <Icon
                                    iconName="ChromeRestore"
                                    style={{ fontSize: 11 }}
                                />
                            ) : (
                                <Icon
                                    iconName="Checkbox"
                                    style={{ fontSize: 10 }}
                                />
                            )}
                        </FlatButton>
                        <FlatButton
                            variant="close"
                            styleClass={mergeClasses(
                                classes.navBtn,
                                classes.navBtnSystem,
                                systemItemOnClass
                            )}
                            title={intl.get("close")}
                            onClick={close}>
                            <Icon iconName="Cancel" />
                        </FlatButton>
                    </>
                )}
            </FlatButtonGroup>
            {isFetching && (
                <ProgressBar
                    className={classes.progress}
                    shape="square"
                    value={getProgress()}
                />
            )}
        </nav>
    )
}

export default Nav
