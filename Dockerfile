FROM node:20-alpine AS build

WORKDIR /app
COPY package.json ./
COPY core-ts/package.json core-ts/package-lock.json ./core-ts/
RUN npm install --prefix core-ts
COPY server.mjs app.js index.html styles.css ./
COPY core-ts ./core-ts
RUN npm run build --prefix core-ts

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8765
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/app.js ./app.js
COPY --from=build /app/index.html ./index.html
COPY --from=build /app/styles.css ./styles.css
COPY --from=build /app/core-ts/package.json ./core-ts/package.json
COPY --from=build /app/core-ts/node_modules ./core-ts/node_modules
COPY --from=build /app/core-ts/dist ./core-ts/dist
EXPOSE 8765
CMD ["node", "server.mjs"]
