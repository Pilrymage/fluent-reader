// Browser entry point. The only difference from index.tsx is the runtime that
// installs window.settings/utils/db/network before any app module runs.
import "./web-runtime"
import * as React from "react"
import * as ReactDOM from "react-dom"
import { Provider } from "react-redux"
import { initializeIcons } from "@fluentui/react/lib/Icons"
import Root from "./components/root"
import { initApp } from "./scripts/models/app"
import { rootStore } from "./scripts/reducer"

initializeIcons("icons/")

// No login gate here: Authelia guards the whole site, and Caddy refuses to
// proxy a request that did not pass forward_auth. A browser loading this file
// is therefore already authenticated.
rootStore.dispatch(initApp())
window.fontList = [""]
ReactDOM.render(
    <Provider store={rootStore}>
        <Root />
    </Provider>,
    document.getElementById("app")
)
