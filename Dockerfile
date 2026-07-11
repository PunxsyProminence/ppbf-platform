# Stage 1: Build static export
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY apps/web/package.json ./apps/web/
RUN npm install --prefix apps/web
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run --prefix apps/web build

# Stage 2: Serve with nginx
FROM nginx:alpine AS runner

# Run nginx as non-root
RUN addgroup -S ppbf && adduser -S ppbf -G ppbf \
    && mkdir -p /var/cache/nginx /var/run/nginx \
    && chown -R ppbf:ppbf /var/cache/nginx /var/run/nginx /var/log/nginx \
    && touch /run/nginx.pid && chown ppbf:ppbf /run/nginx.pid

COPY --from=builder --chown=ppbf:ppbf /app/apps/web/out /usr/share/nginx/html

# nginx config for SPA client-side routing
RUN printf 'server {\n\
    listen 80;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location / {\n\
        try_files $uri $uri/ $uri.html /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf \
    && chown ppbf:ppbf /etc/nginx/conf.d/default.conf

USER ppbf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
