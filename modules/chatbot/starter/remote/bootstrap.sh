#!/usr/bin/env bash
# AI Admin Starter — เตรียมเซิร์ฟเวอร์ (Ubuntu 22.04/24.04 หรือ Debian 12) ครั้งแรกและทุกครั้งที่อัปเดต
# รันในฐานะ root บน VPS เท่านั้น — ตัวช่วยบนเครื่องนักเรียน (starter/cli.mjs deploy) อัปโหลดแล้วสั่งให้เอง
#
#   bash bootstrap.sh <release.tar.gz> <host>
#
# ทำซ้ำได้ปลอดภัย (idempotent): ข้อมูลใน /var/lib/ai-admin และค่าใน /etc/ai-admin/env ไม่ถูกเขียนทับ
# ค่าลับที่สร้างที่นี่ (CONSOLE_SESSION_SECRET, DASHBOARD_API_KEY) อยู่บนเซิร์ฟเวอร์เท่านั้น ไม่พิมพ์ออกจอ

set -euo pipefail

RELEASE_TAR="${1:?ต้องระบุไฟล์ release}"
HOST="${2:?ต้องระบุชื่อโดเมน เช่น 203-0-113-5.sslip.io}"

APP_USER=aiadmin
BASE=/opt/ai-admin
DATA=/var/lib/ai-admin
ETC=/etc/ai-admin
ENV_FILE="$ETC/env"
NODE_MAJOR=22
PORT=4850

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "ต้องรันด้วย root"
[ -f "$RELEASE_TAR" ] || die "ไม่พบไฟล์ $RELEASE_TAR"
case "$HOST" in *[!A-Za-z0-9.-]*|'') die "ชื่อโดเมนไม่ถูกต้อง: $HOST" ;; esac
. /etc/os-release 2>/dev/null || true
case "${ID:-}" in ubuntu|debian) ;; *) die "รองรับเฉพาะ Ubuntu/Debian (เครื่องนี้: ${PRETTY_NAME:-ไม่ทราบ})" ;; esac

export DEBIAN_FRONTEND=noninteractive
# VPS ที่เพิ่งเปิดมักกำลังอัปเดตตัวเองอยู่ (apt ถูกล็อก) — รอได้ถึง 5 นาทีแทนการล้มทันที
APT=(apt-get -o DPkg::Lock::Timeout=300)

step() { say ""; say "▶ $*"; }

step "1/7 ติดตั้งเครื่องมือพื้นฐาน"
"${APT[@]}" update -qq
"${APT[@]}" install -y -qq curl ca-certificates tar xz-utils openssl ufw debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null

step "2/7 Node.js ${NODE_MAJOR} (ตัวทางการจาก nodejs.org ตรวจ SHA-256)"
node_ok() { [ -x "$BASE/node/bin/node" ] && [ "$("$BASE/node/bin/node" -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; }
if node_ok; then
  say "✅ มี Node.js $("$BASE/node/bin/node" -v) แล้ว"
else
  case "$(uname -m)" in x86_64|amd64) cpu=x64 ;; aarch64|arm64) cpu=arm64 ;; *) die "CPU $(uname -m) ยังไม่รองรับ" ;; esac
  dist="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsSL "$dist/SHASUMS256.txt")"
  file="$(printf '%s\n' "$sums" | awk -v want="-linux-${cpu}.tar.xz" '{ n = length($2) - length(want) + 1 } n > 0 && substr($2, n) == want && $2 ~ /^node-v/ { print $2; exit }')"
  [ -n "$file" ] || die "ไม่พบ Node.js สำหรับ linux-${cpu}"
  sha="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$file" "$dist/$file"
  [ "$(sha256sum "$tmp/$file" | awk '{print $1}')" = "$sha" ] || { rm -rf "$tmp"; die "ไฟล์ Node.js ไม่ตรงกับที่ nodejs.org ประกาศ — หยุดเพื่อความปลอดภัย"; }
  mkdir -p "$BASE"
  rm -rf "$BASE/node.new"; mkdir -p "$BASE/node.new"
  tar -xJf "$tmp/$file" -C "$BASE/node.new" --strip-components=1
  rm -rf "$BASE/node"; mv "$BASE/node.new" "$BASE/node"; rm -rf "$tmp"
  say "✅ Node.js $("$BASE/node/bin/node" -v)"
