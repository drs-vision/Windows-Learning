#!/usr/bin/env bash
# Network probes run on GitHub's machines (this session can't reach these hosts). Output goes to annotations.
set +e
note() { while IFS= read -r l; do echo "::notice title=probe::$l"; done; }
body='{"context":{"client":{"clientName":"WEB","clientVersion":"2.20250312.04.00","hl":"en","gl":"US"}},"browseId":"UCY1kMZp36IQSyNx_9h4mpCg","params":"EgZ2aWRlb3PyBgQKAjoA"}'
curl -sS -m 30 -A "Mozilla/5.0" -H 'Content-Type: application/json' -d "$body" "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false" -o /tmp/b.json
python3 - <<'PY' | note
import json
d=json.load(open('/tmp/b.json'))
def walk(x,path):
    if isinstance(x,dict):
        for k,v in x.items():
            if k=='continuationItemRenderer': print(path+'/'+k, json.dumps(v)[:700])
            walk(v,path+'/'+k)
    elif isinstance(x,list):
        for i,v in enumerate(x): walk(v,path+'[%d]'%i)
walk(d,'')
s=json.dumps(d); i=s.find('"lockupViewModel"'); print(s[i:i+600])
PY
