import { app } from "electron"
import * as path from "path"

// Must execute before settings/database modules access userData.
// Never share databases or service credentials with the upstream installation.
app.setName("Fluent Reader Custom")
if (!app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath("userData", path.join(app.getPath("appData"), "fluent-reader-custom"))
}
