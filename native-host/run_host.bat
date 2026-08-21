@echo off
REM PATH에 있는 "python"에 의존하면 환경에 따라(특히 Chrome이 이 프로세스를 띄울 때는
REM PATH 우선순위가 달라져서) Microsoft Store 앱 실행 별칭 등 엉뚱한 python.exe로 풀릴 수 있어
REM 절대경로를 직접 지정한다. 이 PC의 실제 Python 설치 경로에 맞게 필요하면 바꿀 것.
"C:\Python314\python.exe" "%~dp0host_native.py"
