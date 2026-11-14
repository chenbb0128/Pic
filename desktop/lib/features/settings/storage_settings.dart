import 'dart:convert';
import 'dart:io';

/// The archive day follows Beijing time, including while the app stays open.
String storageDate(DateTime time) {
  final day = time.toUtc().add(const Duration(hours: 8));
  return '${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';
}

class StorageSettings {
  StorageSettings(this.dataDirectory)
    : _imageRoot = Directory('${dataDirectory.path}/images');

  final Directory dataDirectory;
  Directory _imageRoot;
  String? loadError;

  String get imageRootPath => _imageRoot.path;
  String get configPath => '${dataDirectory.path}/settings.json';

  Directory get imageRoot {
    if (loadError != null) {
      throw StateError('保存目录设置无法读取，请在「保存设置」中重新选择并保存目录。');
    }
    return _imageRoot;
  }

  Future<void> load() async {
    final file = File(configPath);
    final backup = File('$configPath.bak');
    try {
      if (await file.exists()) {
        try {
          _imageRoot = await _read(file);
        } on Object {
          if (!await backup.exists()) rethrow;
          _imageRoot = await _read(backup);
        }
      } else if (await backup.exists()) {
        _imageRoot = await _read(backup);
      }
      loadError = null;
    } on Object catch (error) {
      loadError = '保存目录设置无法读取，请重新选择并保存目录：$error';
    }
  }

  Future<Directory> _read(File file) async {
    final value = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    if (value['schemaVersion'] != 1) {
      throw const FormatException('保存设置版本无效');
    }
    return _directory(value['imageRoot'] as String);
  }

  Directory _directory(String path) {
    final directory = Directory(path.trim());
    if (path.trim().isEmpty ||
        path.contains('\u0000') ||
        !directory.isAbsolute) {
      throw const FormatException('请选择有效的绝对目录');
    }
    return directory.absolute;
  }

  Future<void> saveImageRoot(String path) async {
    final directory = _directory(path);
    await directory.create(recursive: true);
    // Fail at configuration time if the selected folder cannot accept files.
    final probe = File(
      '${directory.path}/.order-materials-$pid-${DateTime.now().microsecondsSinceEpoch}.tmp',
    );
    await probe.writeAsString('', flush: true);
    await probe.delete();
    await dataDirectory.create(recursive: true);
    final file = File(configPath);
    final temporary = File('$configPath.tmp');
    final backup = File('$configPath.bak');
    await temporary.writeAsString(
      const JsonEncoder.withIndent(
        '  ',
      ).convert({'schemaVersion': 1, 'imageRoot': directory.path}),
      flush: true,
    );
    if (await file.exists()) {
      // Preserve the last readable settings when recovering a broken primary.
      var readable = false;
      try {
        await _read(file);
        readable = true;
      } on Object {
        // The new explicit setting repairs this file.
      }
      if (readable) {
        if (await backup.exists()) await backup.delete();
        await file.rename(backup.path);
      } else {
        await file.rename(
          '$configPath.corrupt-${DateTime.now().microsecondsSinceEpoch}',
        );
      }
    }
    await temporary.rename(file.path);
    _imageRoot = directory;
    loadError = null;
  }
}
