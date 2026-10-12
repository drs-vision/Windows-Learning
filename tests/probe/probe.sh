#!/usr/bin/env bash
# Network probes run on GitHub's machines (this session can't reach these hosts). Output goes to annotations.
set +e
note() { while IFS= read -r l; do echo "::notice title=probe::$l"; done; }
echo "---- duolingo public profile" | note
curl -sS -m 30 -A "Mozilla/5.0" "https://www.duolingo.com/2017-06-30/users?username=luis&fields=id,username,totalXp,streak" | head -c 600 | note
echo "---- innertube browse videos tab (Mark Rober)" | note
body='{"context":{"client":{"clientName":"WEB","clientVersion":"2.20250101.00.00","hl":"en","gl":"US"}},"browseId":"UCY1kMZp36IQSyNx_9h4mpCg","params":"EgZ2aWRlb3PyBgQKAjoA"}'
curl -sS -m 30 -A "Mozilla/5.0" -H 'Content-Type: application/json' -d "$body" "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false" -o /tmp/b.json -w "browse %{http_code} %{size_download}\n" | note
grep -o '"videoId":"[^"]*"' /tmp/b.json | sort -u | wc -l | sed 's/^/distinct videoIds: /' | note
grep -o '"token":"[^"]*"' /tmp/b.json | head -2 | cut -c1-120 | note
python3 - <<'PY' | note
import json
d=json.load(open('/tmp/b.json'))
def walk(x,path=''):
    if isinstance(x,dict):
        for k,v in x.items():
            if k in('richItemRenderer','continuationItemRenderer','lockupViewModel','videoRenderer'): print('key',k)
            walk(v)
    elif isinstance(x,list):
        for v in x: walk(v)
import collections
keys=collections.Counter()
def w2(x):
    if isinstance(x,dict):
        for k,v in x.items(): keys[k]+=1; w2(v)
    elif isinstance(x,list):
        for v in x: w2(v)
w2(d)
for k in ['richItemRenderer','videoRenderer','lockupViewModel','continuationItemRenderer','continuationCommand','gridVideoRenderer','reelItemRenderer']: print(k,keys[k])
s=json.dumps(d)
i=s.find('"videoRenderer"'); print(s[i:i+900])
PY
echo "---- flashpoint Bloxorz" | note
curl -sS -m 30 "https://db-api.unstable.life/search?smartSearch=Bloxorz&filter=true&limit=5&fields=id,title,platform,launchCommand,library" | head -c 1500 | note
