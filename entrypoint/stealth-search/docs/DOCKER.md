# Running in Docker

`docker/Dockerfile` builds an image with a real Google Chrome, a virtual display (Xvfb) and the published `@adhd/stealth-search` package. It runs as the unprivileged `node` user.

## Build

```sh
docker build --platform linux/amd64 -t stealth-search entrypoint/stealth-search/docker
docker build --platform linux/amd64 -t stealth-search --build-arg STEALTH_SEARCH_VERSION=0.1.0 entrypoint/stealth-search/docker
```

The image installs the version from npm (`latest` unless `STEALTH_SEARCH_VERSION` is set), so it tests what users get.

## Run

The default command is the MCP server over stdio. Keep stdin open with `-i`:

```sh
docker run -i --rm stealth-search
```

Wire it into an MCP client:

```json
{ "mcpServers": { "search": { "command": "docker", "args": ["run", "-i", "--rm", "stealth-search"] } } }
```

Run any CLI operation by naming the command:

```sh
docker run --rm stealth-search stealth-search search --provider npm --query playwright
docker run --rm stealth-search stealth-search listProviders
```

## What the image changes

- **Chrome is wrapped.** `/usr/local/bin/google-chrome` adds `--no-sandbox` and `--disable-dev-shm-usage` (a container has no user namespaces and a small `/dev/shm`) and executes the real `/opt/google/chrome/chrome`. The launcher resolves `google-chrome` from `PATH`.
- **A display is provided.** The launcher starts a headed Chrome, so the entrypoint is `tini -- xvfb-run -a`. `tini` is PID 1; without an init process `xvfb-run` never exits once the command is done.
- **Architecture.** Google publishes no Linux arm64 Chrome, so the image is `linux/amd64`. On arm64 hosts it runs under emulation, which is slower to start.

## State

The Chrome profile, the tripwire data and the reaper state live under the `node` user's home and `/tmp`, and are discarded with `--rm`. Mount a volume at `/home/node` to keep them between runs:

```sh
docker run -i --rm -v stealth-search-home:/home/node stealth-search
```

Chrome stays up after a CLI call until the idle timeout reaps it (see [CONFIGURATION.md](CONFIGURATION.md)); `--rm` removes the container either way.
