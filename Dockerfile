FROM node:20-alpine
WORKDIR /app

# Backend deps from the lock file (now in sync, so this is reproducible)
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Backend source + prebuilt frontend (run `npm run build` in frontend/ first)
COPY backend/ ./
COPY frontend/build ./frontend/build
COPY bundles/ ./seed-bundles
COPY packs/ ./seed-packs
# Hashes of every version of the seed content we have ever shipped. seedSync.js
# uses it to tell "this file is just an old release of ours" (safe to update)
# from "the user edited this" (leave it alone) on installs that predate the
# seed ledger. Regenerate with `npm run seed:hashes` when seed content changes.
COPY seed-known-hashes.json ./seed-known-hashes.json

RUN mkdir -p /data
ENV DATA_DIR=/data
ENV BUNDLES_DIR=/bundles
ENV SEED_PACKS_DIR=/app/seed-packs
ENV SEED_BUNDLES_DIR=/app/seed-bundles
ENV PORT=3000
# NODE_ENV intentionally not pinned — compose sets it:
#   development = LAN/http (cookie not secure); production = behind NPM/HTTPS
EXPOSE 3000
CMD ["node", "server.js"]