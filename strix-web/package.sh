#!/bin/bash
set -e

VERSION="${1:-1.0.0}"
DIST_NAME="pentestteam-${VERSION}"
DIST_DIR="dist/${DIST_NAME}"

echo "=== Packaging Pentest Team v${VERSION} ==="

# Build Docker image
echo "[1/4] Building Docker image..."
docker compose build

# Save image to tar
echo "[2/4] Exporting Docker images..."
mkdir -p dist
docker save strix-web-app mongo:7 | gzip > "dist/images.tar.gz"

# Create distribution folder
echo "[3/4] Creating distribution package..."
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/data/strix_runs" "${DIST_DIR}/data/uploads" "${DIST_DIR}/data/mobile-uploads" "${DIST_DIR}/data/report-templates"

# docker-compose for distribution (uses pre-built image)
cat > "${DIST_DIR}/docker-compose.yml" << 'COMPOSE'
services:
  mongo:
    image: mongo:7
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db

  app:
    image: strix-web-app
    restart: unless-stopped
    ports:
      - "3001:3001"
    env_file: .env
    environment:
      - MONGO_URL=mongodb://mongo:27017
      - MONGO_DB=strix
      - PORT=3001
    volumes:
      - ./data/strix_runs:/app/strix_runs
      - ./data/uploads:/app/uploads
      - ./data/mobile-uploads:/app/mobile-uploads
      - ./data/report-templates:/app/report-templates
    depends_on:
      - mongo

volumes:
  mongo-data:
COMPOSE

# .env with placeholder
cat > "${DIST_DIR}/.env" << 'ENVFILE'
STRIX_LLM=deepseek/deepseek-v4-flash
LLM_API_KEY=your-api-key-here
ENVFILE

# Start script
cat > "${DIST_DIR}/start.sh" << 'START'
#!/bin/bash
set -e

if ! docker info > /dev/null 2>&1; then
  echo "Docker is not running. Please start Docker first."
  exit 1
fi

# Load images if not already loaded
if ! docker image inspect strix-web-app > /dev/null 2>&1; then
  echo "Loading Docker images (first time only)..."
  docker load -i images.tar.gz
fi

# Check .env
if grep -q "your-api-key-here" .env 2>/dev/null; then
  echo ""
  echo "WARNING: Please edit .env and set your LLM API key first!"
  echo "  Edit: .env"
  echo ""
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 0
fi

mkdir -p data/{strix_runs,uploads,mobile-uploads,report-templates}

docker compose up -d
echo ""
echo "Pentest Team is running!"
echo "Open: http://localhost:3001"
echo ""
echo "Commands:"
echo "  docker compose logs -f    # View logs"
echo "  docker compose down       # Stop"
echo "  docker compose up -d      # Start"
START
chmod +x "${DIST_DIR}/start.sh"

# Stop script
cat > "${DIST_DIR}/stop.sh" << 'STOP'
#!/bin/bash
docker compose down
echo "Pentest Team stopped."
STOP
chmod +x "${DIST_DIR}/stop.sh"

# Copy images
cp dist/images.tar.gz "${DIST_DIR}/"

# Create final archive
echo "[4/4] Creating archive..."
cd dist
tar czf "${DIST_NAME}.tar.gz" "${DIST_NAME}/"
cd ..

SIZE=$(du -sh "dist/${DIST_NAME}.tar.gz" | cut -f1)
echo ""
echo "=== Done! ==="
echo "Package: dist/${DIST_NAME}.tar.gz (${SIZE})"
echo ""
echo "Customer steps:"
echo "  1. tar xzf ${DIST_NAME}.tar.gz"
echo "  2. cd ${DIST_NAME}"
echo "  3. Edit .env (set API key)"
echo "  4. ./start.sh"
echo "  5. Open http://localhost:3001"
