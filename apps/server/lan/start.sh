#!/bin/sh
# 升级·找朋友 局域网版（Linux）：在终端里运行 ./start.sh
cd "$(dirname "$0")" || exit 1
exec ./node/node app/lan.mjs
