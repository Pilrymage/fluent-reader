import json, urllib.request, websocket, itertools
class CDP:
    def __init__(self, port=19224):
        targets=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=5))
        target=next(t for t in targets if t['type']=='page' and 'index.html' in t['url'])
        self.ws=websocket.create_connection(target['webSocketDebuggerUrl'],timeout=15,suppress_origin=True)
        self.ids=itertools.count(1)
    def call(self,method,params=None):
        n=next(self.ids)
        self.ws.send(json.dumps({'id':n,'method':method,'params':params or {}}))
        while True:
            d=json.loads(self.ws.recv())
            if d.get('id')==n:
                if 'error' in d: raise RuntimeError(d['error'])
                return d.get('result',{})
    def js(self,expr):
        r=self.call('Runtime.evaluate',{'expression':expr,'returnByValue':True,'awaitPromise':True})
        if r.get('exceptionDetails'): raise RuntimeError(r['exceptionDetails'])
        return r['result'].get('value')
class MainCDP(CDP):
    def __init__(self, port=19225):
        target=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=5))[0]
        self.ws=websocket.create_connection(target['webSocketDebuggerUrl'],timeout=15,suppress_origin=True)
        self.ids=itertools.count(1)
if __name__=='__main__':
    c=CDP()
    print(json.dumps(c.js("({title:document.title,text:document.body.innerText.slice(0,1600),cards:[...document.querySelectorAll('[data-iid]')].slice(0,5).map(e=>({id:e.dataset.iid,cls:e.className}))})"),ensure_ascii=False))
