#include "virtual_file_reader.h"

#include <shlobj.h>
#include <ole2.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace {
constexpr uint64_t kMaximumBytes = 512ULL * 1024 * 1024;

struct Medium {
  STGMEDIUM value{};
  ~Medium() { if (value.tymed != TYMED_NULL) ReleaseStgMedium(&value); }
};

FORMATETC DescriptorFormat() {
  return FORMATETC{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW)),
                   nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
}

bool SafeName(const std::wstring& name) {
  return !name.empty() && name != L"." && name != L".." &&
         name.find_first_of(L"\\/:*?\"<>|") == std::wstring::npos &&
         name.back() != L'.' && name.back() != L' ';
}

bool WriteAll(HANDLE file, const unsigned char* bytes, uint64_t length) {
  while (length > 0) {
    const auto chunk = static_cast<DWORD>((std::min)(length, uint64_t{65536}));
    DWORD written = 0;
    if (!WriteFile(file, bytes, chunk, &written, nullptr) || written == 0) return false;
    bytes += written;
    length -= written;
  }
  return true;
}

std::string CopyContents(IDataObject* data, LONG index,
                         const FILEDESCRIPTORW& descriptor, HANDLE file) {
  const bool has_size = (descriptor.dwFlags & FD_FILESIZE) != 0;
  const uint64_t expected = (static_cast<uint64_t>(descriptor.nFileSizeHigh) << 32) |
                             descriptor.nFileSizeLow;
  if (has_size && expected > kMaximumBytes) return "Virtual file exceeds 512 MB. Download and import it directly.";
  FORMATETC format{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILECONTENTS)),
                   nullptr, DVASPECT_CONTENT, index, TYMED_HGLOBAL | TYMED_ISTREAM};
  Medium medium;
  if (FAILED(data->GetData(&format, &medium.value))) return "EVA did not supply readable virtual-file contents.";
  if (medium.value.tymed == TYMED_HGLOBAL) {
    const uint64_t available = GlobalSize(medium.value.hGlobal);
    const uint64_t size = has_size ? expected : available;
    if (size == 0 || size > available) return "Virtual-file contents were empty or shorter than declared.";
    if (size > kMaximumBytes) return "Virtual file exceeds 512 MB. Download and import it directly.";
    const auto* bytes = static_cast<const unsigned char*>(GlobalLock(medium.value.hGlobal));
    if (bytes == nullptr) return "Cannot access virtual-file memory.";
    const bool written = WriteAll(file, bytes, size);
    GlobalUnlock(medium.value.hGlobal);
    return written ? "" : "Cannot save the received virtual file.";
  }
  if (medium.value.tymed != TYMED_ISTREAM || medium.value.pstm == nullptr) {
    return "EVA supplied an unsupported file-content medium.";
  }
  std::array<unsigned char, 65536> buffer{};
  uint64_t total = 0;
  while (!has_size || total < expected) {
    const auto request = static_cast<ULONG>(has_size
        ? (std::min)(expected - total, static_cast<uint64_t>(buffer.size()))
        : buffer.size());
    ULONG received = 0;
    const HRESULT status = medium.value.pstm->Read(buffer.data(), request, &received);
    if (FAILED(status) || received > request) return "Cannot read the virtual-file stream.";
    if (total + received > kMaximumBytes) return "Virtual file exceeds 512 MB. Download and import it directly.";
    if (received > 0 && !WriteAll(file, buffer.data(), received)) return "Cannot save the received virtual file.";
    total += received;
    if (received == 0 || status == S_FALSE) break;
  }
  if (total == 0 || (has_size && total != expected)) return "Virtual-file stream was empty or shorter than declared.";
  return "";
}
}  // namespace

bool HasVirtualFiles(IDataObject* data) {
  auto descriptor = DescriptorFormat();
  return SUCCEEDED(data->QueryGetData(&descriptor));
}

