from pathlib import Path
import json, subprocess, sys, time, sqlite3, psutil, base64
from cdp_probe import CDP, MainCDP
ROOT=Path(__file__).parent
PROFILE=ROOT/'profile'
EXE=Path(__file__).resolve().parents[2]/'bin/win32/x64/win-unpacked/Fluent Reader Custom.exe'
results=[]

def stop():
    for p in psutil.process_iter(['exe','cmdline']):
        try:
            if p.info['exe'] and Path(p.info['exe'])==EXE:
                p.terminate()
        except (psutil.NoSuchProcess,psutil.AccessDenied): pass
    psutil.wait_procs([p for p in psutil.process_iter(['exe']) if p.info['exe'] and Path(p.info['exe'])==EXE],timeout=8)

def start(view=3,filter_type=19,theme='light',inspect_main=False):
    stop()
    subprocess.run([sys.executable,str(ROOT/'prepare_fixture.py')],check=True,capture_output=True)
    d=json.loads((PROFILE/'config.json').read_text()); d.update(view=view,filterType=filter_type,theme=theme)
    (PROFILE/'config.json').write_text(json.dumps(d),encoding='utf-8')
    log=(ROOT/'e2e-electron.log').open('a')
    args=[str(EXE),'--user-data-dir='+str(PROFILE),'--remote-debugging-port=19224','--remote-debugging-address=127.0.0.1']
    if inspect_main: args.append('--inspect=127.0.0.1:19225')
    subprocess.Popen(args,stdout=log,stderr=log)
    end=time.monotonic()+25
    while time.monotonic()<end:
        try:
            c=CDP()
            if c.js("document.querySelectorAll('[data-iid]').length")>0:return c
        except Exception:pass
        time.sleep(.25)
    raise AssertionError('isolated Electron failed to load fixture')

def read(i):
    with sqlite3.connect(PROFILE/'fluent-reader.db') as db:
        return db.execute('SELECT hasRead FROM items WHERE _id=?',(i,)).fetchone()[0]

def key(c,key,mod=0):
    code='KeyR' if key.lower()=='r' else key
    c.call('Input.dispatchKeyEvent',{'type':'keyDown','key':key,'code':code,'modifiers':mod,'text':key if len(key)==1 else '', 'windowsVirtualKeyCode':82 if key.lower()=='r' else 0})
    c.call('Input.dispatchKeyEvent',{'type':'keyUp','key':key,'code':code,'modifiers':mod})
    time.sleep(.5)

def focus(c,i):
    # Virtualized cards may not have tabindex until FocusZone visits them; make
    # the fixture target programmatically focusable, then retry across re-renders.
    for _ in range(10):
        if c.js(f"(()=>{{let e=document.querySelector('[data-iid=\"{i}\"]');if(!e)return false;if(!e.hasAttribute('tabindex'))e.setAttribute('tabindex','-1');e.focus();return document.activeElement===e}})()"):
            time.sleep(.15)
            if c.js(f"document.activeElement?.dataset?.iid==='{i}'"):
                return
        time.sleep(.2)
    raise AssertionError('fixture target not focusable')

def check(name,fn):
    fn(); results.append(name); print('PASS',name,flush=True)

def r_scenario(view,unread=False):
    c=start(view,18 if unread else 19)
    focus(c,1); key(c,'r')
    assert read(1)==1 and read(2)==0
    assert c.js("document.activeElement.dataset.iid")=='2'
    assert not c.js("document.body.classList.contains('item-on')")
    key(c,'r'); assert read(2)==1 and read(4)==0
    # Item 3 is already read; in all view it remains the next entry.
    target=4 if unread else 3
    assert c.js("document.activeElement.dataset.iid")==str(target)
    if not unread:
        key(c,'r');assert read(3)==1 and read(4)==0
        assert c.js("document.activeElement.dataset.iid")=='4'
    c.ws.close()

def styles(theme):
    c=start(theme=theme)
    d=c.js("(()=>{const card=id=>document.querySelector('[data-iid=\"'+id+'\"]');const title=id=>card(id).querySelector('.title')||card(id);return {read:getComputedStyle(title(3)).color,unread:getComputedStyle(title(2)).color,cls:card(3).className,background:getComputedStyle(document.body).backgroundColor}})()")
    assert d['read']!=d['unread'],d
    results.append({'theme':theme,**d})
    c.ws.close()

def boundaries():
    c=start()
    c.js("document.getElementById('refocus').scrollTop=document.getElementById('refocus').scrollHeight")
    time.sleep(.5)
    focus(c,50)
    key(c,'r')
    end=time.monotonic()+5
    while c.js("document.activeElement.dataset.iid")!='51' and time.monotonic()<end:
        time.sleep(.1)
    assert read(50)==1 and read(51)==0
    assert c.js("document.activeElement.dataset.iid")=='51','r must cross load-more boundary without opening'
    c.js("document.querySelector('[aria-label=\"Menu\"]').click()")
    time.sleep(.2)
    c.js("document.querySelector('[aria-label=\"Fixture Feed 103\"]').click()")
    time.sleep(.4)
    focus(c,70); key(c,'r')
    assert read(70)==1
    assert c.js("document.querySelector('nav').innerText.includes('Fixture Feed 103')")
    assert not c.js("document.body.classList.contains('item-on')")
    c.ws.close()

