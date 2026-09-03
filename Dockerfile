FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

ENV HOST=0.0.0.0 \
    PORT=3000 \
    PROGRESSIVE_READING_CACHE_DIR=/data

EXPOSE 3000

CMD ["npm", "run", "server"]
