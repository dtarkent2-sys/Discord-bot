# Node 22 + Python 3 for ML predictor (databento, scikit-learn, matplotlib)
FROM node:22-slim

# System packages: canvas/chart rendering + Python 3
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig libfontconfig1 libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libjpeg-dev libgif-dev librsvg2-dev libpixman-1-0 fonts-dejavu-core \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python ML dependencies first (better layer caching)
COPY ml/requirements.txt ml/requirements.txt
RUN pip install --break-system-packages --no-cache-dir -r ml/requirements.txt

# Install Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
