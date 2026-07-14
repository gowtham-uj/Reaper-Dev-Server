FROM node:20-bookworm-slim

WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bsdmainutils ca-certificates curl git gnupg python3 make g++ procps \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
    -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && . /etc/os-release \
  && printf '%s\n' \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

# Project terminals use OpenCode as a normal workspace CLI. This is separate
# from the removed agent-isolate feature and must remain available in shells.
RUN npm install -g opencode-ai@1.17.18 \
  && opencode --version

COPY src ./src


EXPOSE 4000

CMD ["node", "src/server.js"]
