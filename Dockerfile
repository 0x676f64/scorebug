# scorebug — Node 22, one process, static client in public/
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY tools/build.mjs tools/
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
ARG BUILD_ID=dev
ENV BUILD_ID=$BUILD_ID
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
