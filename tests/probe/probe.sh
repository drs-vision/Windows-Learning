#!/usr/bin/env bash
# Network probes run on GitHub's machines (this session can't reach these hosts). Output goes to annotations.
set +e
note() { while IFS= read -r l; do echo "::notice title=probe::$l"; done; }
python3 - <<'PY' | note
import json, urllib.request
def post(body):
    req=urllib.request.Request("https://www.youtube.com/youtubei/v1/browse?prettyPrint=false", data=json.dumps(body).encode(), headers={'Content-Type':'application/json','User-Agent':'Mozilla/5.0','X-YouTube-Client-Name':'1','X-YouTube-Client-Version':'2.20250312.04.00','Origin':'https://www.youtube.com'})
    return json.load(urllib.request.urlopen(req, timeout=30))
ctx={"client":{"clientName":"WEB","clientVersion":"2.20250312.04.00","hl":"en","gl":"US"}}
d=post({"context":ctx,"browseId":"UCY1kMZp36IQSyNx_9h4mpCg","params":"EgZ2aWRlb3PyBgQKAjoA"})
grid=d['contents']['twoColumnBrowseResultsRenderer']['tabs'][1]['tabRenderer']['content']['richGridRenderer']['contents']
tok=grid[-1]['continuationItemRenderer']['continuationEndpoint']['continuationCommand']['token']
print('visitorData', d.get('responseContext',{}).get('visitorData','')[:40])
c=post({"context":ctx,"continuation":tok})
print('keys', list(c.keys()))
s=json.dumps(c)
print('len', len(s), 'lockups', s.count('"lockupViewModel"'), 'videoIds', s.count('"videoId"'), 'contentId', s.count('"contentId"'))
print(s[:1500])
i=s.find('"lockupViewModel"'); print('LOCKUP', s[i:i+700])
# with visitorData
ctx2={"client":dict(ctx["client"], visitorData=d.get('responseContext',{}).get('visitorData',''))}
c2=post({"context":ctx2,"continuation":tok}); s2=json.dumps(c2)
print('with visitorData: len', len(s2), 'lockups', s2.count('"lockupViewModel"'))
PY
