FROM node:24-alpine AS pnpm

RUN apk add ca-certificates

COPY ./package.json ./pnpm-lock.yaml /app/

WORKDIR /app
RUN corepack enable
RUN corepack install

FROM pnpm AS dep-env
RUN pnpm install --frozen-lockfile

FROM dep-env AS build-env
COPY . /app/
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=build-env /app/dist ./dist
COPY --from=build-env /app/package.json ./package.json
COPY --from=build-env /app/pnpm-lock.yaml ./pnpm-lock.yaml
RUN corepack enable
RUN corepack install
RUN pnpm install --production --frozen-lockfile
EXPOSE 3000
CMD ["node", "dist/index.js"]
