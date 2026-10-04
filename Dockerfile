# Dos etapas: en la primera se compila (TypeScript y la interfaz web); la
# segunda solo lleva lo necesario para ejecutar. La imagen final no tiene
# compiladores ni dependencias de desarrollo.
FROM node:22-alpine AS construir
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY tsconfig.json ./
COPY src src
COPY web web
RUN npm run build && cd web && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=construir /app/dist dist
COPY --from=construir /app/web/dist web/dist
COPY sql sql
COPY conocimiento conocimiento
# El proceso no corre como root.
USER node
CMD ["node", "dist/main-api.js"]
