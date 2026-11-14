#include "desktop_bridge.h"

#include <flutter/standard_method_codec.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <string>
#include <map>
#include <utility>
#include <vector>

#include "utils.h"
#include "virtual_file_reader.h"

namespace {
using Value = flutter::EncodableValue;
using Result = flutter::MethodResult<Value>;

FORMATETC FileFormat() {
  return FORMATETC{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
}

std::wstring IncomingDirectory() {
  const DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", nullptr, 0);
  if (length == 0 || length > 32768) return L"";
  std::vector<wchar_t> local(length);
  if (GetEnvironmentVariableW(L"LOCALAPPDATA", local.data(), length) == 0) return L"";
  return std::wstring(local.data()) + L"\\Xiaoxingtie\\OrderMaterials\\incoming";
}

std::wstring ParentDirectory(const std::wstring& path) {
  return path.substr(0, path.find_last_of(L"\\/"));
}

std::string ReadImageLink(IDataObject* data) {
  const CLIPFORMAT formats[] = {
      static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"UniformResourceLocatorW")),
      CF_UNICODETEXT,
      static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"UniformResourceLocator"))};
  for (size_t i = 0; i < 3; ++i) {
    FORMATETC format{formats[i], nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    STGMEDIUM medium{};
    if (FAILED(data->GetData(&format, &medium))) continue;
    std::string text;
    if (medium.tymed == TYMED_HGLOBAL) {
      const SIZE_T length = GlobalSize(medium.hGlobal);
      if (length > 0 && length <= 256 * 1024) {
        const auto* bytes = GlobalLock(medium.hGlobal);
        if (bytes != nullptr) {
          if (i < 2) {
            const auto* wide = static_cast<const wchar_t*>(bytes);
            const size_t characters = length / sizeof(wchar_t);
            const auto used = wcsnlen(wide, characters);
            if (used < characters) text = Utf8FromUtf16(wide);
          } else {
            const auto* narrow = static_cast<const char*>(bytes);
            const auto used = strnlen(narrow, length);
            if (used < length) text.assign(narrow, used);
          }
          GlobalUnlock(medium.hGlobal);
        }
      }
    }
    ReleaseStgMedium(&medium);
    if (text.rfind("https://", 0) == 0 && text.find_first_of("\r\n") == std::string::npos) {
      return text;
    }
  }
  return "";
}

std::string FormatName(CLIPFORMAT format) {
  switch (format) {
    case CF_TEXT: return "CF_TEXT";
    case CF_BITMAP: return "CF_BITMAP";
    case CF_DIB: return "CF_DIB";
    case CF_DIBV5: return "CF_DIBV5";
    case CF_UNICODETEXT: return "CF_UNICODETEXT";
    case CF_HDROP: return "CF_HDROP";
    default: {
      wchar_t name[256]{};
      if (GetClipboardFormatNameW(format, name, 256) > 0) {
        return Utf8FromUtf16(name);
      }
      return "format_" + std::to_string(format);
    }
  }
}

Value DescribeFormats(IDataObject* data, HRESULT file_query, DWORD effects) {
  flutter::EncodableList formats;
  IEnumFORMATETC* enumerator = nullptr;
  const HRESULT enumeration = data->EnumFormatEtc(DATADIR_GET, &enumerator);
  if (SUCCEEDED(enumeration) && enumerator != nullptr) {
    FORMATETC format{};
    // Diagnostic metadata only: do not request image bytes, HTML, or URLs.
    for (int i = 0; i < 64 && enumerator->Next(1, &format, nullptr) == S_OK; ++i) {
      formats.emplace_back(flutter::EncodableMap{
          {Value("id"), Value(static_cast<int32_t>(format.cfFormat))},
          {Value("name"), Value(FormatName(format.cfFormat))},
          {Value("tymed"), Value(static_cast<int64_t>(format.tymed))},
          {Value("index"), Value(static_cast<int32_t>(format.lindex))}});
      CoTaskMemFree(format.ptd);
      format = FORMATETC{};
    }
    enumerator->Release();
  }
  return Value(flutter::EncodableMap{
      {Value("formats"), Value(formats)},
      {Value("fileQueryResult"), Value(static_cast<int32_t>(file_query))},
      {Value("enumerationResult"), Value(static_cast<int32_t>(enumeration))},
      {Value("allowedEffects"), Value(static_cast<int64_t>(effects))}});
}

