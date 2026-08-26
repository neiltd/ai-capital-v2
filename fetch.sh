#!/bin/bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
for T in CBG MINT BH BDMS HMPRO COM7 CENTEL KCE HANA SAPPE OSP CRC CPALL SCC; do
  echo "===== $T.BK ====="
  curl -s -A "$UA" "https://query1.finance.yahoo.com/v8/finance/chart/${T}.BK?range=3mo&interval=1d" \
    -o "chart_${T}.json"
  # print meta price
  python3 - "$T" <<'PY'
import json,sys
t=sys.argv[1]
d=json.load(open(f"chart_{t}.json"))
try:
    m=d["chart"]["result"][0]["meta"]
    print("price=",m.get("regularMarketPrice"),"prevClose=",m.get("chartPreviousClose") or m.get("previousClose"),"currency=",m.get("currency"))
except Exception as e:
    print("META ERR",e, str(d)[:200])
PY
done
