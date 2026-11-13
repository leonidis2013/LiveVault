# LiveVault: multitrack library for LiveWebMixer
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WATCH_DIR=/watch \
    PORT=8080 \
    HTTPS_PORT=8443

# ffmpeg converts tracks to 96 kHz / 24-bit WAV and makes the Opus previews, unzip opens multitrack zips,
# openssl makes the self-signed certificate for the https port
RUN apk add --no-cache ffmpeg unzip openssl tzdata

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# tracks, sessions, mixes, recordings, users and the certificate are kept in /data (a volume, so they survive updates)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 8080: http (also what LiveWebMixer uses to reach LiveVault). 8443: https with a self-signed certificate.
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
