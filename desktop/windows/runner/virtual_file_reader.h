#ifndef RUNNER_VIRTUAL_FILE_READER_H_
#define RUNNER_VIRTUAL_FILE_READER_H_

#include <windows.h>
#include <objidl.h>

#include <string>
#include <vector>

struct ReceivedVirtualFiles {
  std::vector<std::wstring> paths;
  std::string error;
};

bool HasVirtualFiles(IDataObject* data);

// destination_root is an application-owned incoming directory. The caller
// acknowledges/removes staged files only after the order repository saved them.
ReceivedVirtualFiles ReadVirtualFiles(IDataObject* data,
                                     const std::wstring& destination_root);

#endif  // RUNNER_VIRTUAL_FILE_READER_H_