def bulk_and_guards():
    c=start()
    c.js("document.querySelector('[aria-label=\"Menu\"]').click()")
    time.sleep(.3)
    c.js("document.querySelector('[aria-label=\"PATCH TEST GROUP\"]').click()")
    time.sleep(.5)
    assert c.js("document.querySelector('nav').innerText.includes('PATCH TEST GROUP')")
    assert not c.js("document.querySelector('[data-iid=\"65\"]')"),'unloaded test article must be unrendered'
    # Add a real text input in fixture DOM, test keyboard guard.
    c.js("(()=>{const e=document.createElement('input');e.id='guard-probe';document.body.append(e);e.focus()})()")
    key(c,'R',8)
    assert read(1)==0 and read(65)==0 and read(66)==0
    focus(c,1)
    key(c,'F9')
    assert c.js("!!document.querySelector('.settings-container')"),'settings fixture must open'
    key(c,'R',8)
    assert read(1)==0 and read(65)==0,'R must not operate behind settings'
    key(c,'Escape')
    time.sleep(.4)
    assert not c.js("!!document.querySelector('.settings-container')")
    focus(c,1)
    c.call('Input.dispatchKeyEvent',{'type':'keyDown','key':'R','code':'KeyR','modifiers':8,'autoRepeat':True,'windowsVirtualKeyCode':82})
    c.call('Input.dispatchKeyEvent',{'type':'keyUp','key':'R','code':'KeyR','modifiers':8})
    time.sleep(.3)
    assert read(1)==0 and read(65)==0,'long-press R repeat must be ignored'
    c.js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'R',code:'KeyR',shiftKey:true,isComposing:true,bubbles:true}))")
    time.sleep(.2)
    assert read(1)==0 and read(65)==0,'IME composing R must be ignored'
    focus(c,1); key(c,'r',2) # Ctrl+r must not mark it read.
    assert read(1)==0
    focus(c,1); key(c,'R',8)
    assert all(read(i)==1 for i in range(1,66))
    assert all(read(i)==0 for i in range(66,71))
    assert not c.js("document.querySelector('[role=dialog]')"),'R must not ask confirmation'
    c.ws.close()

def menu_pn():
    # Tree order: Search, All articles, PATCH TEST GROUP, Feed 101, Feed 102, Feed 103.
    c=start()
    c.js("document.querySelector('[aria-label=\"Menu\"]').click()")
    time.sleep(.4)
    index="[...document.querySelectorAll('[role=treeitem]')].indexOf(document.activeElement)"
    assert c.js("(()=>{const e=document.querySelector('[role=treeitem]');e.focus();return document.activeElement===e})()")
    nav=c.js("document.querySelector('nav').innerText")
    # Without the fix the tree's type-ahead jumps to "PATCH TEST GROUP" on p.
    key(c,'p'); assert c.js(index)==0,'p at the first item must stay there'
    key(c,'n'); assert c.js(index)==1
    key(c,'n'); key(c,'n'); assert c.js(index)==3,'n must enter the expanded group'
    key(c,'p'); assert c.js(index)==2
    assert c.js("document.activeElement.tabIndex")==0,'roving tabindex must follow p/n'
    for _ in range(5): key(c,'n')
    assert c.js(index)==5,'n at the last item must stay there'
    assert c.js("document.querySelector('nav').innerText")==nav,'p/n must not select a source'
    assert read(1)==0 and read(2)==0
    c.ws.close()

def guest_key(main,key):
    # CDP keys sent to the guest page skip Electron's before-input-event, so
    # send them from the main process the way a physical key arrives.
    sent=main.js("(()=>{const {webContents}=process.mainModule.require('electron');"
        "const g=webContents.getAllWebContents().find(w=>w.getType()==='webview');if(!g)return false;"
        f"g.sendInputEvent({{type:'keyDown',keyCode:'{key}'}});g.sendInputEvent({{type:'keyUp',keyCode:'{key}'}});return true}})()")
    assert sent,'article webview missing'
    time.sleep(.5)

def article_keys():
    # Keys typed in the open article's webview reach the renderer through the
    # main process. m uses the same path as b without opening a browser.
    c=start(inspect_main=True)
    main=MainCDP()
    focus(c,1)
    c.js("document.querySelector('[data-iid=\"1\"]').click()")
    wait=lambda cond:any(cond() or time.sleep(.2) for _ in range(50))
    assert wait(lambda:c.js("!!document.querySelector('.article webview')")),'article must open'
    assert wait(lambda:c.js("document.activeElement.tagName")=='WEBVIEW'),'article webview takes focus'
    assert wait(lambda:read(1)==1),'opening the article marks it read'
    guest_key(main,'m'); assert wait(lambda:read(1)==0),'m in the article webview must toggle unread'
    guest_key(main,'m'); assert wait(lambda:read(1)==1),'m in the article webview must toggle read'
    # List keys stay inert inside the article.
    guest_key(main,'r'); guest_key(main,'n')
    assert read(2)==0
    assert c.js("document.activeElement.tagName")=='WEBVIEW'
    main.ws.close(); c.ws.close()

if __name__=='__main__':
    try:
        check('Compact r: explicit read, next focus, no open, idempotent already-read',lambda:r_scenario(3))
        check('List r: next focus, no open, already-read safe',lambda:r_scenario(1))
        check('Unread-only r: consecutive entries not skipped',lambda:r_scenario(3,True))
        check('Light read articles gray without FadeRead option',lambda:styles('light'))
        check('Dark read articles distinguishable without FadeRead option',lambda:styles('dark'))
        check('r load-more boundary and final article stay within source',boundaries)
        check('R category includes unloaded, excludes other source, no dialog; input/Ctrl guards',bulk_and_guards)
        check('Sources menu: p/n move like arrows, clamp at ends, no type-ahead jump',menu_pn)
        check('Open article: webview keys reach article shortcuts, list keys stay inert',article_keys)
        (ROOT/'e2e-results.json').write_text(json.dumps({'status':'passed','results':results},ensure_ascii=False,indent=2),encoding='utf-8')
    finally:
        stop()