ReceivedVirtualFiles ReadVirtualFiles(IDataObject* data,
                                     const std::wstring& destination_root) {
  ReceivedVirtualFiles result;
  auto format = DescriptorFormat();
  Medium medium;
  if (FAILED(data->GetData(&format, &medium.value)) || medium.value.tymed != TYMED_HGLOBAL) {
    result.error = "Cannot read the virtual-file descriptor.";
    return result;
  }
  const SIZE_T allocation = GlobalSize(medium.value.hGlobal);
  const auto* group = static_cast<const FILEGROUPDESCRIPTORW*>(GlobalLock(medium.value.hGlobal));
  if (group == nullptr) {
    result.error = "Cannot access the virtual-file descriptor.";
    return result;
  }
  std::vector<FILEDESCRIPTORW> descriptors;
  const auto offset = offsetof(FILEGROUPDESCRIPTORW, fgd);
  if (allocation < offset || group->cItems == 0 || group->cItems > 128 ||
      group->cItems > (allocation - offset) / sizeof(FILEDESCRIPTORW)) {
    result.error = "Invalid virtual-file descriptor count.";
  } else {
    for (UINT i = 0; i < group->cItems; ++i) {
      const auto& descriptor = group->fgd[i];
      const auto length = wcsnlen(descriptor.cFileName, MAX_PATH);
      if (length >= MAX_PATH || !SafeName(std::wstring(descriptor.cFileName, length)) ||
          ((descriptor.dwFlags & FD_ATTRIBUTES) != 0 &&
           (descriptor.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0)) {
        result.error = "Invalid virtual-file name. Download and import the original file instead.";
        break;
      }
      descriptors.push_back(descriptor);
    }
  }
  GlobalUnlock(medium.value.hGlobal);
  if (!result.error.empty()) return result;

  const int root_status = SHCreateDirectoryExW(nullptr, destination_root.c_str(), nullptr);
  if (root_status != ERROR_SUCCESS && root_status != ERROR_ALREADY_EXISTS) {
    result.error = "Cannot create the incoming-files directory.";
    return result;
  }
  GUID identifier{};
  wchar_t identifier_text[40]{};
  if (FAILED(CoCreateGuid(&identifier)) || StringFromGUID2(identifier, identifier_text, 40) == 0) {
    result.error = "Cannot create a unique incoming-file identifier.";
    return result;
  }
  const auto session = destination_root + L"\\" + identifier_text;
  if (!CreateDirectoryW(session.c_str(), nullptr)) {
    result.error = "Cannot create an incoming-file directory.";
    return result;
  }
  for (size_t i = 0; i < descriptors.size(); ++i) {
    const auto directory = session + L"\\" + std::to_wstring(i);
    if (!CreateDirectoryW(directory.c_str(), nullptr)) {
      result.error = "Cannot create an incoming-file directory.";
      break;
    }
    const auto path = directory + L"\\" + descriptors[i].cFileName;
    const auto partial = path + L".partial";
    const HANDLE file = CreateFileW(partial.c_str(), GENERIC_WRITE, 0, nullptr,
                                     CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
      result.error = "Cannot create the received image file.";
    } else {
      result.error = CopyContents(data, static_cast<LONG>(i), descriptors[i], file);
      if (result.error.empty() && !FlushFileBuffers(file)) result.error = "Cannot flush the received image file.";
      CloseHandle(file);
      if (result.error.empty() && !MoveFileW(partial.c_str(), path.c_str())) {
        result.error = "Cannot finalize the received image file.";
      }
    }
    if (!result.error.empty()) {
      // Remove only our incomplete transfer; complete earlier files stay in
      // incoming/ for recovery when a later file in the same drop fails.
      DeleteFileW(partial.c_str());
      RemoveDirectoryW(directory.c_str());
      break;
    }
    result.paths.push_back(path);
  }
  if (!result.error.empty()) RemoveDirectoryW(session.c_str());
  return result;
}
