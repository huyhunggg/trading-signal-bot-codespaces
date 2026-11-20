@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
where node >nul 2>&1
if errorlevel 1 (
    echo Cai Node.js 24 LTS tai https://nodejs.org/en/download, sau do mo lai file nay.
    pause
    popd
    exit /b 1
)
node scripts\local-binance.js
set "BOT_RESULT=%errorlevel%"
if not "%BOT_RESULT%"=="0" pause
popd
exit /b %BOT_RESULT%
