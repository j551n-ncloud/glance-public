FROM node:20-trixie-slim
WORKDIR /app
COPY package.json ./
# Debian-slim, not Alpine: the local embeddings model's ONNX runtime ships
# prebuilt native bindings for glibc only, not Alpine's musl libc.
# trixie (Debian 13, current stable), not bookworm (Debian 12 - it
# became oldstable and a real CVE scan showed it: several Critical/High
# findings with no fix available in bookworm at all, not because
# nothing was patched upstream but because oldstable simply stops
# getting most backports). Same glibc-vs-musl reasoning as the
# Debian-not-Alpine choice above, just picking the currently-supported
# release of it.
#
# The base image's own apt sources also pin to a dated
# snapshot.debian.org URL (reproducible builds, but frozen - `apt-get
# upgrade` alone can't see anything patched after that date no matter
# how often this rebuilds). Overwriting it with the live mirrors first
# is what actually makes `upgrade` mean "latest available", not just
# "latest as of whenever this base layer was built".
#
# build deps are only needed to compile better-sqlite3's native addon; drop them after.
#
# APT_REFRESH exists only to move this layer's cache key. Debian keeps
# publishing security updates, but nothing about the command below
# changes when it does, so services/build's registry layer cache
# restores the layer verbatim and `apt-get upgrade` quietly becomes a
# no-op - the image keeps whatever package set the very first build
# saw, however many times it is "rebuilt". That is what the 4f6d43c
# scan caught: 15 fixable findings (gzip, libc6, libpcre2, libsqlite3),
# all of them just Debian 13.7 packages the image had never had a
# chance to install. services/build passes the build date here, so a
# rebuild is actually a rebuild. It invalidates the npm install that
# shares this layer too, costing a better-sqlite3 recompile per build -
# that is the price of the guarantee, not an accident.
ARG APT_REFRESH=0
RUN echo "apt refresh: ${APT_REFRESH}" \
  && printf '%s\n' \
      'Types: deb' \
      'URIs: http://deb.debian.org/debian' \
      'Suites: trixie trixie-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      '' \
      'Types: deb' \
      'URIs: http://deb.debian.org/debian-security' \
      'Suites: trixie-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      > /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm install --omit=dev \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY server.js ./
COPY lib ./lib
# npm/npx are never invoked at runtime (CMD is a plain `node` call) -
# only the install step above needs them. Node's own base image ships
# npm with its own bundled (and often outdated) tar/cross-spawn/
# minimatch/glob/etc, unrelated to this project's own dependencies -
# see n-docs's Dockerfile for the CVE scan that found this.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# Same reasoning one layer down: perl is part of Debian's base system,
# not something a `node server.js` process ever calls. It carries the
# only Critical findings left in a real scan of this image
# (CVE-2026-8376, CVE-2026-42496, CVE-2026-13221), and those are
# genuinely unfixable by upgrading - Debian has no patched perl-base
# for them on any supported release yet, one is explicitly marked
# fix_deferred. `apt-cache rdepends --installed perl-base` comes back
# empty here, so nothing else in this image needs it either.
#
# Purged rather than rm -rf'd so dpkg's own database stays consistent
# with what's actually on disk - a scanner reading the package list
# should see it gone, not just find the files missing.
RUN apt-get purge -y --allow-remove-essential perl-base \
  && rm -rf /var/lib/apt/lists/*
EXPOSE 3000
CMD ["node", "server.js"]
