import * as React from "react"
import intl from "react-intl-universal"
import { renderToString } from "react-dom/server"
import { useCallback, useEffect, useLayoutEffect, useState } from "react"
import {
    markRead,
    markUnread,
    toggleStarred,
    toggleHidden,
    itemShortcuts,
} from "../scripts/models/item"
import {
    Stack,
    CommandBarButton,
    IContextualMenuProps,
    FocusZone,
    ContextualMenuItemType,
    Icon,
    Link,
} from "@fluentui/react"
import {
    RSSSource,
    updateSource,
    SourceTextDirection,
} from "../scripts/models/source"
import { shareSubmenu } from "./context-menu"
import { platformCtrl } from "../scripts/utils"
import { Spinner } from "@fluentui/react-components"
import { useAppDispatch, useAppSelector } from "../scripts/reducer"
import { dismissItem, showOffsetItem } from "../scripts/models/page"
import {
    openTextMenu,
    openImageMenu,
    closeContextMenu,
} from "../scripts/models/app"
import { useArticleView } from "./utils/hooks/useArticleView"
import { isArticleOpenExternalKey } from "../scripts/keyboard"

const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 17, 18, 19, 20]

type ArticleProps = Readonly<{
    itemId: number
}>

function Article({ itemId }: ArticleProps) {
    const dispatch = useAppDispatch()
    const item = useAppSelector(state => state.items[itemId])
    const source = useAppSelector(state => state.sources[item.source])
    const locale = useAppSelector(state => state.app.locale)
    const [fontFamily, setFontFamily] = useState(() =>
        window.settings.getFont()
    )
    const [fontSize, setFontSize] = useState(() =>
        window.settings.getFontSize()
    )
    const {
        webview,
        webviewKey,
        showWebview,
        loadWebpage,
        loadFull,
        fullContent,
        detailContent,
        loaded,
        error,
        isWebApp,
        onFrameLoad,
        toggleWebpage,
        toggleFull,
        reload,
    } = useArticleView(item, source.openTarget)

    // There is no Electron webview to host a remote page in the browser build,
    // and most sites refuse to be framed, so open it in a tab instead.
    const onToggleWebpage = useCallback(() => {
        if (isWebApp) window.utils.openExternal(item.link)
        else toggleWebpage()
    }, [isWebApp, item.link, toggleWebpage])

    const onToggleFull = useCallback(() => {
        if (!isWebApp) toggleFull()
    }, [isWebApp, toggleFull])

    const dismiss = () => dispatch(dismissItem())
    const handleToggleHidden = useCallback(() => {
        if (!item.hidden) dispatch(dismissItem())
        if (!item.hasRead && !item.hidden) dispatch(markRead(item))
        dispatch(toggleHidden(item))
    }, [dispatch, item])

    useEffect(() => {
        return window.utils.addWebviewContextListener((pos, text, url) => {
            if (!pos) dispatch(closeContextMenu())
            else if (text || url) dispatch(openTextMenu(pos, text, url))
            else dispatch(openImageMenu(pos))
        })
    }, [dispatch])

    // A key arriving immediately after navigation must use the committed item.
    const handleArticleInput = useCallback(
        (input: any) => {
            if (input.type !== "keyDown") return
            switch (input.key) {
                case "Escape":
                    dispatch(dismissItem())
                    break
                case "ArrowLeft":
                case "ArrowRight":
                    dispatch(showOffsetItem(input.key === "ArrowLeft" ? -1 : 1))
                    break
                case "l":
                case "L":
                    onToggleWebpage()
                    break
                case "w":
                case "W":
                    onToggleFull()
                    break
                case "h":
                case "H":
                    if (!input.meta) handleToggleHidden()
                    break
                default: {
                    const event = new KeyboardEvent("keydown", {
                        code: input.code,
                        key: input.key,
                        shiftKey: input.shift,
                        altKey: input.alt,
                        ctrlKey: input.control,
                        metaKey: input.meta,
                        repeat: input.isAutoRepeat,
                        bubbles: true,
                    })
                    dispatch(itemShortcuts(item, event, "article"))
                    document.dispatchEvent(event)
                    break
                }
            }
        },
        [dispatch, item, onToggleWebpage, onToggleFull, handleToggleHidden]
    )

    useLayoutEffect(() => {
        if (isWebApp) {
            // An iframe swallows its own keydowns; article.js relays them here.
            const onMessage = (event: MessageEvent) => {
                if (event.origin !== location.origin) return
                if (event.data?.type !== "fr-keydown") return
                handleArticleInput(event.data.input)
            }
            window.addEventListener("message", onMessage)
            return () => window.removeEventListener("message", onMessage)
        }
        return window.utils.addWebviewKeydownListener(handleArticleInput)
    }, [handleArticleInput, isWebApp])

    // `b` also works while focus is on the article's toolbar. Menus opened
    // from it render in portals, so only keys from inside the article count.
    const handleArticleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.target as Node)) return
            if (!isArticleOpenExternalKey(e.nativeEvent)) return
            dispatch(itemShortcuts(item, e.nativeEvent, "article"))
        },
        [dispatch, item]
    )

    const updateFontSize = (size: number) => {
        window.settings.setFontSize(size)
        setFontSize(size)
    }
    const updateFont = (font: string) => {
        window.settings.setFont(font)
        setFontFamily(font)
    }

    const fontSizeMenuProps = (): IContextualMenuProps => ({
        items: FONT_SIZE_OPTIONS.map(size => ({
            key: String(size),
            text: String(size),
            canCheck: true,
            checked: size === fontSize,
            onClick: () => updateFontSize(size),
        })),
    })

    const fontFamilyMenuProps = (): IContextualMenuProps => ({
        items: window.fontList.map((font, idx) => ({
            key: String(idx),
            text: font === "" ? intl.get("default") : font,
            canCheck: true,
            checked: fontFamily === font,
            onClick: () => updateFont(font),
        })),
    })

    const updateTextDirection = (direction: SourceTextDirection) => {
        dispatch(updateSource({ ...source, textDir: direction } as RSSSource))
    }

    const directionMenuProps = (): IContextualMenuProps => ({
        items: [
            {
                key: "LTR",
                text: intl.get("article.LTR"),
                iconProps: { iconName: "Forward" },
                canCheck: true,
                checked: source.textDir === SourceTextDirection.LTR,
                onClick: () => updateTextDirection(SourceTextDirection.LTR),
            },
            {
                key: "RTL",
                text: intl.get("article.RTL"),
                iconProps: { iconName: "Back" },
                canCheck: true,
                checked: source.textDir === SourceTextDirection.RTL,
                onClick: () => updateTextDirection(SourceTextDirection.RTL),
            },
            {
                key: "Vertical",
                text: intl.get("article.Vertical"),
                iconProps: { iconName: "Down" },
                canCheck: true,
                checked: source.textDir === SourceTextDirection.Vertical,
                onClick: () =>
                    updateTextDirection(SourceTextDirection.Vertical),
            },
        ],
    })

    const moreMenuProps = (): IContextualMenuProps => ({
        items: [
            {
                key: "openInBrowser",
                text: intl.get("openExternal"),
                iconProps: { iconName: "NavigateExternalInline" },
                onClick: e => {
                    window.utils.openExternal(item.link, platformCtrl(e))
                },
            },
            {
                key: "copyURL",
                text: intl.get("context.copyURL"),
                iconProps: { iconName: "Link" },
                onClick: () => {
                    window.utils.writeClipboard(item.link)
                },
            },
            {
                key: "toggleHidden",
                text: item.hidden
                    ? intl.get("article.unhide")
                    : intl.get("article.hide"),
                iconProps: {
                    iconName: item.hidden ? "View" : "Hide3",
                },
                onClick: () => {
                    handleToggleHidden()
                },
            },
            {
                key: "fontMenu",
                text: intl.get("article.font"),
                iconProps: { iconName: "Font" },
                disabled: loadWebpage,
                subMenuProps: fontFamilyMenuProps(),
            },
            {
                key: "fontSizeMenu",
                text: intl.get("article.fontSize"),
                iconProps: { iconName: "FontSize" },
                disabled: loadWebpage,
                subMenuProps: fontSizeMenuProps(),
            },
            {
                key: "directionMenu",
                text: intl.get("article.textDir"),
                iconProps: { iconName: "ChangeEntitlements" },
                disabled: loadWebpage,
                subMenuProps: directionMenuProps(),
            },
            {
                key: "divider_1",
                itemType: ContextualMenuItemType.Divider,
            },
            ...shareSubmenu(item),
        ],
    })

    const articleView = () => {
        const h = encodeURIComponent(
            renderToString(
                <>
                    <p className="title">{item.title}</p>
                    <p className="date">
                        {item.date.toLocaleString(locale, {
                            hour12: !locale.startsWith("zh"),
                        })}
                    </p>
                    <article></article>
                </>
            )
        )
        const common = `h=${h}&f=${encodeURIComponent(
            fontFamily
        )}&s=${fontSize}&d=${source.textDir}&u=${item.link}`
        if (isWebApp) {
            // Bodies average 2.8 KB and reach 144 KB, past the server's request
            // header limit, so the frame pulls it by id via postMessage instead.
            return `article/article.html?id=${item._id}&${common}`
        }
        const a = encodeURIComponent(loadFull ? fullContent : item.content)
        return `article/article.html?a=${a}&${common}&m=${loadFull ? 1 : 0}`
    }

    const handleFrameLoad = useCallback(() => {
        const frame = webview.current as HTMLIFrameElement | null
        frame?.contentWindow?.postMessage(
            { type: "fr-article", id: item._id, article: detailContent },
            location.origin
        )
        onFrameLoad()
    }, [detailContent, item._id, onFrameLoad])

    return (
        <FocusZone className="article" onKeyDown={handleArticleKeyDown}>
            <Stack horizontal style={{ height: 36 }}>
                <span style={{ width: 96 }}></span>
                <Stack
                    className="actions"
                    grow
                    horizontal
                    tokens={{ childrenGap: 12 }}>
                    <Stack.Item grow>
                        <span className="source-name">
                            {loaded ? (
                                source.iconurl && (
                                    <img
                                        className="favicon"
                                        src={source.iconurl}
                                    />
                                )
                            ) : (
                                <Spinner size="extra-tiny" />
                            )}
                            {source.name}
                            {item.creator && (
                                <span className="creator">{item.creator}</span>
                            )}
                        </span>
                    </Stack.Item>
                    <CommandBarButton
                        title={
                            item.hasRead
                                ? intl.get("article.markUnread")
                                : intl.get("article.markRead")
                        }
                        iconProps={
                            item.hasRead
                                ? { iconName: "StatusCircleRing" }
                                : {
                                      iconName: "RadioBtnOn",
                                      style: {
                                          fontSize: 14,
                                          textAlign: "center",
                                      },
                                  }
                        }
                        onClick={() =>
                            dispatch(
                                item.hasRead ? markUnread(item) : markRead(item)
                            )
                        }
                    />
                    <CommandBarButton
                        title={
                            item.starred
                                ? intl.get("article.unstar")
                                : intl.get("article.star")
                        }
                        iconProps={{
                            iconName: item.starred
                                ? "FavoriteStarFill"
                                : "FavoriteStar",
                        }}
                        onClick={() => dispatch(toggleStarred(item))}
                    />
                    {!isWebApp && (
                        <CommandBarButton
                            title={intl.get("article.loadFull")}
                            className={loadFull ? "active" : ""}
                            iconProps={{ iconName: "RawSource" }}
                            onClick={onToggleFull}
                        />
                    )}
                    <CommandBarButton
                        title={intl.get("article.loadWebpage")}
                        className={loadWebpage ? "active" : ""}
                        iconProps={{ iconName: "Globe" }}
                        onClick={onToggleWebpage}
                    />
                    <CommandBarButton
                        title={intl.get("more")}
                        iconProps={{ iconName: "More" }}
                        menuIconProps={{ style: { display: "none" } }}
                        menuProps={moreMenuProps()}
                    />
                </Stack>
                <Stack horizontal horizontalAlign="end" style={{ width: 112 }}>
                    <CommandBarButton
                        title={intl.get("close")}
                        iconProps={{ iconName: "BackToWindow" }}
                        onClick={dismiss}
                    />
                </Stack>
            </Stack>
            {showWebview &&
                (!isWebApp || !!detailContent) &&
                (isWebApp ? (
                    <iframe
                        id="article"
                        className={error ? "error" : ""}
                        ref={webview}
                        key={webviewKey}
                        src={articleView()}
                        onLoad={handleFrameLoad}
                        sandbox="allow-scripts allow-same-origin allow-popups"
                        title={item.title}
                    />
                ) : (
                    <webview
                        id="article"
                        className={error ? "error" : ""}
                        ref={webview}
                        key={webviewKey}
                        src={loadWebpage ? item.link : articleView()}
                        allowpopups={"true" as unknown as boolean}
                        webpreferences="contextIsolation,disableDialogs,autoplayPolicy=document-user-activation-required"
                        partition={loadWebpage ? "sandbox" : undefined}
                    />
                ))}
            {error && (
                <Stack
                    className="error-prompt"
                    verticalAlign="center"
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}>
                    <Icon iconName="HeartBroken" style={{ fontSize: 32 }} />
                    <Stack
                        horizontal
                        horizontalAlign="center"
                        tokens={{ childrenGap: 7 }}>
                        <small>{intl.get("article.error")}</small>
                        <small>
                            <Link onClick={reload}>
                                {intl.get("article.reload")}
                            </Link>
                        </small>
                    </Stack>
                    <span style={{ fontSize: 11 }}>{error}</span>
                </Stack>
            )}
        </FocusZone>
    )
}

export default Article
