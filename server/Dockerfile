FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY adapters ./adapters

ENV PORT=3003
EXPOSE 3003
CMD ["node", "server.js"]
