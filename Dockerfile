FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY config ./config
ENV PORT=8787 BOOKINGS_FILE=/data/bookings.json
VOLUME /data
EXPOSE 8787
CMD ["node", "src/server.ts"]
