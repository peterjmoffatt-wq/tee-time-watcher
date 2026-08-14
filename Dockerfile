FROM node:20-slim

# Debian bookworm's pip is "externally managed" (PEP 668) — --break-system-packages
# is required here, this is a container with nothing else using system Python.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages requests

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3030
CMD ["node", "server.js"]
