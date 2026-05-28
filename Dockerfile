FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg
RUN pip3 install --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "start"]
