#!/usr/bin/env bash
# ai-admin-ctl — คำสั่งดูแลระบบบนเซิร์ฟเวอร์ (root) ที่ตัวช่วยบนเครื่องนักเรียนเรียกผ่าน SSH
# ไม่มีคำสั่งไหนพิมพ์ค่าลับออกจอ — ค่าลับรับทาง stdin เท่านั้น
set -euo pipefail
umask 077

BASE=/opt/ai-admin
DATA=/var/lib/ai-admin
ENV_FILE=/etc/ai-admin/env
NODE="$BASE/node/bin/node"
APP="$BASE/current"
PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2 || true)"; PORT="${PORT:-4850}"

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "ต้องรันด้วย root"

# ค่าที่ตั้งผ่าน set-env / brand.env ได้ (กันตั้งค่าแปลก ๆ ทับระบบ)
ALLOWED='^(OPENAI_API_KEY|HERMES_API_KEY|LINE_CHANNEL_SECRET|LINE_CHANNEL_ACCESS_TOKEN|LINE_CHANNEL_NAME|LINE_BASIC_ID|LINE_LIVE_SEND|HERMES_MODEL|HERMES_SCORER_MODEL|HERMES_FOLLOWUP_MODEL|BRAND_AGENT_NAME|BRAND_OWNER_NAME|BRAND_BUSINESS_NAME|BRAND_REVIEW_DOMAINS|BUSINESS_ID|BUSINESS_PROFILE|PERSONA_PARTICLES|CONSOLE_BRAND_NAME|CONSOLE_BRAND_MARK|CONSOLE_BRAND_AGENT|CONSOLE_BRAND_THEME|ESCALATE_NOTIFY_IDS|FOLLOWUP_ENABLED|BROADCAST_ENABLED|IMAGE_CLASSIFY_ENABLED|FB_ENABLED|FB_LIVE_SEND|FB_PAGE_ACCESS_TOKEN|FB_APP_SECRET|FB_VERIFY_TOKEN)$'

env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

