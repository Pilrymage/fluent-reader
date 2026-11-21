from pathlib import Path
import json, subprocess, sys, time, sqlite3, psutil, base64, socket
from cdp_probe import CDP, MainCDP
ROOT=Path(__file__).parent
PROFILE=ROOT/'profile'
EXE=Path(__file__).resolve().parents[2]/'bin/win32/x64/win-unpacked/Fluent Reader Custom.exe'
results=[]

def port_free(port):
    try:
        socket.create_connection(('127.0.0.1',port),timeout=.3).close()
        return False
    except OSError:
        return True

def pid_on_port(port):
    # A terminated instance can leave a zombie holding the debugging port; the
    # next launch then silently loses its DevTools server and every CDP call
    # fails. Find the actual owner instead of assuming psutil saw everything.
    try:
        out=subprocess.run(['netstat','-ano','-p','TCP'],capture_output=True,text=True).stdout
    except OSError:
        return set()
    pids=set()
    for line in out.splitlines():
        parts=line.split()
        if len(parts)>=5 and parts[1].endswith(':'+str(port)):
            try: pids.add(int(parts[-1]))
            except ValueError: pass
    return pids

def stop():
    for attempt in range(2):
        procs=[p for p in psutil.process_iter(['exe']) if p.info['exe'] and Path(p.info['exe'])==EXE]
        for p in procs:
            try: p.terminate()
            except (psutil.NoSuchProcess,psutil.AccessDenied): pass
        _,alive=psutil.wait_procs(procs,timeout=8)
        for p in alive:
            try: p.kill()
            except (psutil.NoSuchProcess,psutil.AccessDenied): pass
        psutil.wait_procs(alive,timeout=5)
        for pid in pid_on_port(19224):
            try: psutil.Process(pid).kill()
            except (psutil.NoSuchProcess,psutil.AccessDenied): pass
        end=time.monotonic()+15
        while time.monotonic()<end:
            if port_free(19224): return
            time.sleep(.2)
    raise AssertionError('debugging port 19224 is still in use')

def start(view=3,filter_type=19,theme='light',inspect_main=False):
    stop()
    fixture=subprocess.run([sys.executable,str(ROOT/'prepare_fixture.py')],capture_output=True,text=True)
    if fixture.returncode!=0:
        raise AssertionError('fixture rebuild failed: '+(fixture.stderr or fixture.stdout)[-500:])
    d=json.loads((PROFILE/'config.json').read_text()); d.update(view=view,filterType=filter_type,theme=theme)
    (PROFILE/'config.json').write_text(json.dumps(d),encoding='utf-8')
    log=(ROOT/'e2e-electron.log').open('a')
    args=[str(EXE),'--user-data-dir='+str(PROFILE),'--remote-debugging-port=19224','--remote-debugging-address=127.0.0.1']
    if inspect_main: args.append('--inspect=127.0.0.1:19225')
    subprocess.Popen(args,stdout=log,stderr=log)
    end=time.monotonic()+40
    while time.monotonic()<end:
        try:
            c=CDP()
            if c.js("document.querySelectorAll('[data-iid]').length")>0:return c
        except Exception:pass
        time.sleep(.25)
    raise AssertionError('isolated Electron failed to load fixture')

def read(i):
    # The context manager only commits; it never closes. A leaked handle here
    # keeps the fixture database locked and the next rebuild fails.
    db=sqlite3.connect(PROFILE/'fluent-reader.db')
    try:
        return db.execute('SELECT hasRead FROM items WHERE _id=?',(i,)).fetchone()[0]
    finally:
        db.close()

def key(c,key,mod=0):
    if len(key)==1:
        code='Key'+key.upper(); vk=ord(key.upper())
    else:
        code=key; vk={'ArrowDown':40,'ArrowUp':38}.get(key,0)
    c.call('Input.dispatchKeyEvent',{'type':'keyDown','key':key,'code':code,'modifiers':mod,'text':key if len(key)==1 else '', 'windowsVirtualKeyCode':vk})
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

