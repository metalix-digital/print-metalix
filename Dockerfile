FROM node:20-bookworm-slim

# libreoffice-writer/-impress: headless DOC/DOCX/PPT/PPTX -> PDF conversion
# for upload previews and the admin Print Job Sheet (see server/docConvert.js).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    libreoffice-writer libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

WORKDIR /app/server
RUN npm ci --omit=dev

WORKDIR /app
EXPOSE 5050
CMD ["node", "server/server.js"]
