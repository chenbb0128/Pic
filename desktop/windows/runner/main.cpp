#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>
#include <ole2.h>

#include "flutter_window.h"
#include "utils.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  const HRESULT ole_status = ::OleInitialize(nullptr);
  if (FAILED(ole_status)) return EXIT_FAILURE;
  // JSON snapshots are intentionally single-writer in this MVP.
  const HANDLE instance_mutex = ::CreateMutexW(
      nullptr, FALSE, L"Local\\XiaoxingtieOrderMaterials");
  if (instance_mutex == nullptr || ::GetLastError() == ERROR_ALREADY_EXISTS) {
    if (instance_mutex != nullptr) ::CloseHandle(instance_mutex);
    ::MessageBoxW(nullptr, L"The order materials app is already running.",
                  L"Order Materials", MB_OK | MB_ICONINFORMATION);
    ::OleUninitialize();
    return EXIT_FAILURE;
  }

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1080, 780);
  if (!window.Create(L"Order Materials", origin, size)) {
    ::CloseHandle(instance_mutex);
    ::OleUninitialize();
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  window.Destroy();
  ::CloseHandle(instance_mutex);
  ::OleUninitialize();
  return EXIT_SUCCESS;
}
