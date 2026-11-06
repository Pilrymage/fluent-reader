import json,time
import e2e as h
R=[]
def selected(c):return c.js("document.activeElement.closest('[data-iid]')?.dataset.iid")
def send(c,key,repeat=False,mod=0,up=True):
 code='Key'+key.upper() if len(key)==1 else key
 c.call('Input.dispatchKeyEvent',{'type':'keyDown','key':key,'code':code,'modifiers':mod,'autoRepeat':repeat,'windowsVirtualKeyCode':ord(key.upper()) if len(key)==1 else {'ArrowDown':40,'ArrowUp':38}.get(key,0)})
 if up:c.call('Input.dispatchKeyEvent',{'type':'keyUp','key':key,'code':code,'modifiers':mod})
 time.sleep(.15)
def snapshot(c):return c.js("(()=>{const e=document.activeElement.closest('[data-iid]'),s=document.getElementById('refocus');const r=e?.getBoundingClientRect(),v=s.getBoundingClientRect(),nav=document.querySelector('nav')?.getBoundingClientRect();return {id:e?.dataset.iid,top:r?.top,bottom:r?.bottom,height:r?.height,scroll:s.scrollTop,viewTop:Math.max(v.top,nav?.bottom||0),viewBottom:v.bottom}})()")
def record(name,data=None):R.append({'name':name,'data':data}); print('PASS',name,flush=True)
def navigation(view=3):
 c=h.start(view=view);h.focus(c,5)
 send(c,'n');assert selected(c)=='6',selected(c)
 send(c,'p');assert selected(c)=='5'
 send(c,'ArrowDown');assert selected(c)=='6'
 send(c,'ArrowUp');assert selected(c)=='5'
 for _ in range(5):send(c,'n',True)
 assert selected(c)=='10',selected(c)
 assert not h.read(5) and not h.read(10)
 assert not c.js("document.body.classList.contains('item-on')")
 record('p/n/arrows and autorepeat move without reading/opening')
 # Recenter away from either end, where all three alignments are possible.
 for _ in range(15):send(c,'n')
 states=[]
 for _ in range(3):send(c,'l',mod=2);states.append(snapshot(c))
 center,top,bottom=states
 assert abs((center['top']+center['bottom'])/2-(center['viewTop']+center['viewBottom'])/2)<8,states
 assert abs(top['top']-top['viewTop'])<8,states
 assert abs(bottom['bottom']-bottom['viewBottom'])<8,states
 record('Ctrl+l center/top/bottom geometry',states)
 send(c,'n');send(c,'l',mod=2);d=snapshot(c)
 assert abs((d['top']+d['bottom'])/2-(d['viewTop']+d['viewBottom'])/2)<8,d
 record('movement resets Ctrl+l cycle',d)
 # Put focused row at bottom then next crosses boundary and aligns at top.
 send(c,'l',mod=2);send(c,'l',mod=2);before=snapshot(c)
 send(c,'n');after=snapshot(c)
 assert int(after['id'])==int(before['id'])+1
 assert abs(after['top']-after['viewTop'])<8,(before,after)
 assert after['scroll']-before['scroll']>(before['viewBottom']-before['viewTop'])*.7,(before,after)
 record('forward boundary flips a screen, next row at top',[before,after])
 send(c,'p');up=snapshot(c)
 assert int(up['id'])==int(after['id'])-1
 assert abs(up['bottom']-up['viewBottom'])<8,up
 record('backward boundary previous row at bottom',up)
 send(c,'r');readpage=snapshot(c)
 assert int(readpage['id'])==int(up['id'])+1
 assert h.read(int(up['id']))==1 and h.read(int(readpage['id']))==0
 assert abs(readpage['top']-readpage['viewTop'])<8,readpage
 record('r explicitly reads and flips the next row to top',readpage)
 h.focus(c,30);send(c,'l',mod=2);clicked=snapshot(c)
 assert clicked['id']=='30',clicked
 assert abs((clicked['top']+clicked['bottom'])/2-(clicked['viewTop']+clicked['viewBottom'])/2)<8,clicked
 record('Ctrl+l follows newly focused row and resets cycle',clicked)
 c.ws.close()
def repeat_read(unread=False):
 c=h.start(filter_type=18 if unread else 19);h.focus(c,1)
 send(c,'r',up=False)
 for _ in range(6):send(c,'r',repeat=True,up=False)
 c.call('Input.dispatchKeyEvent',{'type':'keyUp','key':'r','code':'KeyR'})
 time.sleep(1)
 iid=int(selected(c));marked=[i for i in range(1,12) if h.read(i)]
 assert iid>=6,(iid,marked)
 assert all(h.read(i) for i in range(1,iid)),(iid,marked)
 assert h.read(iid)==0,(iid,marked)
 record('held r serializes and advances'+(' (unread-only)' if unread else ''),{'next':iid,'marked':marked})
 # Releasing stops consumption of a potentially queued repeat backlog.
 time.sleep(1);assert selected(c)==str(iid)
 c.ws.close()
def unread_lazy_boundary():
 c=h.start(filter_type=18)
 c.js("document.getElementById('refocus').scrollTop=document.getElementById('refocus').scrollHeight")
 time.sleep(.4);h.focus(c,51);send(c,'r');time.sleep(1)
 assert h.read(51)==1 and h.read(52)==0
 assert selected(c)=='52',{'selected':selected(c)}
 record('unread-only r crosses lazy-load boundary without losing next row')
 c.ws.close()
def input_and_ime_guards():
 c=h.start();h.focus(c,1)
 c.js("(()=>{let e=document.createElement('input');e.id='navigation-guard';document.body.append(e);e.focus()})()")
 for key,mod in [('n',0),('p',0),('r',0),('l',2)]:send(c,key,mod=mod)
 assert c.js("document.activeElement.id")=='navigation-guard'
 assert h.read(1)==0 and h.read(2)==0
 h.focus(c,1)
 for key,ctrl in [('n',False),('p',False),('r',False),('l',True)]:
  c.js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',"+json.dumps({'key':key,'ctrlKey':ctrl,'isComposing':True,'bubbles':True})+"))")
 time.sleep(.2)
 assert selected(c)=='1' and h.read(1)==0
 record('r/p/n/Ctrl+l inert in editable and IME contexts')
 c.ws.close()
try:
 navigation(3);navigation(1);repeat_read();repeat_read(True);unread_lazy_boundary();input_and_ime_guards()
 h.ROOT.joinpath('navigation-e2e-results.json').write_text(json.dumps({'status':'passed','results':R},indent=2))
finally:h.stop()