std::wstring Utf16FromUtf8(const std::string& text) {
  if (text.empty() || text.find('\0') != std::string::npos) return L"";
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
      text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (length == 0) return L"";
  std::wstring wide(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                         static_cast<int>(text.size()), wide.data(), length) == 0) {
    return L"";
  }
  return wide;
}

std::wstring FullPath(const std::wstring& path) {
  const DWORD length = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
  if (length == 0) return L"";
  std::wstring full(length, L'\0');
  const DWORD written = GetFullPathNameW(path.c_str(), length, full.data(), nullptr);
  if (written == 0 || written >= length) return L"";
  full.resize(written);
  return full;
}

std::wstring SourceImagePath(const std::string& source) {
  const auto path = Utf16FromUtf8(source);
  if (path.empty()) return L"";
  const auto full = FullPath(path);
  const DWORD attributes = GetFileAttributesW(full.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    return L"";
  }
  return full;
}

std::wstring ExportName(const std::wstring& source, const std::string& suggested) {
  auto name = Utf16FromUtf8(suggested);
  const auto separator = name.find_last_of(L"\\/");
  if (separator != std::wstring::npos) name.erase(0, separator + 1);
  const auto dot = name.find_last_of(L'.');
  if (dot != std::wstring::npos) name.resize(dot);
  for (auto& character : name) {
    if (character < 32 || std::wstring(L"<>:\"/\\|?*").find(character) != std::wstring::npos) {
      character = L'_';
    }
  }
  if (name.size() > 120) name.resize(120);
  if (!name.empty() && name.back() >= 0xD800 && name.back() <= 0xDBFF) name.pop_back();
  while (!name.empty() && (name.back() == L'.' || name.back() == L' ')) name.pop_back();
  if (name.empty()) name = L"image";
  // Keep the extension of the actual saved file; no format conversion occurs.
  const auto source_dot = source.find_last_of(L'.');
  return name + source.substr(source_dot);
}

void SaveImageAs(HWND owner, const std::string& source_path,
                 const std::string& suggested_name, std::unique_ptr<Result> result) {
  const auto source = SourceImagePath(source_path);
  if (source.empty()) {
    result->Error("image_unavailable", "The saved image is missing or unavailable.");
    return;
  }
  IFileSaveDialog* dialog = nullptr;
  HRESULT status = CoCreateInstance(CLSID_FileSaveDialog, nullptr,
      CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog));
  if (FAILED(status)) {
    result->Error("dialog_unavailable", "Cannot create the Windows save dialog.");
    return;
  }
  DWORD options = 0;
  status = dialog->GetOptions(&options);
  if (SUCCEEDED(status)) {
    status = dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT |
                               FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
  }
  const auto name = ExportName(source, suggested_name);
  const auto extension = source.substr(source.find_last_of(L'.') + 1);
  const auto pattern = L"*." + extension;
  const COMDLG_FILTERSPEC filters[] = {{L"Image", pattern.c_str()}};
  if (SUCCEEDED(status)) status = dialog->SetFileTypes(1, filters);
  if (SUCCEEDED(status)) status = dialog->SetDefaultExtension(extension.c_str());
  if (SUCCEEDED(status)) status = dialog->SetFileName(name.c_str());
  if (SUCCEEDED(status)) status = dialog->Show(owner);
  if (status == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
    dialog->Release();
    result->Success();
    return;
  }
  IShellItem* item = nullptr;
  if (SUCCEEDED(status)) status = dialog->GetResult(&item);
  std::wstring destination;
  if (SUCCEEDED(status)) {
    PWSTR path = nullptr;
    status = item->GetDisplayName(SIGDN_FILESYSPATH, &path);
    if (SUCCEEDED(status)) destination = path;
    CoTaskMemFree(path);
  }
  if (item != nullptr) item->Release();
  dialog->Release();
  if (FAILED(status)) {
    result->Error("dialog_failed", "Cannot read the selected save path.");
    return;
  }
  const auto target = FullPath(destination);
  // Saving to the original location must never truncate or replace that file.
  if (_wcsicmp(source.c_str(), target.c_str()) != 0 &&
      !CopyFileW(source.c_str(), destination.c_str(), FALSE)) {
    result->Error("save_failed", "Cannot copy the original image to the selected path.",
                  Value(static_cast<int64_t>(GetLastError())));
    return;
  }
  result->Success(Value(Utf8FromUtf16(destination.c_str())));
}

