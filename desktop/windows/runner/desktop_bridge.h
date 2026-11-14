#ifndef RUNNER_DESKTOP_BRIDGE_H_
#define RUNNER_DESKTOP_BRIDGE_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <windows.h>
#include <oleidl.h>

#include <memory>

class DesktopBridge {
 public:
  DesktopBridge(HWND owner, HWND view, flutter::BinaryMessenger* messenger);
  ~DesktopBridge();
  DesktopBridge(const DesktopBridge&) = delete;
  DesktopBridge& operator=(const DesktopBridge&) = delete;

 private:
  class FileDropTarget;
  HWND owner_;
  HWND view_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  FileDropTarget* drop_target_ = nullptr;
  bool drop_registered_ = false;
};

#endif  // RUNNER_DESKTOP_BRIDGE_H_
