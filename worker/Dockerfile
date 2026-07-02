FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg
RUN pip3 install --break-system-packages "yt-dlp>=2026.3.17"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
