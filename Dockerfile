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
COPY --from=builder /app/apps/web/out /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
