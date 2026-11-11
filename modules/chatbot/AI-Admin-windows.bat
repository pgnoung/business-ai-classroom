@echo off
rem ดับเบิลคลิกเพื่อเปิดหน้าต่างคำสั่งของ AI Admin Starter (Windows)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ai-admin.ps1 check
echo.
echo พิมพ์คำสั่งต่อได้เลย เช่น  powershell -ExecutionPolicy Bypass -File ai-admin.ps1 secrets
cmd /k
