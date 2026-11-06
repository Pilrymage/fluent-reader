import * as React from "react"
import intl from "react-intl-universal"
import {
    Stack,
    Label,
    Dropdown,
    IDropdownOption,
    Toggle,
    DefaultButton,
    MessageBar,
    MessageBarType,
} from "@fluentui/react"
import { ProxyMode } from "../../schema-types"

type NetworkTabState = {
    mode: ProxyMode
    routes: { default: string; sandbox: string }
    verbose: boolean
    busy: boolean
    message: string
    error: boolean
}

class NetworkTab extends React.Component<{}, NetworkTabState> {
    constructor(props) {
        super(props)
        this.state = {
            mode: "system",
            routes: { default: "", sandbox: "" },
            verbose: false,
            busy: false,
            message: "",
            error: false,
        }
    }

    componentDidMount() {
        this.refresh()
    }

    refresh = async () => {
        const bridge = window.network
        if (!bridge) return
        try {
            const state = await bridge.getState()
            const verbose = await bridge.getVerbose()
            this.setState({
                mode: state.mode,
                routes: state.routes,
                verbose,
            })
        } catch {
            this.setState({
                message: intl.get("network.unavailable"),
                error: true,
            })
        }
    }

    modeOptions = (): IDropdownOption[] => [
        { key: "system", text: intl.get("network.modeSystem") },
        { key: "direct", text: intl.get("network.modeDirect") },
        { key: "pac", text: intl.get("network.modePac") },
    ]

    onModeChange = async (_, option: IDropdownOption) => {
        const bridge = window.network
        if (!bridge) return
        this.setState({ busy: true, message: "", error: false })
        try {
            await bridge.setMode(option.key as ProxyMode)
            const state = await bridge.getState()
            this.setState({
                mode: state.mode,
                routes: state.routes,
                busy: false,
            })
        } catch {
            this.setState({
                busy: false,
                message: intl.get("network.unavailable"),
                error: true,
            })
        }
    }

    onVerboseChange = async (_, checked: boolean) => {
        const bridge = window.network
        if (!bridge) return
        await bridge.setVerbose(checked)
        this.setState({ verbose: checked })
    }

    exportLog = async () => {
        const bridge = window.network
        if (!bridge) return
        this.setState({ busy: true, message: "", error: false })
        try {
            const result = await bridge.exportLog()
            this.setState({
                busy: false,
                message: result.error
                    ? result.error
                    : result.canceled
                    ? intl.get("network.exportCanceled")
                    : intl.get("network.exported"),
                error: Boolean(result.error),
            })
        } catch {
            this.setState({
                busy: false,
                message: intl.get("network.unavailable"),
                error: true,
            })
        }
    }

    clearLog = async () => {
        const bridge = window.network
        if (!bridge) return
        try {
            await bridge.clearLog()
            this.setState({
                message: intl.get("network.cleared"),
                error: false,
            })
        } catch {
            this.setState({
                message: intl.get("network.unavailable"),
                error: true,
            })
        }
    }

    render = () => (
        <div className="tab-body">
            <Label>{intl.get("network.mode")}</Label>
            <Stack horizontal>
                <Stack.Item>
                    <Dropdown
                        selectedKey={this.state.mode}
                        options={this.modeOptions()}
                        onChange={this.onModeChange}
                        disabled={this.state.busy}
                        style={{ width: 200 }}
                    />
                </Stack.Item>
            </Stack>
            <span className="settings-hint up">
                {intl.get("network.defaultRoute")}:{" "}
                {this.state.routes.default || "-"}
            </span>
            <span className="settings-hint up">
                {intl.get("network.sandboxRoute")}:{" "}
                {this.state.routes.sandbox || "-"}
            </span>

            <Stack horizontal verticalAlign="baseline">
                <Stack.Item grow>
                    <Label>{intl.get("network.verbose")}</Label>
                </Stack.Item>
                <Stack.Item>
                    <Toggle
                        checked={this.state.verbose}
                        onChange={this.onVerboseChange}
                    />
                </Stack.Item>
            </Stack>

            <Label>{intl.get("network.diagnostics")}</Label>
            <Stack horizontal tokens={{ childrenGap: 8 }}>
                <Stack.Item>
                    <DefaultButton
                        text={intl.get("network.export")}
                        onClick={this.exportLog}
                        disabled={this.state.busy}
                    />
                </Stack.Item>
                <Stack.Item>
                    <DefaultButton
                        text={intl.get("network.clear")}
                        onClick={this.clearLog}
                    />
                </Stack.Item>
            </Stack>
            {this.state.message && (
                <MessageBar
                    messageBarType={
                        this.state.error
                            ? MessageBarType.error
                            : MessageBarType.success
                    }>
                    {this.state.message}
                </MessageBar>
            )}
        </div>
    )
}

export default NetworkTab
