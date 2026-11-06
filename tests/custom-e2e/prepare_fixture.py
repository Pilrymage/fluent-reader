from pathlib import Path
import json, sqlite3, time, hashlib
ROOT=Path(__file__).parent
REPO=Path(__file__).resolve().parents[2]
profile=ROOT/'profile'
profile.mkdir(exist_ok=True)
config={'useNeDB':False,'version':'1.3.1-custom.1','dbVersion':'sqlite','serviceConfigs':{'type':0},'sourceGroups':[{'gid':0,'isMultiple':True,'sids':[101,102],'name':'PATCH TEST GROUP','expanded':True},{'gid':1,'isMultiple':False,'sids':[103]}],'menuOn':True,'view':3,'theme':'light','filterType':19,'fetchInterval':0,'pacOn':False,'nextGroupId':2,'sourceRules':{},'locale':'en-US'}
(profile/'config.json').write_text(json.dumps(config),encoding='utf-8')
db=profile/'fluent-reader.db'
for ext in ['', '-wal', '-shm']:
 p=Path(str(db)+ext)
 if p.exists(): p.unlink()
c=sqlite3.connect(db)
journal=json.loads((REPO/'dist/drizzle/meta/_journal.json').read_text())
c.execute('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)')
for e in journal['entries']:
 raw=(REPO/f"dist/drizzle/{e['tag']}.sql").read_bytes()
 c.executescript(raw.decode())
 c.execute('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)',(hashlib.sha256(raw).hexdigest(),e['when']))
now=int(time.time()*1000)
for sid in [101,102,103]:
 c.execute('INSERT INTO sources(sid,url,name,lastFetched) VALUES(?,?,?,?)',(sid,'http://127.0.0.1:9/fixture-'+str(sid),'Fixture Feed '+str(sid),now))
for i in range(1,71):
 sid=101 if i<=60 else 102 if i<=65 else 103
 c.execute('INSERT INTO items(_id,source,guid,title,link,date,fetchedDate,content,snippet,hasRead) VALUES(?,?,?,?,?,?,?,?,?,?)',(i,sid,'fixture-'+str(i),'Fixture Article '+str(i),'https://example.invalid/'+str(i),now-i*1000,now,'<p>Isolated test content.</p>','Fixture snippet '+str(i),int(i==3)))
c.commit(); c.close()
print('Created isolated 70-article fixture; no live data accessed')
