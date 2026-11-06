const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/components/cards/card.tsx'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(id => {
    if (id.endsWith('/source')) return { SourceOpenTarget: { External: 2 } }
    if (id.endsWith('/utils')) return { platformCtrl: () => false }
    return require(id)
}, mod, mod.exports)
for (const handled of [true, false]) {
    const nativeEvent = { defaultPrevented: false }
    const calls = { prevent: 0, stop: 0 }
    const event = { nativeEvent, preventDefault: () => calls.prevent++, stopPropagation: () => calls.stop++ }
    const item = { _id: 1 }
    const props = { item, shortcuts: (actual, e) => {
        assert.equal(actual, item)
        assert.equal(e, nativeEvent)
        e.defaultPrevented = handled
    } }
    mod.exports.Card.bindEventsToProps(props).onKeyDown(event)
    assert.equal(calls.prevent, handled ? 1 : 0, 'handled native shortcut must prevent React FocusZone default handling')
    assert.equal(calls.stop, handled ? 1 : 0, 'handled native shortcut must stop synthetic bubbling')
}
console.log('PASS native shortcut cancellation reaches React FocusZone; unhandled keys retain fallback')
