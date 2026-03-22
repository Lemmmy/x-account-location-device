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
