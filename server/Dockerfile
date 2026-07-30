FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server

ENV PORT=8787
ENV CAPTION_FONTS_DIR=/usr/share/fonts/truetype/noto
ENV RUNTIME_DIR=/data/syncword

EXPOSE 8787

CMD ["node", "server/index.mjs"]
