# stealth-search with a real Google Chrome, for containers and CI.
#
#   docker build -t stealth-search entrypoint/stealth-search/docker
#   docker run -i --rm stealth-search                                  # MCP over stdio
#   docker run --rm stealth-search stealth-search search --provider npm --query playwright
#
# Google ships no Linux arm64 Chrome. On an Apple Silicon or arm64 host the image is built
# for linux/amd64 and runs under emulation; override with --build-arg CHROME_PLATFORM=... only
# if you supply your own Chrome.
ARG CHROME_PLATFORM=linux/amd64
FROM --platform=${CHROME_PLATFORM} node:24-bookworm

ARG STEALTH_SEARCH_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates tini xvfb xauth lsof procps psmisc fonts-liberation \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# The launcher resolves `google-chrome` from PATH. A container has no user namespaces, so the real
# binary is wrapped only to add the two flags a container needs; nothing else is changed.
RUN printf '#!/bin/sh\nexec /opt/google/chrome/chrome --no-sandbox --disable-dev-shm-usage "$@"\n' > /usr/local/bin/google-chrome \
 && chmod +x /usr/local/bin/google-chrome

RUN npm install -g "@adhd/stealth-search@${STEALTH_SEARCH_VERSION}" && npm cache clean --force

# Chrome is headed (no automation flag), so it runs on a virtual display. tini is PID 1: without an init
# process xvfb-run never exits after the command finishes. Not root.
USER node
ENV HOME=/home/node
ENTRYPOINT ["tini", "--", "xvfb-run", "-a"]
CMD ["stealth-search-mcp", "--transport", "stdio", "--log-level", "silent"]
