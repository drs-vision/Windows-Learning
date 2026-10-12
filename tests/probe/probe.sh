#!/usr/bin/env bash
# Network probes run on GitHub's machines (this session can't reach these hosts). Output goes to annotations.
set +e
note() { while IFS= read -r l; do echo "::notice title=probe::$l"; done; }
curl -sS -m 30 "https://db-api.unstable.life/search?smartSearch=Fancy%20Pants%20Adventures&filter=true&limit=3" | head -c 3000 | note
echo "---- get" | note
curl -sS -m 30 "https://db-api.unstable.life/get?id=1df51450-0aad-4e8a-8f33-0c1f4415b6ed" | head -c 3000 | note
echo "---- search fields=gameData" | note
curl -sS -m 30 "https://db-api.unstable.life/search?id=1df51450-0aad-4e8a-8f33-0c1f4415b6ed&fields=id,title,gameData,activeDataId,dateAdded,launchCommand" | head -c 3000 | note
echo "---- youtube rss + page" | note
curl -sS -m 30 -o /dev/null -w "rss %{http_code} %{size_download}\n" "https://www.youtube.com/feeds/videos.xml?channel_id=UCY1kMZp36IQSyNx_9h4mpCg" | note
curl -sS -m 30 -o /dev/null -w "page %{http_code} %{size_download}\n" -A "Mozilla/5.0" "https://www.youtube.com/channel/UCY1kMZp36IQSyNx_9h4mpCg/videos" | note