void DragImageFile(HWND owner, HWND view, const std::string& source_path,
                   std::unique_ptr<Result> result) {
  const auto source = SourceImagePath(source_path);
  if (source.empty()) {
    result->Error("image_unavailable", "The saved image is missing or unavailable.");
    return;
  }
  if ((GetKeyState(VK_LBUTTON) & 0x8000) == 0) {
    result->Success(Value(false));
    return;
  }
  PIDLIST_ABSOLUTE id = nullptr;
  HRESULT status = SHParseDisplayName(source.c_str(), nullptr, &id, 0, nullptr);
  IShellItemArray* items = nullptr;
  if (SUCCEEDED(status)) {
    PCIDLIST_ABSOLUTE ids[] = {id};
    status = SHCreateShellItemArrayFromIDLists(1, ids, &items);
  }
  IDataObject* data = nullptr;
  if (SUCCEEDED(status)) {
    status = items->BindToHandler(nullptr, BHID_DataObject, IID_PPV_ARGS(&data));
  }
  if (items != nullptr) items->Release();
  CoTaskMemFree(id);
  DWORD effect = DROPEFFECT_NONE;
  if (SUCCEEDED(status)) {
    // The Shell supplies the file data object and drag source for browsers and
    // Explorer. Only copy is offered; the library file is never moved/deleted.
    status = SHDoDragDrop(owner, data, nullptr, DROPEFFECT_COPY, &effect);
  }
  if (data != nullptr) data->Release();
  // OLE consumes mouse-up outside our window. Finish Flutter's pointer gesture
  // too, so the next click/drag is not left in a pressed state.
  POINT cursor{};
  if (GetCursorPos(&cursor) && ScreenToClient(view, &cursor)) {
    PostMessageW(view, WM_LBUTTONUP, 0, MAKELPARAM(cursor.x, cursor.y));
  }
  if (FAILED(status)) {
    result->Error("drag_failed", "Cannot start the Windows file drag.",
                  Value(static_cast<int64_t>(status)));
  } else {
    result->Success(Value(status == DRAGDROP_S_DROP && (effect & DROPEFFECT_COPY) != 0));
  }
}

void ChooseDirectory(HWND owner, std::unique_ptr<Result> result) {
  IFileOpenDialog* dialog = nullptr;
  HRESULT status = CoCreateInstance(CLSID_FileOpenDialog, nullptr,
      CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog));
  if (FAILED(status)) {
    result->Error("dialog_unavailable", "Cannot create the Windows folder dialog.");
    return;
  }
  DWORD options = 0;
  status = dialog->GetOptions(&options);
  if (SUCCEEDED(status)) {
    status = dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM |
                               FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
  }
  if (SUCCEEDED(status)) status = dialog->Show(owner);
  if (status == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
    dialog->Release();
    result->Success();
    return;
  }
  IShellItem* item = nullptr;
  if (SUCCEEDED(status)) status = dialog->GetResult(&item);
  std::string selected;
  if (SUCCEEDED(status)) {
    PWSTR path = nullptr;
    status = item->GetDisplayName(SIGDN_FILESYSPATH, &path);
    if (SUCCEEDED(status)) selected = Utf8FromUtf16(path);
    CoTaskMemFree(path);
  }
  if (item != nullptr) item->Release();
  dialog->Release();
  if (FAILED(status)) {
    result->Error("dialog_failed", "Cannot read the selected folder path.");
  } else {
    result->Success(Value(selected));
  }
}

