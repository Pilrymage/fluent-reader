import { ipcRenderer } from "electron"
import { ProxyMode } from "../schema-types"
import { DiagEvent } from "../scripts/models/net/diagnostics"

export interface NetworkRouteState {
    mode: ProxyMode
    routes: { default: string; sandbox: string }
}

export interface DiagnoseEndpointPayload {
    endpoint: string
    apiKey?: string
    username?: string
}

export interface EndpointDiagnosis {
    ok: boolean
    status?: number
    auth?: number
    errorKind?: string
    cause?: string
    durationMs: number
    endpoint: string
    proxyRoute: string
}

export interface DiagnosticsExportResult {
    canceled: boolean
    filePath?: string
    error?: string
}

const networkBridge = {
    getState: (): Promise<NetworkRouteState> =>
        ipcRenderer.invoke("network:get-state"),
    setMode: (mode: ProxyMode): Promise<NetworkRouteState> =>
        ipcRenderer.invoke("network:set-mode", mode),
    ensureRoute: (targetUrl?: string): Promise<NetworkRouteState> =>
        ipcRenderer.invoke("network:ensure-route", targetUrl),
    diagnoseEndpoint: (
        payload?: DiagnoseEndpointPayload
    ): Promise<EndpointDiagnosis> =>
        ipcRenderer.invoke("network:diagnose-endpoint", payload),
    appendLog: (event: DiagEvent): Promise<string> =>
        ipcRenderer.invoke("network:diag-append", event),
    readLog: (): Promise<string> => ipcRenderer.invoke("network:diag-read"),
    exportLog: (): Promise<DiagnosticsExportResult> =>
        ipcRenderer.invoke("network:diag-export"),
    clearLog: (): Promise<void> => ipcRenderer.invoke("network:diag-clear"),
    getVerbose: (): Promise<boolean> =>
        ipcRenderer.invoke("network:diag-get-verbose"),
    setVerbose: (verbose: boolean): Promise<void> =>
        ipcRenderer.invoke("network:diag-set-verbose", verbose),
}

declare global {
    interface Window {
        network: typeof networkBridge
    }
    var network: typeof networkBridge
}

export default networkBridge
