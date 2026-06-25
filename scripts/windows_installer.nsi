!include "MUI2.nsh"

; 定义版本号（由 CI 自动更新）
!define APP_NAME "better-douyin"
!define APP_VERSION "1.0.29"
!define APP_PUBLISHER "anYuJia"
!define APP_EXE "better-douyin.exe"
!define APP_GUID "E4F9A7B3-8C2D-4F1E-9A5B-3C7D2E8F1A6B"

; 安装程序信息
Name "${APP_NAME}"
OutFile "..\dist\better-douyin-Setup-v${APP_VERSION}.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "Software\${APP_NAME}" "Install_Dir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

; 页面
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; 语言
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; 安装
Section "Install" SecInstall
    SectionIn RO

    ; 设置输出路径
    SetOutPath "$INSTDIR"

    ; 删除旧文件
    RMDir /r "$INSTDIR\*.*"

    ; 复制整个程序文件夹（文件夹模式）
    ; 脚本在 scripts/ 目录，需要用 ..\dist\ 来引用
    File /r "..\dist\better-douyin\*.*"

    ; 创建卸载程序
    WriteUninstaller "$INSTDIR\Uninstall.exe"

    ; 注册表项
    WriteRegStr HKLM "Software\${APP_NAME}" "Install_Dir" "$INSTDIR"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "Publisher" "${APP_PUBLISHER}"

    ; 创建开始菜单快捷方式
    CreateDirectory "$SMPROGRAMS\${APP_NAME}"
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载.lnk" "$INSTDIR\Uninstall.exe"

    ; 创建桌面快捷方式
    CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
SectionEnd

; 卸载
Section "Uninstall"
    ; 删除文件
    RMDir /r "$INSTDIR"

    ; 删除快捷方式
    Delete "$SMPROGRAMS\${APP_NAME}\*.*"
    RMDir "$SMPROGRAMS\${APP_NAME}"
    Delete "$DESKTOP\${APP_NAME}.lnk"

    ; 删除注册表项
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
    DeleteRegKey HKLM "Software\${APP_NAME}"
SectionEnd
