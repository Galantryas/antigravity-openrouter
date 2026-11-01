@echo off
rem Launches Antigravity IDE with the Antigravity OpenRouter extension loaded from this folder.
rem Use this until the extension is installed from the .vsix.
start "" "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe" --extensionDevelopmentPath="%~dp0"
