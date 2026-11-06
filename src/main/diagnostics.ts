import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import { ipcMain, app } from "electron"
import {
    DiagEvent,
    formatSummaryLine,
    redactText,
    sanitizeEvent,
} from "../scripts/models/net/diagnostics"

export const ROTATE_BYTES = 256 * 1024
export const DIAG_LOG_NAME = "network-diagnostics.log"
const EXPORT_DETAIL_LIMIT = 4000

export interface DiagnosticsDeps {
    fs?: typeof nodeFs
    path?: typeof nodePath
    logPath?: string
    userData?: string | (() => string)
    getVerbose?: () => boolean
    dialog?: {
        showSaveDialog(options?: unknown): Promise<{
            canceled: boolean
            filePath?: string
        }>
    }
    now?: () => number
}

export interface DiagnosticsIpcDeps extends DiagnosticsDeps {
    getStore(): {
        get(key: string, defaultValue?: unknown): unknown
        set(key: string, value: unknown): void
    }
}

export interface ExportResult {
    canceled: boolean
    filePath?: string
    error?: string
}

function fallbackUserData(): string {
    try {
        return app.getPath("userData")
    } catch {
        return ""
    }
}

function resolveLogPath(deps: DiagnosticsDeps): string {
    if (deps.logPath) return deps.logPath
    const pathModule = deps.path || nodePath
    const userData =
        typeof deps.userData === "function" ? deps.userData() : deps.userData
    return pathModule.join(
        userData || fallbackUserData(),
        "logs",
        DIAG_LOG_NAME
    )
}

export function appendDiagnostic(
    event: DiagEvent,
    deps: DiagnosticsDeps = {}
): string {
    const fs = deps.fs || nodeFs
    const pathModule = deps.path || nodePath
    const logPath = resolveLogPath(deps)
    const verbose = deps.getVerbose ? Boolean(deps.getVerbose()) : false
    const sanitized = sanitizeEvent(event)
    const line =
        (verbose ? JSON.stringify(sanitized) : formatSummaryLine(sanitized)) +
        "\n"
    fs.mkdirSync(pathModule.dirname(logPath), { recursive: true })
    try {
        const stats = fs.statSync(logPath)
        if (stats.size + Buffer.byteLength(line) > ROTATE_BYTES) {
            const backup = logPath + ".1"
            try {
                fs.rmSync(backup, { force: true })
            } catch {
                // The backup may already be absent.
            }
            fs.renameSync(logPath, backup)
        }
    } catch {
        // No existing log yet.
    }
    fs.appendFileSync(logPath, line)
    return line.trim()
}

export function readDiagnosticLog(deps: DiagnosticsDeps = {}): string {
    const fs = deps.fs || nodeFs
    try {
        return fs.readFileSync(resolveLogPath(deps), "utf8")
    } catch {
        return ""
    }
}

export function clearDiagnosticLog(deps: DiagnosticsDeps = {}): void {
    const fs = deps.fs || nodeFs
    const logPath = resolveLogPath(deps)
    for (const file of [logPath, logPath + ".1"]) {
        try {
            if (typeof fs.rmSync === "function") {
                fs.rmSync(file, { force: true })
            } else if (fs.existsSync(file)) {
                fs.unlinkSync(file)
            }
        } catch {
            // Clearing diagnostics must never throw.
        }
    }
}

export async function exportDiagnosticsFile(
    deps: DiagnosticsDeps = {}
): Promise<ExportResult> {
    if (!deps.dialog || typeof deps.dialog.showSaveDialog !== "function") {
        return { canceled: true }
    }
    let result: { canceled: boolean; filePath?: string }
    try {
        result = await deps.dialog.showSaveDialog({
            defaultPath: DIAG_LOG_NAME,
            filters: [
                { name: "Network Diagnostics", extensions: ["log", "txt"] },
            ],
        })
    } catch {
        return { canceled: true }
    }
    if (!result || result.canceled || !result.filePath) {
        return { canceled: true }
    }
    const fs = deps.fs || nodeFs
    let content = ""
    try {
        content = fs.readFileSync(resolveLogPath(deps), "utf8")
    } catch {
        content = ""
    }
    // Re-redact every line so an older log can never leak a raw exception.
    const redacted = content
        .split(/\r?\n/)
        .map(line => redactText(line, EXPORT_DETAIL_LIMIT))
        .join("\n")
    try {
        fs.writeFileSync(result.filePath, redacted)
    } catch (err) {
        return {
            canceled: false,
            filePath: result.filePath,
            error: redactText(String(err), 200),
        }
    }
    return { canceled: false, filePath: result.filePath }
}

export function registerDiagnosticsIpc(deps: DiagnosticsIpcDeps): void {
    const resolve = (): DiagnosticsDeps => ({
        fs: deps.fs,
        path: deps.path,
        logPath: deps.logPath,
        userData:
            typeof deps.userData === "function"
                ? deps.userData()
                : deps.userData,
        dialog: deps.dialog,
        getVerbose: () =>
            Boolean(deps.getStore().get("networkDiagVerbose", false)),
    })
    ipcMain.handle("network:diag-append", (_, event: DiagEvent) =>
        appendDiagnostic(event, resolve())
    )
    ipcMain.handle("network:diag-read", () => readDiagnosticLog(resolve()))
    ipcMain.handle("network:diag-export", () =>
        exportDiagnosticsFile(resolve())
    )
    ipcMain.handle("network:diag-clear", () => clearDiagnosticLog(resolve()))
    ipcMain.handle("network:diag-get-verbose", () =>
        Boolean(deps.getStore().get("networkDiagVerbose", false))
    )
    ipcMain.handle("network:diag-set-verbose", (_, verbose: boolean) => {
        deps.getStore().set("networkDiagVerbose", Boolean(verbose))
    })
}
