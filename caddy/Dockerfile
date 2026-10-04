# Build the React app, then serve the static files from Caddy itself.
FROM node:24-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Default Solana RPC baked into the bundle (see DEFAULT_RPC_URL in src/widget/chain.ts); empty = public devnet.
ARG VITE_SOLANA_RPC_URL=""
RUN VITE_SOLANA_RPC_URL="$VITE_SOLANA_RPC_URL" npm run build

FROM caddy:2-alpine
COPY caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend /src/dist /srv
