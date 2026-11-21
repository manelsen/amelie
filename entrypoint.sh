#!/bin/sh
set -e
umask 077

# O container sobe como root só para preparar o volume e então cai para o
# usuário sem privilégios "amelie". Os parsers de mídia (ffmpeg, Pillow,
# libwebp) processam conteúdo de terceiros; se um deles tiver uma falha
# explorável, o atacante não ganha root no container que guarda a sessão do
# WhatsApp e as chaves de API.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  # Volumes criados por versões anteriores (que rodavam como root) pertencem
  # a root. Ajusta o dono uma vez; nas próximas subidas o teste já passa.
  if [ "$(stat -c %u /data)" != "$(id -u amelie)" ]; then
    echo "[amelie] Ajustando dono de /data para o usuário amelie (uma vez)..."
    chown -R amelie:amelie /data
  fi
  exec su-exec amelie:amelie "$0" "$@"
fi

: "${BRIDGE_TOKEN:?Defina BRIDGE_TOKEN com pelo menos 32 caracteres aleatórios}"
if [ "${#BRIDGE_TOKEN}" -lt 32 ]; then
  echo "BRIDGE_TOKEN deve ter pelo menos 32 caracteres aleatórios" >&2
  exit 1
fi

BRIDGE_PORT="${BRIDGE_PORT:-8080}"
BRIDGE_DB_PATH="${BRIDGE_DB_PATH:-/data/bridge/whatsapp.db}"
GLEAM_PORT="${PORT:-4000}"

export WHATSMEOW_URL="http://127.0.0.1:${BRIDGE_PORT}"
export GLEAM_URL="http://127.0.0.1:${GLEAM_PORT}/webhook"
export BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
export MEDIA_TEMP_DIR="${MEDIA_TEMP_DIR:-/tmp/amelie-media}"

mkdir -p "$(dirname "$BRIDGE_DB_PATH")"

echo "[amelie] Iniciando supervisor do bridge (porta ${BRIDGE_PORT})..."
(
  while true; do
    if /usr/local/bin/amelie-bridge; then
      bridge_exit=0
    else
      bridge_exit=$?
    fi
    echo "[amelie] Bridge terminou com código ${bridge_exit}. Reiniciando em 2s..."
    sleep 2
  done
) &

echo "[amelie] Iniciando app (porta ${GLEAM_PORT})..."
exec erl \
  -pa /app/build/erlang-shipment/*/ebin \
  -eval "'amelie@@main':run(amelie)." \
  -noshell