# ไฟล์ env อ่านสองแบบ (systemd + bash ของสคริปต์นี้) — ค่าที่มีเครื่องหมายคำพูด/\/$/` อ่านไม่ตรงกัน จึงไม่รับเลย
valid_value() { [[ "$1" != *[\"\'\\\$\`]* ]] && [[ "$1" != *$'\n'* ]] && [[ "$1" != *$'\r'* ]]; }

env_put() { # env_put KEY VALUE (atomic, keeps others, never echoes VALUE)
  local key="$1" val="$2" tmp
  valid_value "$val" || die "ค่า $key มีเครื่องหมาย \" ' \\ \$ \` หรือขึ้นบรรทัดใหม่ — ไม่รับ (แก้ข้อความแล้วลองใหม่)"
  tmp="$(mktemp "$ENV_FILE.XXXX")"
  grep -vE "^$key=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  chown root:aiadmin "$tmp"; chmod 640 "$tmp"; mv "$tmp" "$ENV_FILE"
}

env_drop() { # env_drop REGEX
  local tmp; tmp="$(mktemp "$ENV_FILE.XXXX")"
  grep -vE "^($1)=" "$ENV_FILE" > "$tmp" || true
  chown root:aiadmin "$tmp"; chmod 640 "$tmp"; mv "$tmp" "$ENV_FILE"
}

run_as_app() { # รันสคริปต์ Node ในฐานะผู้ใช้ระบบ พร้อมค่าใน env (อ่านทีละบรรทัด ไม่ประมวลผลเป็นคำสั่ง)
  (
    cd "$APP"
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]]; then export "$line"; fi
    done < "$ENV_FILE"
    runuser -u aiadmin -- "$NODE" "$@"
  )
}

wait_health() {
  for _ in $(seq 1 40); do curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0; sleep 1; done
  journalctl -u ai-admin -n 40 --no-pager >&2; die "ระบบไม่ขึ้นภายใน 40 วินาที"
}

# ตอนจบสคริปต์ (สำเร็จหรือล้ม): ลบไฟล์ชั่วคราว และถ้าเราหยุดบริการไว้ ต้องเปิดกลับเสมอ ร้านจะได้ไม่เงียบ
CLEANUP_DIR=""
SERVICE_STOPPED=0
on_exit() {
  if [ -n "$CLEANUP_DIR" ]; then rm -rf "$CLEANUP_DIR"; fi
  if [ "$SERVICE_STOPPED" = 1 ]; then systemctl start ai-admin >/dev/null 2>&1 || true; fi
}
trap on_exit EXIT
stop_service() { SERVICE_STOPPED=1; systemctl stop ai-admin; }
start_service() { systemctl start ai-admin; SERVICE_STOPPED=0; wait_health; }

cmd_set_env() { # stdin: KEY=VALUE ต่อบรรทัด
  local line key val n=0 keys=()
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    [[ "$line" == *=* ]] || die "รูปแบบต้องเป็น KEY=VALUE"
    key="${line%%=*}"; val="${line#*=}"
    [[ "$key" =~ $ALLOWED ]] || die "ไม่อนุญาตให้ตั้ง $key"
    env_put "$key" "$val"; n=$((n + 1)); keys+=("$key")
    if [ "$key" = LINE_CHANNEL_SECRET ]; then env_drop 'LINE_SANDBOX|LINE_MOCK_URL'; fi # ใส่ของจริงแล้ว เลิกโหมดทดลอง
    if [ "$key" = OPENAI_API_KEY ] && [ "$(env_get HERMES_BASE)" = "https://api.openai.com/v1" ]; then
      env_put HERMES_API_KEY "$val" # คีย์เดียวใช้ทั้งตอบแชทและถอดเสียง
    fi
  done
  say "✅ บันทึกแล้ว $n ค่า: ${keys[*]:-}"
}

cmd_check_openai() { # ทดสอบคีย์ด้วย Node (คีย์ไม่ขึ้นใน argv ของ process ใด)
  run_as_app -e '
    const key = process.env.OPENAI_API_KEY || "";
    if (!key) { console.log("none"); process.exit(0); }
    fetch((process.env.OPENAI_BASE || "https://api.openai.com/v1") + "/models", { headers: { authorization: "Bearer " + key } })
      .then((r) => console.log(String(r.status)), () => console.log("network"));'
}

cmd_set_owner() { # stdin: username\npassword
  local user pass
  IFS= read -r user; IFS= read -r pass
  [[ "$user" =~ ^[a-zA-Z0-9._-]{3,32}$ ]] || die "ชื่อผู้ใช้ต้องเป็นอังกฤษ/ตัวเลข 3–32 ตัว"
  [ "${#pass}" -ge 10 ] || die "รหัสผ่านต้องยาวอย่างน้อย 10 ตัว"
  stop_service
  printf '%s\n%s\n' "$user" "$pass" | run_as_app "$APP/starter-remote/set-owner.mjs"
  start_service
}

cmd_status() {
  local host; host="$(cat /etc/ai-admin/host 2>/dev/null || echo '?')"
  say "เว็บ:        https://$host/console"
  say "Webhook:    https://$host/webhooks/line"
  say "บริการ:      $(systemctl is-active ai-admin || true) · HTTPS: $(systemctl is-active caddy || true)"
  say "เวอร์ชัน:    $(basename "$(readlink "$APP")")"
  for k in OPENAI_API_KEY LINE_CHANNEL_SECRET LINE_CHANNEL_ACCESS_TOKEN; do
    if [ "$k" = LINE_CHANNEL_SECRET ] && [ -n "$(env_get LINE_SANDBOX)" ]; then say "$k: ยังไม่ใส่ (ตอนนี้เป็นโหมดทดลอง)"
    elif [ -n "$(env_get "$k")" ]; then say "$k: ใส่แล้ว"; else say "$k: ยังไม่ใส่"; fi
  done
  say "ส่ง LINE จริง: $(env_get LINE_LIVE_SEND)"
  say "ชื่อ AI:     $(env_get BRAND_AGENT_NAME) · ร้าน: $(env_get BRAND_BUSINESS_NAME)"
  say "health:     $(curl -fsS -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s);const c=h.components||{};console.log((h.ok?"ok":"ไม่ ok")+" · "+Object.entries(c).map(([k,v])=>k+"="+(typeof v==="object"?(v.status??v.ok??"?"):v)).join(" "))}catch{console.log("อ่านไม่ได้")}})' || echo 'ติดต่อไม่ได้')"
}

cmd_import() { # import <pack.tar.gz> [--apply]
  local tarball="$1" mode="${2:-}" dir line key
  [ -f "$tarball" ] || die "ไม่พบไฟล์ข้อมูลร้าน"
  dir="$(mktemp -d /tmp/ai-admin-pack.XXXX)"; CLEANUP_DIR="$dir"
  tar -xzf "$tarball" -C "$dir"; chown -R aiadmin:aiadmin "$dir"
  local args=(--pack "$dir" --db "$DATA/chassis.sqlite" --image-dir "$DATA/img"
              --public-base "https://$(cat /etc/ai-admin/host)" --persona-out "$DATA/persona.md"
              --catalog-out "$DATA/image-catalog.json" --env-out "$dir/brand.env")
  if [ "$mode" != "--apply" ]; then
    run_as_app tools/starter-import.mjs "${args[@]}"
    return
  fi
  cmd_backup quiet
  stop_service
  run_as_app tools/starter-import.mjs "${args[@]}" --apply || die "นำเข้าไม่สำเร็จ — ระบบเปิดกลับด้วยข้อมูลเดิม"
  if [ -f "$dir/brand.env" ]; then
    while IFS= read -r line; do
      key="${line%%=*}"
      if [[ "$key" =~ $ALLOWED ]]; then env_put "$key" "${line#*=}"; fi
    done < <(grep -E '^[A-Z_]+=' "$dir/brand.env" || true)
  fi
  start_service
  say "✅ นำข้อมูลร้านเข้าแล้ว ระบบเปิดใหม่เรียบร้อย"
}

cmd_harness() { # harness <cases.json> [--only ชื่อ] — จำลองแชทเป็นชุดบนสำเนาฐานข้อมูล ไม่ส่งอะไรออก LINE
  local cases="$1"; shift || true
  [ -f "$cases" ] || die "ไม่พบไฟล์เคส"
  local out="$DATA/harness/$(date +%Y%m%d-%H%M%S)"
  install -d -m 750 -o aiadmin -g aiadmin "$DATA/harness" "$out"
  install -m 640 -o aiadmin -g aiadmin "$cases" "$out/cases.json"
  local rc=0
  run_as_app "$APP/starter-remote/harness.mjs" "$out/cases.json" --out "$out" "$@" || rc=$?
  rm -rf "$out/data" # สำเนาฐานข้อมูลมีข้อมูลลูกค้า — ไม่เก็บค้างไว้
  ls -1dt "$DATA"/harness/*/ 2>/dev/null | tail -n +21 | xargs -r rm -rf
  say "HARNESS_OUT=$out"
  return "$rc"
}

cmd_chat() { run_as_app "$APP/starter-remote/try-chat.mjs" "$@"; }

cmd_line() { run_as_app "$APP/starter-remote/line-setup.mjs" "$@"; }

cmd_golive() {
  case "${1:-}" in
    on)
      [ -n "$(env_get LINE_CHANNEL_ACCESS_TOKEN)" ] || die "ยังไม่ได้ใส่ LINE Channel access token"
      [ -z "$(env_get LINE_SANDBOX)" ] || die "ยังไม่ได้ใส่ LINE Channel secret ของจริง"
      [ -n "$(env_get OPENAI_API_KEY)" ] || die "ยังไม่ได้ใส่ OpenAI API key"
      stop_service
      run_as_app "$APP/starter-remote/purge-test-chats.mjs" # ห้องลองแชทไม่ใช่ลูกค้าจริง
      env_put LINE_LIVE_SEND true
      start_service ;;
    off)
      env_put LINE_LIVE_SEND false
      systemctl restart ai-admin; wait_health ;;
    *) die "ใช้ golive on หรือ golive off" ;;
  esac
  say "✅ ส่ง LINE จริง = $(env_get LINE_LIVE_SEND)"
}

cmd_backup() { # สำเนาฐานข้อมูลแบบปลอดภัย (ขณะระบบเปิดอยู่ได้) — ไฟล์อ่านได้เฉพาะ root/ระบบ
  if [ ! -f "$DATA/chassis.sqlite" ]; then
    if [ "${1:-}" = quiet ]; then return 0; fi
    die "ยังไม่มีฐานข้อมูล"
  fi
  local out; out="$DATA/backups/chassis-$(date +%Y%m%d-%H%M%S).sqlite"
  run_as_app -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare("VACUUM INTO ?").run(process.argv[2]);
    db.close();' "$DATA/chassis.sqlite" "$out"
  chmod 600 "$out"
  ls -1t "$DATA"/backups/chassis-*.sqlite 2>/dev/null | tail -n +15 | xargs -r rm -f
  if [ "${1:-}" != quiet ]; then say "$out"; fi
}

cmd_rollback() {
  [ -L "$BASE/previous" ] || die "ไม่มีเวอร์ชันก่อนหน้าให้ถอย"
  ln -sfn "$(readlink "$BASE/previous")" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
  systemctl restart ai-admin; wait_health; say "✅ ถอยกลับเป็น $(basename "$(readlink "$BASE/current")")"
}

case "${1:-status}" in
  set-env) cmd_set_env ;;
  check-openai) cmd_check_openai ;;
  set-owner) cmd_set_owner ;;
  status) cmd_status ;;
  logs) journalctl -u ai-admin -n "${2:-80}" --no-pager ;;
  restart) systemctl restart ai-admin; wait_health; say "✅ เปิดใหม่แล้ว" ;;
  import) shift; cmd_import "$@" ;;
  chat) shift; cmd_chat "$@" ;;
  harness) shift; cmd_harness "$@" ;;
  line) shift; cmd_line "$@" ;;
  golive) shift; cmd_golive "$@" ;;
  backup) cmd_backup ;;
  rollback) cmd_rollback ;;
  *) die "ไม่รู้จักคำสั่ง $1" ;;
esac
