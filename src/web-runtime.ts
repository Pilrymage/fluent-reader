import {
    SearchEngines,
    SourceGroup,
    SyncService,
    ThemeSettings,
    ViewType,
} from "./schema-types"
import type { RuleTarget, StoredRule } from "./schema-types"

type SettingsBridge = typeof import("./bridges/settings")["default"]
type UtilsBridge = typeof import("./bridges/utils")["default"]
type DbBridge = typeof import("./bridges/db")["default"]
type NetworkBridge = typeof import("./bridges/network")["default"]

// Browser replacement for preload.ts. Same surface, backed by localStorage and
// the BFF instead of electron-store and IPC. The app code is unchanged: it only
// ever talks to these four globals.
const PREFIX = "fr-web:"

function read<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(PREFIX + key)
        return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
        return fallback
    }
}

function write(key: string, value: unknown) {
    try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
        // A full quota must not take the UI down.
    }
}

const darkQuery =
    typeof matchMedia === "function"
        ? matchMedia("(prefers-color-scheme: dark)")
        : null

const settings: SettingsBridge = {
    allocateGroupId: () => {
        const next = read("nextGroupId", 0)
        write("nextGroupId", next + 1)
        return next
    },
    saveGroups: async (groups: SourceGroup[]) => write("sourceGroups", groups),
    loadGroups: () => read<SourceGroup[]>("sourceGroups", []),

    getDefaultMenu: () => read("menuOn", false),
    setDefaultMenu: state => write("menuOn", state),

    // There is no per-session proxy to toggle in a browser: routing belongs to
    // the OS/browser, and the server side never changes per client.
    getProxyStatus: () => false,
    toggleProxyStatus: () => {},
    getProxy: () => read("pac", ""),
    setProxy: (address: string = null) => {
        if (address !== null) write("pac", address)
    },

    getDefaultView: () => read("view", ViewType.Cards),
    setDefaultView: view => write("view", view),

    getThemeSettings: () => read<ThemeSettings>("theme", ThemeSettings.Default),
    setThemeSettings: theme => write("theme", theme),
    shouldUseDarkColors: () => {
        const theme = read<ThemeSettings>("theme", ThemeSettings.Default)
        if (theme === ThemeSettings.Dark) return true
        if (theme === ThemeSettings.Light) return false
        return Boolean(darkQuery?.matches)
    },
    addThemeUpdateListener: callback => {
        darkQuery?.addEventListener?.("change", event =>
            callback(event.matches)
        )
    },

    setLocaleSettings: locale => {
        write("locale", locale)
        location.reload()
    },
    getLocaleSettings: () => read("locale", null),
    getCurrentLocale: () =>
        read<string>("locale", navigator.language || "en-US"),

    getFontSize: () => read("fontSize", 16),
    setFontSize: size => write("fontSize", size),

    getFont: () => read("fontFamily", ""),
    setFont: font => write("fontFamily", font),

    // The server fetches on its own schedule; the client never polls.
    getFetchInterval: () => 0,
    setFetchInterval: () => {},

    getSearchEngine: () => read("searchEngine", SearchEngines.Google),
    setSearchEngine: engine => write("searchEngine", engine),

    // No service hooks: the BFF is the data source now, so read/star and
    // syncing must not fan out to Fever/Inoreader etc. from the browser.
    getServiceConfigs: () => ({ type: SyncService.None }),
    setServiceConfigs: () => {},

    getFilterType: () => read("filterType", null),
    setFilterType: filterType => write("filterType", filterType),

    getViewConfigs: view =>
        read(
            `viewConfigs:${view}`,
            // Show cover + snippet, do not fade read articles.
            1 | 2
        ),
    setViewConfigs: (view, configs) => write(`viewConfigs:${view}`, configs),

    getAllRules: () => read("sourceRules", {}),
    setRulesForTarget: async (target: RuleTarget, rules: StoredRule[]) => {
        const all = read<Record<string, StoredRule[]>>("sourceRules", {})
        const key =
            target.type === "all"
                ? "all"
                : target.type === "source"
                ? `source:${target.sid}`
                : `group:${target.gid}`
        if (rules.length === 0) delete all[key]
        else all[key] = rules
        write("sourceRules", all)
    },
    migrateLovefieldRules: async () => {},

    // The local mirror is gone, so the legacy migration is always done.
    getDBVersion: () => "sqlite",
    setDBVersion: async () => {},

    getUnreadSourcesOnly: () => read("menuUnreadSourcesOnly", false),
    setUnreadSourcesOnly: flag => write("menuUnreadSourcesOnly", flag),
}

