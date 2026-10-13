#!/usr/bin/env bash
set +e
note() { while IFS= read -r l; do echo "::notice title=probe::$l"; done; }
python3 2>&1 <<'PY' | note
import json, urllib.request, zipfile, io, re
o=urllib.request.build_opener(); o.addheaders=[('User-Agent','CoinQuest/1.0')]; urllib.request.install_opener(o)
out=[]
for gid in ['123f54dc-6631-8caf-554f-9c3ce4915781']:
  try:
    data=urllib.request.urlopen("https://db-api.unstable.life/get?id="+gid,timeout=60).read()
    z=zipfile.ZipFile(io.BytesIO(data)); names=z.namelist()
    out.append('files %d: %s' % (len(names), ' '.join(n.replace('content/','') for n in names[:25])))
    urls=set()
    for n in names:
      if n.endswith(('.html','.htm','.js','.json')):
        t=z.read(n).decode('utf8','ignore'); urls|=set(re.findall(r'https?://[a-zA-Z0-9.-]+', t))
    out.append('hosts referenced: '+' '.join(sorted(urls))[:900])
  except Exception as e: out.append('ERR %r' % e)
r=json.load(urllib.request.urlopen("https://db-api.unstable.life/search?smartSearch=sugar%20sugar&filter=true&limit=6&fields=id,title,platform,launchCommand",timeout=30))
out.append('SUGAR '+' | '.join('%s %s %s %s' % (g['id'][:8], g['title'], g['platform'], g['launchCommand']) for g in r))
print('\n'.join(out))
PY
