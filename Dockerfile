FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY client ./client
ENV NODE_ENV=production PORT=8080 DATA_PATH=/data/rig.data.json
EXPOSE 8080
CMD ["node", "--max-old-space-size=220", "server/index.js"]
