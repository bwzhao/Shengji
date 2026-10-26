#!/bin/bash
# 升级·找朋友 局域网版（Mac）：双击运行。第一次如果提示「无法验证开发者」，见 README.txt
cd "$(dirname "$0")" || exit 1
# 解压出来的文件带着「从网上下载」的标记，去掉，免得系统拦着自带的 Node
xattr -dr com.apple.quarantine . 2>/dev/null
./node/node app/lan.mjs
echo ""
read -r -p "服务器已停止，按回车关闭窗口" _
