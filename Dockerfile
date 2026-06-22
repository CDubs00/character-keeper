FROM node:20-alpine
WORKDIR /app

# Backend deps from the lock file (now in sync, so this is reproducible)
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Backend source + prebuilt frontend (run `npm run build` in frontend/ first)
COPY backend/ ./
COPY frontend/build ./frontend/build
COPY bundles/ ./seed-bundles

RUN mkdir -p /data
ENV DATA_DIR=/data
ENV BUNDLES_DIR=/bundles
ENV SEED_BUNDLES_DIR=/app/seed-bundles
ENV PORT=3000
# NODE_ENV intentionally not pinned — compose sets it:
#   development = LAN/http (cookie not secure); production = behind NPM/HTTPS
EXPOSE 3000
CMD ["node", "server.js"]