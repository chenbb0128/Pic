#include <windows.h>
#include <ole2.h>
#include <shlobj.h>

#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

#include "virtual_file_reader.h"

namespace {
// The last bytes matter: a padded HGLOBAL must not add bytes to the photo.
const std::vector<unsigned char> kBytes = []() {
  std::vector<unsigned char> bytes(257);
  for (size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<unsigned char>(i % 251);
  return bytes;
}();

class VirtualDataObject : public IDataObject {
 public:
  bool stream = false;
  bool truncate = false;
  bool broken_descriptor = false;
  std::wstring filename = L"\u5ba2\u6237\u539f\u56fe.png";

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (iid == IID_IUnknown || iid == IID_IDataObject) {
      *value = static_cast<IDataObject*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE GetData(FORMATETC* format, STGMEDIUM* medium) override {
    *medium = STGMEDIUM{};
    const auto descriptor = RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW);
    const auto contents = RegisterClipboardFormatW(CFSTR_FILECONTENTS);
    if (format->cfFormat == descriptor) {
      medium->tymed = TYMED_HGLOBAL;
      medium->hGlobal = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(FILEGROUPDESCRIPTORW));
      auto* group = static_cast<FILEGROUPDESCRIPTORW*>(GlobalLock(medium->hGlobal));
      group->cItems = broken_descriptor ? 999 : 1;
      group->fgd[0].dwFlags = FD_FILESIZE | FD_ATTRIBUTES;
      group->fgd[0].dwFileAttributes = FILE_ATTRIBUTE_NORMAL;
      group->fgd[0].nFileSizeLow = static_cast<DWORD>(kBytes.size());
      wcscpy_s(group->fgd[0].cFileName, filename.c_str());
      GlobalUnlock(medium->hGlobal);
      return S_OK;
    }
    if (format->cfFormat != contents || format->lindex != 0) return DV_E_FORMATETC;
    const auto length = truncate ? kBytes.size() - 1 : kBytes.size();
    if (stream) {
      if ((format->tymed & TYMED_ISTREAM) == 0) return DV_E_TYMED;
      IStream* output = nullptr;
      const HRESULT result = CreateStreamOnHGlobal(nullptr, TRUE, &output);
      if (FAILED(result)) return result;
      ULONG written = 0;
      output->Write(kBytes.data(), static_cast<ULONG>(length), &written);
      LARGE_INTEGER start{};
      output->Seek(start, STREAM_SEEK_SET, nullptr);
      medium->tymed = TYMED_ISTREAM;
      medium->pstm = output;
    } else {
      if ((format->tymed & TYMED_HGLOBAL) == 0) return DV_E_TYMED;
      // Truncated data is shorter than its declared size. Normal allocations
      // deliberately include extra padding, which must never reach the file.
      const auto allocation = truncate ? size_t{1} : length + 32;
      medium->tymed = TYMED_HGLOBAL;
      medium->hGlobal = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, allocation);
      auto* bytes = GlobalLock(medium->hGlobal);
      std::memcpy(bytes, kBytes.data(), truncate ? size_t{1} : length);
      GlobalUnlock(medium->hGlobal);
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* format) override {
    if (format->cfFormat == RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW)) return S_OK;
    if (format->cfFormat == RegisterClipboardFormatW(CFSTR_FILECONTENTS)) return S_OK;
    return DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD, IEnumFORMATETC**) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) override { return OLE_E_ADVISENOTSUPPORTED; }
};

std::wstring Parent(const std::wstring& path) { return path.substr(0, path.find_last_of(L"\\/")); }

bool Preserved(const ReceivedVirtualFiles& result, const std::wstring& root) {
  if (!result.error.empty() || result.paths.size() != 1) return false;
  const auto& path = result.paths[0];
  if (path.rfind(root + L"\\", 0) != 0) return false;
  if (path.substr(path.find_last_of(L"\\/") + 1) != L"\u5ba2\u6237\u539f\u56fe.png") return false;
  std::ifstream file(path, std::ios::binary);
  std::vector<unsigned char> actual(std::istreambuf_iterator<char>(file), {});
  const bool equal = actual == kBytes;
  // Only exact files produced by this test and their empty parent directories.
  DeleteFileW(path.c_str());
  RemoveDirectoryW(Parent(path).c_str());
  RemoveDirectoryW(Parent(Parent(path)).c_str());
  return equal;
}
}  // namespace

int main() {
  if (FAILED(OleInitialize(nullptr))) return 2;
  wchar_t temp[MAX_PATH]{};
  if (GetTempPathW(MAX_PATH, temp) == 0) return 2;
  const std::wstring root = std::wstring(temp) + L"pic-virtual-test-" + std::to_wstring(GetCurrentProcessId());
  CreateDirectoryW(root.c_str(), nullptr);
  int failures = 0;
  auto check = [&](bool condition, const char* name) {
    std::cout << (condition ? "PASS " : "FAIL ") << name << '\n';
    if (!condition) ++failures;
  };
  VirtualDataObject data;
  check(HasVirtualFiles(&data), "virtual-file capability");
  check(Preserved(ReadVirtualFiles(&data, root), root), "HGLOBAL exact bytes and Unicode filename");
  data.stream = true;
  check(Preserved(ReadVirtualFiles(&data, root), root), "IStream exact bytes");
  data.truncate = true;
  check(!ReadVirtualFiles(&data, root).error.empty(), "truncated stream rejected");
  data.stream = false;
  check(!ReadVirtualFiles(&data, root).error.empty(), "truncated HGLOBAL rejected");
  data.truncate = false;
  data.filename = L"..\\escape.png";
  check(!ReadVirtualFiles(&data, root).error.empty(), "path traversal rejected");
  data.filename = L"photo.png";
  data.broken_descriptor = true;
  check(!ReadVirtualFiles(&data, root).error.empty(), "out-of-bounds descriptor rejected");
  RemoveDirectoryW(root.c_str());
  OleUninitialize();
  return failures == 0 ? 0 : 1;
}