void ChooseImages(HWND owner, std::unique_ptr<Result> result) {
  IFileOpenDialog* dialog = nullptr;
  HRESULT status = CoCreateInstance(CLSID_FileOpenDialog, nullptr,
      CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog));
  if (FAILED(status)) {
    result->Error("dialog_unavailable", "Cannot create the Windows file dialog.");
    return;
  }
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_ALLOWMULTISELECT | FOS_FORCEFILESYSTEM |
                     FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
  const COMDLG_FILTERSPEC filters[] = {
      {L"Images", L"*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp"}};
  dialog->SetFileTypes(1, filters);
  status = dialog->Show(owner);
  if (status == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
    dialog->Release();
    result->Success(Value(flutter::EncodableList{}));
    return;
  }
  IShellItemArray* items = nullptr;
  if (SUCCEEDED(status)) status = dialog->GetResults(&items);
  flutter::EncodableList paths;
  if (SUCCEEDED(status)) {
    DWORD count = 0;
    status = items->GetCount(&count);
    for (DWORD i = 0; SUCCEEDED(status) && i < count; ++i) {
      IShellItem* item = nullptr;
      status = items->GetItemAt(i, &item);
      if (SUCCEEDED(status)) {
        PWSTR path = nullptr;
        status = item->GetDisplayName(SIGDN_FILESYSPATH, &path);
        if (SUCCEEDED(status)) {
          paths.emplace_back(Utf8FromUtf16(path));
          CoTaskMemFree(path);
        }
        item->Release();
      }
    }
  }
  if (items != nullptr) items->Release();
  dialog->Release();
  if (FAILED(status)) {
    result->Error("dialog_failed", "Cannot read the selected image paths.");
  } else {
    result->Success(Value(paths));
  }
}
}  // namespace

