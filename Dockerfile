# Stage 1: Dependencies base
# Matches ci.yml/apply-migrations.yml's node-version: 22 -- this was 20,
# meaning the build CI validates (npm run typecheck/test/build under 22) and
# the build that actually ships (this stage's npm ci + npm run build) ran
# under different Node majors. 22 is proven working for this exact codebase
# by every CI run; not build-tested locally (no docker daemon in this
# sandbox), so CI's own image build is the real verification.
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat
# Install from the committed root workspace lockfile with `npm ci` so the
# production image is a reproducible, locked install -- not a fresh resolve
# against the registry on every build.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
RUN npm ci

# Stage 2: Production Build
FROM base AS builder
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run --prefix apps/web build

# Stage 3: Runner Production Image
FROM alpine:3.19 AS runner
WORKDIR /app
# ffmpeg is Film Study's frame-extraction prerequisite (#103, prereq 2). It is
# added AHEAD of the feature on purpose: the plan's measured-facts list needs
# extraction time inside this container and the image-size/cold-start cost of
# carrying the binary, and neither can be measured until it ships. Nothing
# calls it yet -- the film_study job type remains SHADOW_JOB_TYPE_UNAVAILABLE
# and the vision executor lands only after the vision deployment exists.
RUN apk add --no-cache nodejs ffmpeg
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Create low-privilege system user
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Pull standalone output configuration and static assets
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/infra/azure ./infra/azure

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
