#!/usr/bin/env bash
# scripts/webkit-server.sh [start|stop]: a Playwright run-server for WebKit, in Docker, for the browser suite on a
# machine whose own WebKit cannot run it (vite.config.ts). `start` prints the address to export as RIPPLE_WEBKIT_WS.
# The server runs this repo's playwright-core, so the versions match. Its network is internal: the browser reaches
# the test server through the connecting client's loopback, and nothing else.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('playwright-core/package.json').version")
name=ripple-webkit-${version//./-}
case ${1:-start} in
  start)
    docker network inspect "$name" > /dev/null 2>&1 || docker network create --internal "$name" > /dev/null
    if [ -z "$(docker ps -q -f "name=^$name$")" ]; then
      # any image of the same minor version carries the WebKit build this playwright-core asks for
      image=$(docker images --format '{{.Repository}}:{{.Tag}}' mcr.microsoft.com/playwright | grep -m1 ":v${version%.*}\.[0-9]*-noble$" || true)
      docker run -d --rm --init --name "$name" --network "$name" --memory 6g --memory-swap 6g --user pwuser \
        -v "$PWD/node_modules/playwright-core:/pw:ro" "${image:-mcr.microsoft.com/playwright:v$version-noble}" \
        node /pw/cli.js run-server --port 3000 --host 0.0.0.0 > /dev/null
      for _ in $(seq 50); do docker logs "$name" 2>&1 | grep -q Listening && break; sleep 0.2; done
    fi
    echo "ws://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name"):3000/"
    ;;
  stop)
    docker rm -f "$name" > /dev/null 2>&1 || true
    docker network rm "$name" > /dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac
