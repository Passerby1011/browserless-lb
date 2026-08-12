FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docker ./docker

ENV NODE_ENV=production
EXPOSE 3000

USER node
CMD ["node", "docker/server.js"]
