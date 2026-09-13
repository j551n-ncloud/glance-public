FROM node:20-alpine
# Picks up patched Alpine packages regardless of how stale the upstream
# node:20-alpine tag's own layer is - a floating tag doesn't get
# rebuilt just because Alpine cut a new security fix.
#
# APK_REFRESH exists only to move this layer's cache key: the command
# never changes when Alpine cuts a fix, so a registry layer cache
# restores it verbatim and the upgrade becomes a no-op - the image
# keeps the package set the first build saw no matter how often it is
# rebuilt. services/build passes the build date. Same fix as
# ics-proxy's APT_REFRESH, see the longer note there.
ARG APK_REFRESH=0
RUN echo "apk refresh: ${APK_REFRESH}" && apk update && apk upgrade --no-cache
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
# npm/npx are never invoked at runtime (CMD is a plain `node` call) -
# only the install step above needs them. Node's own base image ships
# npm with its own bundled (and often outdated) tar/cross-spawn/
# minimatch/glob/etc, unrelated to this project's own dependencies -
# see n-docs's Dockerfile for the CVE scan that found this.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
EXPOSE 3001
CMD ["node", "server.js"]