fi

step "3/7 ผู้ใช้ระบบและโฟลเดอร์"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin "$APP_USER"
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$DATA" "$DATA/img" "$DATA/backups"
install -d -m 750 -o root -g "$APP_USER" "$ETC"

step "4/7 วางโค้ดเวอร์ชันใหม่ (เก็บเวอร์ชันก่อนไว้ถอยกลับ)"
stamp="$(date +%Y%m%d-%H%M%S)"
rel="$BASE/releases/$stamp"
mkdir -p "$rel"
tar -xzf "$RELEASE_TAR" -C "$rel"
[ -f "$rel/src/server.mjs" ] || die "ไฟล์ release ไม่สมบูรณ์ (ไม่พบ src/server.mjs)"
chown -R root:root "$rel"; chmod -R go-w "$rel"; chmod -R a+rX "$rel"
old_rel="$(readlink "$BASE/current" 2>/dev/null || true)"

step "5/7 ค่าตั้งต้น (สร้างครั้งแรกเท่านั้น ค่าเดิมไม่ถูกแตะ)"
touch "$ENV_FILE"; chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
set_default() { # set_default KEY VALUE — เขียนเฉพาะถ้ายังไม่มี KEY
  grep -qE "^$1=" "$ENV_FILE" || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
}
set_default PORT "$PORT"
set_default BIND_HOST 127.0.0.1
set_default DATA_DIR "$DATA"
set_default DB_FILE "$DATA/chassis.sqlite"
set_default BUSINESS_PROFILE generic
set_default CONSOLE_BRAND_THEME starter
set_default CONSOLE_COOKIE_SECURE true
set_default CONSOLE_PUBLIC_BASE_URL "https://$HOST"
set_default MEDIA_PUBLIC_BASE_URL "https://$HOST"
set_default HERMES_BASE https://api.openai.com/v1
set_default HERMES_MODEL gpt-6.1-sol
set_default HERMES_SCORER_MODEL gpt-6-luna
set_default HERMES_FOLLOWUP_MODEL gpt-6-luna
set_default OPENAI_BASE https://api.openai.com/v1
set_default LINE_LIVE_SEND false
set_default PERSONA_FILE "$DATA/persona.md"
set_default IMAGE_CATALOG_FILE "$DATA/image-catalog.json"
set_default IMAGE_DIR "$DATA/img"
set_default CHASSIS_SKIP_ENV_FILES true
grep -qE '^CONSOLE_SESSION_SECRET=.+' "$ENV_FILE" || printf 'CONSOLE_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
grep -qE '^DASHBOARD_API_KEY=.+' "$ENV_FILE" || printf 'DASHBOARD_API_KEY=%s\n' "$(openssl rand -hex 24)" >> "$ENV_FILE"
# ยังไม่มี LINE จริง = ใส่กุญแจทดลองไว้ก่อน เพื่อให้ "ลองแชท" บนเซิร์ฟเวอร์ได้ (ส่ง LINE จริงยังปิด)
if ! grep -qE '^LINE_CHANNEL_SECRET=.+' "$ENV_FILE"; then
  printf 'LINE_CHANNEL_SECRET=%s\nLINE_SANDBOX=1\nLINE_MOCK_URL=http://127.0.0.1:4899\n' "$(openssl rand -hex 16)" >> "$ENV_FILE"
