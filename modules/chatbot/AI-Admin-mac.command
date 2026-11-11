#!/bin/bash
# ดับเบิลคลิกเพื่อเปิดหน้าต่างคำสั่งของ AI Admin Starter (macOS)
cd "$(dirname "$0")" || exit 1
bash ai-admin.sh check
echo ""
echo "พิมพ์คำสั่งต่อได้เลย เช่น  bash ai-admin.sh secrets"
exec "$SHELL" -l
