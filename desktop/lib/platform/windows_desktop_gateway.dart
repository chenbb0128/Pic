import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';

import '../features/templates/template_definition.dart';
import 'desktop_gateway.dart';
import 'eva_original_image_loader.dart';

class WindowsDesktopGateway implements DesktopGateway {
  WindowsDesktopGateway({required Directory diagnosticsDirectory})
    : _diagnosticsDirectory = diagnosticsDirectory,
      _originalImages = EvaOriginalImageLoader(
        Directory('${diagnosticsDirectory.parent.path}/incoming'),
      ) {
    _channel.setMethodCallHandler(_onNativeCall);
  }

  static const _channel = MethodChannel(
    'cn.xiaoxingtie/order_materials/desktop',
  );
  final _files = StreamController<List<String>>.broadcast();
  final _warnings = StreamController<String>.broadcast();
  final Directory _diagnosticsDirectory;
  Future<void> _diagnosticWrite = Future.value();
  bool _lastDiagnosticSaved = false;
  bool _disposed = false;
  final EvaOriginalImageLoader _originalImages;
  final Map<String, Uri> _imageSources = {};
  final Set<String> _virtualPaths = {};

  @override
  Stream<List<String>> get droppedFiles => _files.stream;
  @override
  Stream<String> get dropWarnings => _warnings.stream;

  Future<void> _onNativeCall(MethodCall call) async {
    if (call.method == 'filesDropped') {
      final input = call.arguments;
      final List<String> paths;
      if (input is Map<dynamic, dynamic>) {
        paths = (input['paths'] as List<dynamic>).cast<String>();
        if (input['virtualFiles'] == true) _virtualPaths.addAll(paths);
        final address = input['sourceUrl'] as String?;
        if (paths.length == 1 && address != null && address.isNotEmpty) {
          final uri = Uri.tryParse(address);
          if (uri != null) _imageSources[paths.single] = uri;
        }
      } else {
        paths = (input as List<dynamic>).cast<String>();
      }
      _files.add(paths);
    } else if (call.method == 'dropReadError') {
      _warnings.add('接收 EVA 文件失败：${call.arguments} 已接收的完整文件会保留在本机接收目录。');
    } else if (call.method == 'dragFormats') {
      _diagnosticWrite = _diagnosticWrite.then(
        (_) => _recordFormats(call.arguments),
      );
      await _diagnosticWrite;
    } else if (call.method == 'unsupportedDrop') {
      await _diagnosticWrite;
      if (!_disposed) {
        _warnings.add(
          _lastDiagnosticSaved
              ? '暂未识别这次拖入的图片，已记录格式以便适配。可先下载原图后导入。'
              : '暂未识别这次拖入的图片，且未能记录格式。可先下载原图后导入。',
        );
      }
    }
  }

  Future<void> _recordFormats(Object? arguments) async {
    _lastDiagnosticSaved = false;
    try {
      final input = arguments as Map<dynamic, dynamic>;
      final formats = (input['formats'] as List<dynamic>).take(64);
      final metadata = {
        'recordedAt': DateTime.now().toUtc().toIso8601String(),
        'formats': [
          for (final item in formats)
            {
              'id': (item as Map<dynamic, dynamic>)['id'] as int,
              'name': item['name'] as String,
              'tymed': item['tymed'] as int,
              'index': item['index'] as int,
            },
        ],
        'fileQueryResult': input['fileQueryResult'] as int,
        'enumerationResult': input['enumerationResult'] as int?,
        'allowedEffects': input['allowedEffects'] as int,
      };
      await _diagnosticsDirectory.create(recursive: true);
      await File('${_diagnosticsDirectory.path}/last_drag.json').writeAsString(
        const JsonEncoder.withIndent('  ').convert(metadata),
        flush: true,
      );
      _lastDiagnosticSaved = true;
    } on Object {
      // Diagnostic failure must not interrupt a normal file drop/import.
    }
  }

  @override
  Future<List<String>> chooseImages() async =>
      await _channel.invokeListMethod<String>('chooseImages') ?? [];

  @override
  Future<String?> chooseDirectory() =>
      _channel.invokeMethod<String>('chooseDirectory');

  @override
  Future<String?> saveImageAs(String sourcePath, String suggestedName) =>
      _channel.invokeMethod<String>('saveImageAs', {
        'sourcePath': sourcePath,
        'suggestedName': suggestedName,
      });

  @override
  Future<bool> dragFile(String sourcePath) async =>
      await _channel.invokeMethod<bool>('dragFile', sourcePath) ?? false;

  @override
  Future<void> openWebTemplate(String templateId) {
    final template = webTemplates.firstWhere(
      (item) => item.matches(templateId),
    );
    return _channel.invokeMethod<void>('openWebTemplate', template.webUrl);
  }

  @override
  Future<List<String>> prepareDroppedFiles(List<String> paths) async {
    final evaPaths = paths.where(
      (path) =>
          _virtualPaths.contains(path) &&
          RegExp(
            r'^1040[a-zA-Z0-9]+\.[a-zA-Z0-9]+$',
          ).hasMatch(File(path).uri.pathSegments.last),
    );
    if (evaPaths.isNotEmpty &&
        (paths.length != 1 || !_imageSources.containsKey(paths.single))) {
      throw const FormatException('未能取得 EVA 原图地址，未导入缩略图。请逐张拖入，或导入已下载的原图。');
    }
    if (paths.length != 1) return paths;
    final source = _imageSources[paths.single];
    final file = await _originalImages.prepare(paths.single, source);
    if (file == null && evaPaths.isNotEmpty) {
      throw const FormatException('当前图片地址尚未支持获取原图，未导入缩略图。');
    }
    return file == null ? paths : [file.path];
  }

  @override
  Future<void> releaseDroppedFiles(List<String> paths) async {
    await _channel.invokeMethod<void>('releaseDroppedFiles', paths);
    await _originalImages.release(paths);
    for (final path in paths) {
      _imageSources.remove(path);
      _virtualPaths.remove(path);
    }
  }

  @override
  Future<void> setAlwaysOnTop(bool enabled) =>
      _channel.invokeMethod<void>('setAlwaysOnTop', enabled);

  @override
  Future<void> dispose() async {
    _channel.setMethodCallHandler(null);
    _disposed = true;
    await _diagnosticWrite;
    await _files.close();
    await _warnings.close();
  }
}
