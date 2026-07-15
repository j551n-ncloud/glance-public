FROM node:20-alpine
WORKDIR /app
COPY package.json ./
# build deps are only needed to compile better-sqlite3's native addon; drop them after.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm install --omit=dev \
  && apk del .build-deps
COPY server.js ./
COPY lib ./lib
EXPOSE 3000
CMD ["node", "server.js"]