function openExternal(url: string) {
    if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener")
}

const utils: UtilsBridge = {
    // There is no Node platform here. Every caller only tests for "darwin", so
    // a non-darwin value keeps the control-key branches correct.
    platform: "web" as unknown as NodeJS.Platform,
    getVersion: () => "web",
    openExternal: (url: string) => openExternal(url),

    showErrorBox: async (title: string, content: string) => {
        // alert() blocks the event loop and freezes the page in automated and
        // headless contexts. A non-blocking banner is strictly better here.
        console.error(`[${title}] ${content}`)
        const banner = document.createElement("div")
        banner.setAttribute("role", "alert")
        banner.style.cssText = [
            "position:fixed",
            "inset:auto 0 0 0",
            "z-index:2147483647",
            "padding:12px 16px",
            "background:#a4262c",
            "color:#fff",
            "font:13px/1.5 system-ui,sans-serif",
            "white-space:pre-wrap",
        ].join(";")
        banner.textContent = `${title}\n${content}`
        banner.onclick = () => banner.remove()
        document.body.append(banner)
        setTimeout(() => banner.remove(), 15000)
    },
    showMessageBox: async (_title, message) => window.confirm(message),

    // Saving a file becomes a download; picking one becomes a file input.
    showSaveDialog: async () => (result: string, errmsg: string) => {
        if (errmsg) {
            console.error(errmsg)
            return
        }
        const blob = new Blob([result], { type: "application/json" })
        const anchor = document.createElement("a")
        anchor.href = URL.createObjectURL(blob)
        anchor.download = "Fluent_Reader_Backup.frdata"
        anchor.click()
        URL.revokeObjectURL(anchor.href)
    },
    showOpenDialog: () =>
        new Promise<string>(resolve => {
            const input = document.createElement("input")
            input.type = "file"
            input.accept = ".frdata,.json,.opml,.xml"
            input.onchange = async () => {
                const file = input.files?.[0]
                resolve(file ? await file.text() : null)
            }
            input.click()
        }),

    getCacheSize: async () => 0,
    clearCache: async () => {
        // Cache API is unused today; clear it if a later version starts using it.
        if (typeof caches !== "undefined") {
            for (const key of await caches.keys()) await caches.delete(key)
        }
    },

    addMainContextListener: () => {},
    addWebviewContextListener: () => () => {},
    imageCallback: () => {},
    addWebviewKeydownListener: () => () => {},
    addWebviewErrorListener: () => () => {},

    writeClipboard: (text: string) => {
        void navigator.clipboard?.writeText(text)
    },

    // Window chrome is the browser's job.
    // Closing a browser tab is only allowed for script-opened windows, and a
    // failed close leaves the user staring at a dead page; do nothing instead.
    closeWindow: () => {},
    minimizeWindow: () => {},
    maximizeWindow: () => {},
    isMaximized: () => false,
    isFullscreen: () => Boolean(document.fullscreenElement),
    isFocused: () => document.hasFocus(),
    focus: () => window.focus(),
    addWindowStateListener: () => {},
    addTouchBarEventsListener: () => {},
    initTouchBar: () => {},
    destroyTouchBar: () => {},
    initFontList: async () => [],
}

// Data access now goes through the BFF; window.db must never be used.
const db: DbBridge = {
    execute: () =>
        Promise.reject(
            new Error("window.db is not available in the browser build")
        ),
    exportAll: async () => {},
    importAll: async () => false,
}

const network: NetworkBridge = {
    getState: async () => ({
        mode: "system",
        routes: { default: "", sandbox: "" },
    }),
    setMode: async mode => ({ mode, routes: { default: "", sandbox: "" } }),
    ensureRoute: async () => ({
        mode: "system",
        routes: { default: "", sandbox: "" },
    }),
    diagnoseEndpoint: async () => ({
        ok: false,
        durationMs: 0,
        endpoint: "",
        proxyRoute: "",
        errorKind: "unknown",
        cause: "Diagnostics run on the client in Electron only",
    }),
    appendLog: async () => "",
    readLog: async () => "",
    exportLog: async () => ({ canceled: true }),
    clearLog: async () => {},
    getVerbose: async () => false,
    setVerbose: async () => {},
}

Object.assign(window, { settings, utils, db, network })
window.__FR_WEB__ = true
