# Stage 1: Build frontend
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Install strix — use bookworm to match runtime glibc
FROM python:3.12-bookworm AS strix-build
RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"
WORKDIR /build
COPY strix-src/ ./
RUN uv sync --no-dev
RUN uv run python -c "import strix; print('strix OK')"

# Stage 3: Production
FROM node:20-bookworm-slim

# Copy Python 3.12 runtime from build stage (same glibc)
COPY --from=strix-build /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=strix-build /usr/local/bin/python3 /usr/local/bin/python3
COPY --from=strix-build /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=strix-build /usr/local/lib/libpython3.12.so* /usr/local/lib/

# Copy entire strix build dir (venv references /build for editable install)
COPY --from=strix-build /build /opt/strix

# Install Docker CLI (strix needs it to run scan containers)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Fix editable install path (was /build, now /opt/strix)
RUN sed -i 's|/build|/opt/strix|g' /opt/strix/.venv/lib/python3.12/site-packages/_editable_impl_strix_agent.pth \
    && ldconfig \
    && printf '#!/bin/sh\nexec /opt/strix/.venv/bin/python -W ignore::RuntimeWarning -m strix.interface.main "$@"\n' > /usr/local/bin/strix \
    && chmod +x /usr/local/bin/strix \
    && mkdir -p /root/.strix/bin \
    && ln -s /usr/local/bin/strix /root/.strix/bin/strix

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./
COPY --from=client-build /app/client/dist ./public

RUN mkdir -p uploads mobile-uploads strix_runs report-templates

ENV NODE_ENV=production
ENV PORT=3001
ENV MONGO_URL=mongodb://mongo:27017
ENV MONGO_DB=strix
ENV PATH="/opt/strix/.venv/bin:$PATH"

EXPOSE 3001

CMD ["node", "index.js"]
