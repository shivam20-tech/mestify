FROM node:20

WORKDIR /app

COPY package*.json ./

RUN npm install

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && pip3 install yt-dlp

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]