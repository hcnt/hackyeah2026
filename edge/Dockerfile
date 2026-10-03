# Config is baked in (not bind-mounted): rsync replaces files by rename, which a
# single-file bind mount would not see. `up --build` recreates on any change.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
