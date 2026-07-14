FROM python:3-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    BUN_INSTALL=/usr/local

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    bash zsh tmux tini git git-lfs curl wget ca-certificates \
    build-essential cmake pkg-config python3-pip pipx python3-venv \
    procps lsof iproute2 iputils-ping dnsutils netcat-openbsd openssh-client \
    rsync unzip zip tar gzip xz-utils ripgrep fd-find fzf jq sqlite3 \
    postgresql-client vim nano less locales \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && git lfs install --system \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && curl -fsSL https://deb.nodesource.com/setup_current.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g corepack@latest opencode-ai@latest \
 && corepack enable \
 && curl -fsSL https://bun.sh/install | bash \
 && bun --version \
 && node --version \
 && opencode --version \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

COPY tmux.conf /reaper/tmux.conf
COPY entrypoint.sh /usr/local/bin/reaper-pod-entrypoint
COPY session-supervisor.c /tmp/session-supervisor.c
RUN cc -O2 -Wall -Wextra -Werror /tmp/session-supervisor.c -o /usr/local/bin/reaper-session \
 && strip /usr/local/bin/reaper-session \
 && rm -f /tmp/session-supervisor.c \
 && chmod 0755 /usr/local/bin/reaper-pod-entrypoint /usr/local/bin/reaper-session

WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/reaper-pod-entrypoint"]