fi
# ชื่อเว็บล่าสุดเสมอ (เปลี่ยนโดเมนได้)
sed -i -E "s#^CONSOLE_PUBLIC_BASE_URL=.*#CONSOLE_PUBLIC_BASE_URL=https://$HOST#; s#^MEDIA_PUBLIC_BASE_URL=.*#MEDIA_PUBLIC_BASE_URL=https://$HOST#" "$ENV_FILE"
[ -f "$DATA/persona.md" ] || install -m 640 -o "$APP_USER" -g "$APP_USER" "$rel/config/persona.example.md" "$DATA/persona.md"
[ -f "$DATA/image-catalog.json" ] || { printf '[]\n' > "$DATA/image-catalog.json"; chown "$APP_USER:$APP_USER" "$DATA/image-catalog.json"; }
printf '%s\n' "$HOST" > "$ETC/host"

step "6/7 บริการระบบ (เปิดเองเมื่อเครื่องรีสตาร์ต)"
cat > /etc/systemd/system/ai-admin.service <<UNIT
[Unit]
Description=AI Admin Starter (LINE OA AI admin + console)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$BASE/current
EnvironmentFile=$ENV_FILE
ExecStart=$BASE/node/bin/node src/server.mjs
Restart=always
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA
UMask=0027

[Install]
WantedBy=multi-user.target
UNIT
install -m 750 "$rel/starter-remote/ai-admin-ctl.sh" /usr/local/sbin/ai-admin-ctl
systemctl daemon-reload
systemctl enable ai-admin.service >/dev/null 2>&1
# อัปเดตเครื่องที่ใช้งานอยู่: สำรองฐานข้อมูลก่อนเสมอ (เผื่อเวอร์ชันใหม่ปรับโครงฐาน)
if [ -f "$DATA/chassis.sqlite" ] && [ -n "$old_rel" ]; then /usr/local/sbin/ai-admin-ctl backup >/dev/null; fi
switch_to() { ln -sfn "$1" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"; }
healthy() {
  for _ in $(seq 1 40); do curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
switch_to "$rel"
systemctl restart ai-admin.service
if ! healthy; then
  journalctl -u ai-admin -n 40 --no-pager
  if [ -n "$old_rel" ] && [ -d "$old_rel" ]; then
    switch_to "$old_rel"; systemctl restart ai-admin.service
    die "เวอร์ชันใหม่เปิดไม่ขึ้น — ถอยกลับเวอร์ชันเดิมให้แล้ว (ข้อความด้านบนบอกสาเหตุ)"
  fi
  die "ระบบเปิดไม่ขึ้น — ดูข้อความด้านบน"
fi
# ผ่านแล้วจึงจำเวอร์ชันก่อนหน้าไว้ถอยกลับ + เก็บแค่ 3 เวอร์ชันล่าสุด
if [ -n "$old_rel" ] && [ "$old_rel" != "$rel" ]; then ln -sfn "$old_rel" "$BASE/previous"; fi
keep_cur="$(readlink "$BASE/current")"; keep_prev="$(readlink "$BASE/previous" 2>/dev/null || true)"
ls -1dt "$BASE"/releases/* 2>/dev/null | tail -n +4 | while read -r old; do
  if [ "$old" != "$keep_cur" ] && [ "$old" != "$keep_prev" ]; then rm -rf "$old"; fi
done

step "7/7 HTTPS (Caddy ขอใบรับรองให้อัตโนมัติ) + ไฟร์วอลล์"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  "${APT[@]}" update -qq && "${APT[@]}" install -y -qq caddy >/dev/null
fi
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy
# เปิดพอร์ต SSH ที่ใช้อยู่จริงก่อนเปิดไฟร์วอลล์ (บางเจ้าไม่ใช้ 22) — ไม่งั้นล็อกตัวเองออกจากเครื่อง
ssh_ports="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' || true)"
conn_port="$(printf '%s' "${SSH_CONNECTION:-}" | awk '{ print $4 }')"
for p in 22 $ssh_ports $conn_port; do
  case "$p" in ''|*[!0-9]*) ;; *) ufw allow "$p/tcp" >/dev/null ;; esac
done
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
say ""
say "✅ เซิร์ฟเวอร์พร้อม: https://$HOST/console"
