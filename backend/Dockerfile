FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
