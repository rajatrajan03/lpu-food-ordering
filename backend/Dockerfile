FROM node:20-slim

# Prisma's query engine needs libssl at runtime — node:20-slim (Debian) doesn't
# include it by default, which crashes Prisma on startup with "cannot open
# shared object file: libssl.so.1.1".
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
