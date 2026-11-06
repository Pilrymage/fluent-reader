const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/custom-runtime.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
for (const explicit of [false, true]) {
    const calls = []
    const app = {
        setName: n => calls.push(['name', n]),
        getPath: k => { assert.equal(k, 'appData'); return 'C:/fixture/AppData/Roaming' },
        setPath: (k, v) => calls.push(['path', k, v]),
        commandLine: { hasSwitch: k => { assert.equal(k, 'user-data-dir'); return explicit } },
    }
    vm.runInNewContext(code, { exports: {}, require: id => id === 'electron' ? { app } : require(id) })
    assert.deepEqual(calls[0], ['name', 'Fluent Reader Custom'])
    if (explicit) assert.equal(calls.length, 1)
    else assert.deepEqual(calls[1], ['path', 'userData', path.join('C:/fixture/AppData/Roaming', 'fluent-reader-custom')])
}
const pkg = require('../package.json')
assert(pkg.sideEffects.includes('./src/custom-runtime.ts'), 'webpack must retain the bootstrap')
assert(fs.readFileSync(path.join(__dirname, '../src/electron.ts'), 'utf8').startsWith('import "./custom-runtime"'), 'bootstrap must precede settings imports')
const bundle = path.join(__dirname, '../dist/electron.js')
if (fs.existsSync(bundle)) assert(fs.readFileSync(bundle, 'utf8').includes('Fluent Reader Custom'), 'production main bundle dropped the bootstrap')
console.log('PASS custom runtime: isolated default, explicit profile override, retained production bootstrap')
