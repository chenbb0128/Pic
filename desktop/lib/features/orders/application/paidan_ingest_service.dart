import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'order_controller.dart';

/// 排单收件箱处理结果。
enum PaidanIngestStatus { imported, deferred, failed }

class PaidanIngestEvent {
  PaidanIngestEvent(this.status, this.orderNumber, [this.detail]);

  final PaidanIngestStatus status;
  final String orderNumber;
  final String? detail;
}

/// 消费排单小助手（千帆客服侧）投递到收件箱的成对文件：
/// `<投递ID>.paidan.json`（元数据）+ 同前缀图片文件。
/// 生产方以「写临时文件后原子重命名」落盘，本服务只处理完整成对的文件。
///
/// 收件箱在应用未运行时由生产方继续投递，文件保留到下次启动扫描，不丢消息。
/// 成功后删除收件箱文件；控制器忙时保持原样由定时扫描重试；
/// 处理失败移入 `inbox/failed/` 附错误说明，供人工检查。
class PaidanIngestService {
  PaidanIngestService(this._controller, this._inbox);

  final OrderController _controller;
  final Directory _inbox;
  final _events = StreamController<PaidanIngestEvent>.broadcast();
  StreamSubscription<FileSystemEvent>? _subscription;
  Timer? _scanTimer;
  Future<void> _scanning = Future.value();
  bool _disposed = false;

  /// 入库结果通知；`deferred` 不提示，仅用于诊断。
  Stream<PaidanIngestEvent> get events => _events.stream;

  static const _schemaVersion = 1;
  static const _maxImageBytes = 512 * 1024 * 1024;
  static const _scanInterval = Duration(seconds: 5);
  static final _safeFileName = RegExp(r'^[a-zA-Z0-9._-]+$');

  /// 启动：先扫描启动前遗留的投递，再监听新文件；监听失败退化为定时扫描。
  void start() {
    unawaited(ingestAll());
    try {
      _inbox.createSync(recursive: true);
      _subscription = _inbox
          .watch(events: FileSystemEvent.create | FileSystemEvent.modify)
          .listen(
            (_) => _scheduleScan(),
            onError: (Object _) => _scheduleScan(),
            cancelOnError: false,
          );
    } on Object {
      // Windows 目录监听不可用时仍可靠定时扫描兜底。
    }
    _scanTimer = Timer.periodic(_scanInterval, (_) => _scheduleScan());
  }

  Future<void> dispose() async {
    _disposed = true;
    await _subscription?.cancel();
    _scanTimer?.cancel();
    await _events.close();
  }

  void _scheduleScan() {
    if (_disposed) return;
    _scanning = _scanning.whenComplete(() async {
      if (_disposed) return;
      try {
        await ingestAll();
      } on Object {
        // 单个文件失败已在 ingestFile 内归类；扫描本身不抛出。
      }
    });
  }

  /// 扫描并处理当前收件箱内的全部成对投递。
  Future<void> ingestAll() async {
    if (_disposed || !await _inbox.exists()) return;
    for (final file in await _metaFiles()) {
      await ingestFile(file);
    }
  }

  Future<List<File>> _metaFiles() async {
    final entries = await _inbox.list().toList();
    return entries
        .whereType<File>()
        .where((entry) => entry.path.endsWith('.paidan.json'))
        .toList();
  }

  void _emit(PaidanIngestEvent event) {
    if (!_events.isClosed) _events.add(event);
  }

  /// 处理单个投递。异步完成，不抛出；结果经 [events] 通知。
  Future<void> ingestFile(File metaFile) async {
    if (_disposed) return;
    final fallbackNumber = metaFile.uri.pathSegments.last.replaceAll(
      RegExp(r'\.paidan\.json$'),
      '',
    );
    var orderNumber = fallbackNumber;
    String? imageFileName;
    try {
      final Map<String, dynamic> meta;
      try {
        meta =
            jsonDecode(await metaFile.readAsString()) as Map<String, dynamic>;
      } on FormatException catch (error) {
        throw '元数据不是有效 JSON：$error';
      }
      if (meta['schemaVersion'] != _schemaVersion) {
        throw '元数据 schemaVersion 不支持：${meta['schemaVersion']}';
      }
      final number = (meta['orderNumber'] as String?)?.trim() ?? '';
      if (number.isEmpty) throw '元数据缺少订单号';
      orderNumber = number;
      final fileName = meta['fileName'] as String?;
      if (fileName == null ||
          !_safeFileName.hasMatch(fileName) ||
          fileName.contains('..')) {
        throw '元数据图片文件名无效：$fileName';
      }
      imageFileName = fileName;
      final imageFile = File('${_inbox.path}/$fileName');
      if (!await imageFile.exists()) throw '图片文件缺失：$fileName';
      final length = await imageFile.length();
      if (length == 0 || length > _maxImageBytes) throw '图片大小越界：$length';
      final declared = meta['byteLength'];
      if (declared is int && declared != length) {
        throw '图片字节数与元数据不符（声明 $declared，实际 $length）';
      }

      final failure = await _controller.ingestPaidan(
        orderNumber: number,
        sourcePath: imageFile.path,
      );
      if (failure == 'busy') {
        _emit(PaidanIngestEvent(PaidanIngestStatus.deferred, number));
        return; // 保持原样，等待下次扫描重试。
      }
      if (failure != null) throw '导入失败：$failure';
      // 导入成功后资料库已复制原图，删除收件箱文件。
      await imageFile.delete();
      await metaFile.delete();
      _emit(PaidanIngestEvent(PaidanIngestStatus.imported, number));
    } on Object catch (error) {
      final moved = await _moveToFailed(
        metaFile,
        orderNumber,
        imageFileName,
        '$error',
      );
      _emit(
        PaidanIngestEvent(
          PaidanIngestStatus.failed,
          orderNumber,
          moved ? '$error' : '$error（移入失败目录失败）',
        ),
      );
    }
  }

  /// 失败投递连同图片移入 `inbox/failed/`，保留现场供人工处理。
  Future<bool> _moveToFailed(
    File metaFile,
    String orderNumber,
    String? imageFileName,
    String error,
  ) async {
    try {
      final failed = Directory('${_inbox.path}/failed');
      await failed.create(recursive: true);
      final stamp = DateTime.now().millisecondsSinceEpoch;
      final safeNumber = orderNumber.replaceAll(RegExp(r'[^a-zA-Z0-9_-]'), '_');
      final metaTarget = File(
        '${failed.path}/${stamp}_${safeNumber}_error.paidan.json',
      );
      await metaFile.rename(metaTarget.path);
      if (imageFileName != null) {
        final image = File('${_inbox.path}/$imageFileName');
        if (await image.exists()) {
          await image.rename(
            '${failed.path}/${stamp}_${safeNumber}_$imageFileName',
          );
        }
      }
      await File(
        '${failed.path}/${stamp}_${safeNumber}_error.txt',
      ).writeAsString('$error\n', flush: true);
      return true;
    } on Object {
      // 移动失败时保留原文件，下次扫描会再次尝试归类。
      return false;
    }
  }
}