// File paths and Windows virtual files are accepted. HTML, URLs, and bitmaps
// are never substituted for the source file or called confirmed originals.
class DesktopBridge::FileDropTarget : public IDropTarget {
 public:
  explicit FileDropTarget(flutter::MethodChannel<Value>* channel)
      : channel_(channel) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (object == nullptr) return E_POINTER;
    *object = nullptr;
    if (iid == IID_IUnknown || iid == IID_IDropTarget) {
      *object = static_cast<IDropTarget*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references_); }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = InterlockedDecrement(&references_);
    if (remaining == 0) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE DragEnter(IDataObject* data, DWORD, POINTL, DWORD* effect) override {
    if (outgoing_drag_) {
      supported_ = false;
      *effect = DROPEFFECT_NONE;
      return S_OK;
    }
    auto format = FileFormat();
    const HRESULT query_result = data->QueryGetData(&format);
    channel_->InvokeMethod("dragFormats", std::make_unique<Value>(
        DescribeFormats(data, query_result, *effect)));
    supported_ = SUCCEEDED(query_result) || HasVirtualFiles(data);
    *effect = supported_ ? (*effect & DROPEFFECT_COPY) : DROPEFFECT_NONE;
    if (!supported_) {
      channel_->InvokeMethod("unsupportedDrop", std::make_unique<Value>());
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE DragOver(DWORD, POINTL, DWORD* effect) override {
    *effect = supported_ ? (*effect & DROPEFFECT_COPY) : DROPEFFECT_NONE;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE DragLeave() override {
    supported_ = false;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Drop(IDataObject* data, DWORD, POINTL, DWORD* effect) override {
    const DWORD allowed_effect = *effect;
    *effect = DROPEFFECT_NONE;
    if (outgoing_drag_) return S_OK;
    auto format = FileFormat();
    if ((allowed_effect & DROPEFFECT_COPY) != 0 &&
        FAILED(data->QueryGetData(&format)) && HasVirtualFiles(data)) {
      const auto incoming = IncomingDirectory();
      if (incoming.empty()) {
        channel_->InvokeMethod("dropReadError", std::make_unique<Value>("Cannot locate the incoming-files directory."));
        return S_OK;
      }
      auto received = ReadVirtualFiles(data, incoming);
      if (!received.error.empty()) {
        channel_->InvokeMethod("dropReadError", std::make_unique<Value>(received.error));
        return S_OK;
      }
      flutter::EncodableList paths;
      for (const auto& path : received.paths) {
        const auto utf8 = Utf8FromUtf16(path.c_str());
        pending_virtual_files_[utf8] = path;
        paths.emplace_back(utf8);
      }
      if (!paths.empty()) {
        // Link and transfer path travel in the same message, so concurrent
        // drops cannot attach one customer's URL to another customer's file.
        channel_->InvokeMethod("filesDropped", std::make_unique<Value>(
            flutter::EncodableMap{
              {Value("paths"), Value(paths)},
              {Value("sourceUrl"), Value(paths.size() == 1 ? ReadImageLink(data) : "")},
              {Value("virtualFiles"), Value(true)}}));
        *effect = DROPEFFECT_COPY;
      }
      supported_ = false;
      return S_OK;
    }
    STGMEDIUM medium{};
    if ((allowed_effect & DROPEFFECT_COPY) == 0 || FAILED(data->GetData(&format, &medium))) {
      channel_->InvokeMethod("unsupportedDrop", std::make_unique<Value>());
      return S_OK;
    }
    const auto drop = static_cast<HDROP>(medium.hGlobal);
    const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
    flutter::EncodableList paths;
    for (UINT i = 0; i < count; ++i) {
      const UINT length = DragQueryFileW(drop, i, nullptr, 0);
      std::vector<wchar_t> path(static_cast<size_t>(length) + 1);
      if (DragQueryFileW(drop, i, path.data(), length + 1) != 0) {
        paths.emplace_back(Utf8FromUtf16(path.data()));
      }
    }
    ReleaseStgMedium(&medium);
    if (!paths.empty()) {
      channel_->InvokeMethod("filesDropped", std::make_unique<Value>(paths));
      *effect = DROPEFFECT_COPY;
    }
    supported_ = false;
    return S_OK;
  }

  void ReleaseFiles(const flutter::EncodableList& paths) {
    for (const auto& value : paths) {
      const auto* path = std::get_if<std::string>(&value);
      if (path == nullptr) continue;
      const auto entry = pending_virtual_files_.find(*path);
      // Never delete ordinary user files or paths not created by this bridge.
      if (entry == pending_virtual_files_.end()) continue;
      if (DeleteFileW(entry->second.c_str())) {
        const auto parent = ParentDirectory(entry->second);
        RemoveDirectoryW(parent.c_str());
        RemoveDirectoryW(ParentDirectory(parent).c_str());
        pending_virtual_files_.erase(entry);
      }
    }
  }

  void SetOutgoingDrag(bool active) { outgoing_drag_ = active; }

 private:
  virtual ~FileDropTarget() = default;
  LONG references_ = 1;
  bool supported_ = false;
  bool outgoing_drag_ = false;
  flutter::MethodChannel<Value>* channel_;
  std::map<std::string, std::wstring> pending_virtual_files_;
};

DesktopBridge::DesktopBridge(HWND owner, HWND view, flutter::BinaryMessenger* messenger)
    : owner_(owner), view_(view) {
  channel_ = std::make_unique<flutter::MethodChannel<Value>>(
      messenger, "cn.xiaoxingtie/order_materials/desktop",
      &flutter::StandardMethodCodec::GetInstance());
  drop_target_ = new FileDropTarget(channel_.get());
  drop_registered_ = SUCCEEDED(RegisterDragDrop(view_, drop_target_));
  channel_->SetMethodCallHandler([this](const auto& call, auto result) {
    if (call.method_name() == "chooseImages") {
      ChooseImages(owner_, std::move(result));
    } else if (call.method_name() == "chooseDirectory") {
      ChooseDirectory(owner_, std::move(result));
    } else if (call.method_name() == "openWebTemplate") {
      const auto* address = call.arguments() == nullptr ? nullptr
          : std::get_if<std::string>(call.arguments());
      const std::string prefix = "https://pic.pdurl.cn/tools/heart-star?template=";
      if (address == nullptr || address->rfind(prefix, 0) != 0 ||
          address->find_first_of("\r\n") != std::string::npos) {
        result->Error("invalid_argument", "Expected a web template URL.");
      } else {
        const auto url = Utf16FromUtf8(*address);
        const auto launched = reinterpret_cast<INT_PTR>(
            ShellExecuteW(owner_, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL));
        if (launched <= 32) {
          result->Error("browser_failed", "Cannot open the web editor.");
        } else {
          result->Success();
        }
      }
    } else if (call.method_name() == "saveImageAs") {
      const auto* arguments = call.arguments() == nullptr ? nullptr
          : std::get_if<flutter::EncodableMap>(call.arguments());
      if (arguments == nullptr) {
        result->Error("invalid_argument", "Expected an image path and suggested name.");
        return;
      }
      const auto path = arguments->find(Value("sourcePath"));
      const auto name = arguments->find(Value("suggestedName"));
      const auto* source = path == arguments->end() ? nullptr : std::get_if<std::string>(&path->second);
      const auto* suggested = name == arguments->end() ? nullptr : std::get_if<std::string>(&name->second);
      if (source == nullptr || suggested == nullptr) {
        result->Error("invalid_argument", "Expected an image path and suggested name.");
      } else {
        SaveImageAs(owner_, *source, *suggested, std::move(result));
      }
    } else if (call.method_name() == "dragFile") {
      const auto* source = call.arguments() == nullptr ? nullptr
          : std::get_if<std::string>(call.arguments());
      if (source == nullptr) {
        result->Error("invalid_argument", "Expected an image path.");
      } else {
        drop_target_->SetOutgoingDrag(true);
        DragImageFile(owner_, view_, *source, std::move(result));
        drop_target_->SetOutgoingDrag(false);
      }
    } else if (call.method_name() == "releaseDroppedFiles") {
      const auto* paths = call.arguments() == nullptr ? nullptr
          : std::get_if<flutter::EncodableList>(call.arguments());
      if (paths == nullptr) {
        result->Error("invalid_argument", "Expected file paths.");
      } else {
        drop_target_->ReleaseFiles(*paths);
        result->Success();
      }
    } else if (call.method_name() == "setAlwaysOnTop") {
      const auto* enabled = call.arguments() == nullptr ? nullptr : std::get_if<bool>(call.arguments());
      if (enabled == nullptr) {
        result->Error("invalid_argument", "Expected a boolean.");
      } else if (!SetWindowPos(owner_, *enabled ? HWND_TOPMOST : HWND_NOTOPMOST,
                              0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) {
        result->Error("pin_failed", "Cannot change the window's topmost state.");
      } else {
        result->Success();
      }
    } else {
      result->NotImplemented();
    }
  });
}

DesktopBridge::~DesktopBridge() {
  if (drop_registered_) RevokeDragDrop(view_);
  if (drop_target_ != nullptr) drop_target_->Release();
  channel_->SetMethodCallHandler(nullptr);
}