def jump_to_list():
    # a moves focus to the article list without pressing Tab.
    c=start(view=3)
    wait=lambda cond:any(cond() or time.sleep(.2) for _ in range(50))
    # Fresh app, no cursor and no open article: the first row wins.
    assert not c.js("document.activeElement.closest('[data-iid]')"),'startup must not focus a row'
    key(c,'a')
    assert c.js("document.activeElement.dataset.iid")=='1','a falls back to the first row'
    # From a focused row it keeps that row instead of jumping to the first one.
    focus(c,7)
    key(c,'a')
    assert c.js("document.activeElement.dataset.iid")=='7','a must keep the focused row'
    # A blurred row is still the walk cursor: a returns to it, not to the top.
    c.js("document.activeElement.blur()")
    key(c,'a')
    assert c.js("document.activeElement.dataset.iid")=='7','a must return to the cursor row'
    assert not c.js("document.body.classList.contains('item-on')")
    # The card view's open article is a focus trap over the list; a must close it
    # and land on the row it was showing.
    focus(c,12)
    c.js("document.querySelector('[data-iid=\"12\"]').click()")
    assert wait(lambda:c.js("!!document.querySelector('.article-container')")),'article overlay must open'
    assert wait(lambda:c.js("document.activeElement.tagName")=='WEBVIEW'),'article takes focus'
    key(c,'a')
    assert wait(lambda:not c.js("!!document.querySelector('.article-container')")),'a must close the overlay'
    assert c.js("document.activeElement.dataset.iid")=='12','a must land on the opened article row'
    assert not c.js("document.body.classList.contains('item-on')")
    # The cursor row is off screen at the very bottom; a must scroll it back in.
    focus(c,2)
    c.js("(()=>{const s=document.getElementById('refocus');s.scrollTop=s.scrollHeight})()")
    time.sleep(.5)
    offscreen=c.js("(()=>{const e=document.querySelector('[data-iid=\"2\"]');if(!e)return true;const r=e.getBoundingClientRect(),v=document.getElementById('refocus').getBoundingClientRect();return r.bottom<=v.top||r.top>=v.bottom})()")
    assert offscreen,'row 2 must start off screen'
    key(c,'a')
    assert wait(lambda:c.js("document.activeElement.dataset.iid")=='2'),'a must bring the cursor row back into view'
    assert wait(lambda:c.js("(()=>{const e=document.querySelector('[data-iid=\"2\"]');const r=e.getBoundingClientRect(),v=document.getElementById('refocus').getBoundingClientRect();return r.top>=v.top-1&&r.bottom<=v.bottom+1})()")),'a must only scroll the row into view'
    c.ws.close()

def article_a_key():
    # a typed inside the article webview must jump to the list, unlike r/n.
    c=start(inspect_main=True)
    main=MainCDP()
    wait=lambda cond:any(cond() or time.sleep(.2) for _ in range(50))
    focus(c,1)
    c.js("document.querySelector('[data-iid=\"1\"]').click()")
    assert wait(lambda:c.js("document.activeElement.tagName")=='WEBVIEW'),'article webview takes focus'
    guest_key(main,'a')
    assert wait(lambda:not c.js("!!document.querySelector('.article-container')")),'a in the webview must close the article'
    assert wait(lambda:c.js("document.activeElement.dataset.iid")=='1'),'a in the webview must focus the list row'
    main.ws.close(); c.ws.close()

def a_key_guards():
    c=start()
    wait=lambda cond:any(cond() or time.sleep(.2) for _ in range(50))
    # An input keeps the letter.
    c.js("(()=>{const e=document.createElement('input');e.id='a-guard';document.body.append(e);e.focus()})()")
    key(c,'a')
    assert c.js("document.activeElement.id")=='a-guard','a must stay inert in an input'
    c.js("document.getElementById('a-guard').remove()")
    # The sources tree keeps its type-ahead for subscription names.
    c.js("document.querySelector('[aria-label=\"Menu\"]').click()")
    time.sleep(.4)
    assert c.js("(()=>{const e=document.querySelector('[role=treeitem]');e.focus();return document.activeElement===e})()")
    key(c,'a')
    assert c.js("document.activeElement.getAttribute('role')")=='treeitem','a must not leave the sources tree'
    c.js("document.body.click()")
    time.sleep(.4)
    c.ws.close()

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
        check('a jumps to the list row, closes the card overlay, keeps inert in inputs/tree',jump_to_list)
        check('a stays inert in inputs and the sources tree type-ahead',a_key_guards)
        check('a from inside the article webview returns to the opened row',article_a_key)
        (ROOT/'e2e-results.json').write_text(json.dumps({'status':'passed','results':results},ensure_ascii=False,indent=2),encoding='utf-8')
    finally:
        stop()
