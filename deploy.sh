#!/usr/bin/env bash
# Push an update to your phone:  ./deploy.sh "what changed"
set -e
cd "$(dirname "$0")"
cur=$(grep -o "APP_VERSION = '[0-9.]*'" js/version.js | grep -o "[0-9][0-9.]*")
IFS=. read -r a b c <<< "$cur"; v="$a.$b.$((c+1))"
sed -i.bak "s/APP_VERSION = '[0-9.]*'/APP_VERSION = '$v'/" js/version.js && rm -f js/version.js.bak
git add -A && git commit -m "v$v: ${1:-update}" && git push
echo "Pushed version $v."
