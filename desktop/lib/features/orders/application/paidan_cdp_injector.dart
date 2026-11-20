import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'order_controller.dart';
import 'paidan_ingest_service.dart' show PaidanIngestEvent, PaidanIngestStatus;

/// 千帆客服工作台 CDP 注入器。
///
/// 订单素材台自身通过 `http://127.0.0.1:<port>/json/list` 发现工作台页面，
/// WebSocket 连入后注入 `assets/paidan_core.js`（右键「进入排单」菜单 + 抓图），
/// 捕获结果经 `qianfanBridge` binding 回流，直接按订单号入库 —— 无需 Node 注入器
/// 与收件箱文件中转。
///
/// 生命周期：`start()` 后周期扫描，自动接入新开账号 tab；千帆重启后自动重连。
/// 控制器忙时捕获在内存中排队重试；无订单号或导入失败时临时文件保留在
/// `incoming/` 供人工处理。
class PaidanCdpInjector {
  PaidanCdpInjector(
    this._controller, {
    required this.coreScript,
    required this.incomingDirectory,
    this.port = 9222,
    this.scanInterval = const Duration(seconds: 3),
  });

  final OrderController _controller;
  final String coreScript;
  final Directory incomingDirectory;
  final int port;
  final Duration scanInterval;

  final _events = StreamController<PaidanIngestEvent>.broadcast();
  final Map<String, _CdpConnection> _connections = {};
  final Map<String, int> _failedAt = {};
  final List<StreamSubscription<Map<String, dynamic>>> _subscriptions = [];
  HttpClient? _httpClient;
  Timer? _scanTimer;
  Future<void> _scanning = Future.value();
  bool _disposed = false;

  /// 入库结果通知。
  Stream<PaidanIngestEvent> get events => _events.stream;

  static const _bindingName = 'qianfanBridge';
  static const _maxImageBytes = 512 * 1024 * 1024;
  static const _attachRetryBackoff = Duration(seconds: 30);
  static const _busyRetryAttempts = 10;
  static const _busyRetryDelay = Duration(seconds: 2);
  static const _busyWaitBeforeRetry = Duration(milliseconds: 20);

  void start() {
    _scheduleScan();
    _scanTimer = Timer.periodic(scanInterval, (_) => _scheduleScan());
  }

  Future<void> dispose() async {
    _disposed = true;
    _scanTimer?.cancel();
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    _subscriptions.clear();
    for (final connection in _connections.values) {
      await connection.close();
    }
    _connections.clear();
    _httpClient?.close(force: true);
    await _events.close();
  }

  void _emit(PaidanIngestEvent event) {
    if (!_events.isClosed) _events.add(event);
  }

  void _scheduleScan() {
    if (_disposed) return;
    _scanning = _scanning.whenComplete(() async {
      if (_disposed) return;
      try {
        await _scan();
      } on Object {
        // 千帆未启动 / 端口未就绪等由下轮扫描重试。
      }
    });
  }

  Future<void> _scan() async {
    final targets = await _listTargets();
    final alive = <String>{};
    for (final target in targets) {
      final id = target['id'] as String?;
      if (id == null) continue;
      alive.add(id);
      if (_connections.containsKey(id)) continue;
      final failed = _failedAt[id];
      if (failed != null &&
          DateTime.now().millisecondsSinceEpoch - failed <
              _attachRetryBackoff.inMilliseconds) {
        continue;
      }
      try {
        await _attach(target);
        _failedAt.remove(id);
        debugPrint('[paidan-cdp] 已接入: ${target['title']}');
      } on Object catch (error) {
        _failedAt[id] = DateTime.now().millisecondsSinceEpoch;
        debugPrint('[paidan-cdp] attach 失败: $error');
      }
    }
    // 断开的连接移除；目标已消失的同样清理。
    final dead = _connections.keys.where((id) => !alive.contains(id)).toList();
    for (final id in dead) {
      final connection = _connections.remove(id);
      await connection?.close();
    }
  }

  Future<List<Map<String, dynamic>>> _listTargets() async {
    final client = _httpClient ??= HttpClient()
      ..connectionTimeout = const Duration(seconds: 2);
    final request = await client
        .getUrl(Uri.parse('http://127.0.0.1:$port/json/list'))
        .timeout(const Duration(seconds: 5));
    final response = await request.close().timeout(const Duration(seconds: 5));
    if (response.statusCode != HttpStatus.ok) {
      throw HttpException('json/list 返回 ${response.statusCode}');
    }
    final body = await response.transform(utf8.decoder).join();
    final decoded = jsonDecode(body) as List<dynamic>;
    return [
      for (final item in decoded)
        if (item is Map<String, dynamic> &&
            item['type'] == 'page' &&
            (item['url'] as String? ?? '').contains('xiaohongshu.com') &&
            !((item['url'] as String).contains('cstools/login')) &&
            !((item['url'] as String).contains('devtools')))
          item,
    ];
  }

  Future<void> _attach(Map<String, dynamic> target) async {
    final address = target['webSocketDebuggerUrl'] as String?;
    if (address == null || address.isEmpty)
      throw const FormatException('target 缺少调试地址');
    final socket = await WebSocket.connect(
      address,
    ).timeout(const Duration(seconds: 10));
    final id = target['id'] as String;
    final connection = _CdpConnection(
      socket,
      onClosed: () => _connections.remove(id),
    );
    _connections[id] = connection;

    // 先挂事件监听再发请求，避免 bindingCalled 在请求间隙丢失。
    final subscription = connection.events.listen((message) {
      unawaited(_onCdpEvent(id, message));
    });
    _subscriptions.add(subscription);

    await connection.request('Runtime.enable');
    await connection.request('Page.enable');
    await connection.request('Runtime.addBinding', {'name': _bindingName});
    await connection.request('Page.addScriptToEvaluateOnNewDocument', {
      'source': coreScript,
    });
    await connection.request('Runtime.evaluate', {
      'expression': coreScript,
      'returnByValue': true,
    });
  }

  Future<void> _onCdpEvent(
    String targetId,
    Map<String, dynamic> message,
  ) async {
    if (_disposed) return;
    if (message['method'] != 'Runtime.bindingCalled') return;
    final params = message['params'] as Map<String, dynamic>?;
    if (params == null || params['name'] != _bindingName) return;
    final Map<String, dynamic> payload;
    try {
      payload = jsonDecode(params['payload'] as String) as Map<String, dynamic>;
    } on Object {
      debugPrint('[paidan-cdp] payload 解析失败');
      return;
    }
    if (payload['type'] != 'paidan.capture' || payload['b64'] is! String)
      return;
    final context = payload['context'] as Map<String, dynamic>?;
    final orderNumber = (context?['orderNo'] as String?)?.trim() ?? '';
    if (orderNumber.isEmpty) {
      debugPrint('[paidan-cdp] 未识别到订单号，跳过入库');
      return;
    }
    final bytes = base64Decode(payload['b64'] as String);
    if (bytes.isEmpty || bytes.length > _maxImageBytes) {
      debugPrint('[paidan-cdp] 图片字节越界：${bytes.length}');
      return;
    }
    const mimes = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };
    final mime = payload['mime'] as String?;
    final extension = mimes[mime] ?? 'png';
    await incomingDirectory.create(recursive: true);
    final file = File(
      '${incomingDirectory.path}/'
      'paidan-${DateTime.now().millisecondsSinceEpoch}-'
      '${_randomHex(6)}.$extension',
    );
    await file.writeAsBytes(bytes, flush: true);

    final scaled = payload['scaled'] == true;
    // 控制器忙（用户正在拖入/切单）时按固定节奏重试。
    for (var attempt = 0; attempt < _busyRetryAttempts; attempt++) {
      final failure = await _controller.ingestPaidan(
        orderNumber: orderNumber,
        sourcePath: file.path,
      );
      if (failure == null) {
        await file.delete();
        _emit(
          PaidanIngestEvent(
            PaidanIngestStatus.imported,
            orderNumber,
            scaled ? '缩图（原图拉取失败）' : null,
          ),
        );
        return;
      }
      if (failure != 'busy') {
        debugPrint('[paidan-cdp] 入库失败：$failure（文件保留在 incoming/）');
        _emit(
          PaidanIngestEvent(PaidanIngestStatus.failed, orderNumber, '$failure'),
        );
        return;
      }
      await Future<void>.delayed(
        attempt == 0 ? _busyWaitBeforeRetry : _busyRetryDelay,
      );
    }
    debugPrint('[paidan-cdp] 控制器持续忙碌，图片保留在 incoming/ 等待人工处理');
    _emit(
      PaidanIngestEvent(
        PaidanIngestStatus.failed,
        orderNumber,
        '控制器持续忙碌，图片保留在 incoming/',
      ),
    );
  }

  String _randomHex(int bytes) {
    final random = DateTime.now().microsecondsSinceEpoch;
    return random
        .toRadixString(16)
        .padLeft(bytes * 2, '0')
        .substring(0, bytes * 2);
  }
}

/// 工作台图片暂存（入库失败时保留现场）。
/// 工作台 CDP 连接：请求/响应配对 + 事件流。
class _CdpConnection {
  _CdpConnection(WebSocket this.socket, {required VoidCallback onClosed}) {
    socket.listen(
      _onMessage,
      onDone: () {
        _events.close();
        onClosed();
      },
      onError: (Object _) {
        _events.close();
        onClosed();
      },
      cancelOnError: true,
    );
  }

  final WebSocket socket;
  int _seq = 0;
  final Map<int, Completer<Map<String, dynamic>>> _pending = {};
  final _events = StreamController<Map<String, dynamic>>.broadcast();

  /// CDP 事件流（不含本连接发出的请求响应）。
  Stream<Map<String, dynamic>> get events => _events.stream;

  Future<Map<String, dynamic>> request(
    String method, [
    Map<String, dynamic>? params,
  ]) {
    final completer = Completer<Map<String, dynamic>>();
    final id = ++_seq;
    _pending[id] = completer;
    socket.add(
      jsonEncode({'id': id, 'method': method, 'params': params ?? {}}),
    );
    return completer.future.timeout(const Duration(seconds: 10));
  }

  Future<void> close() async {
    await _events.close();
    await socket.close();
  }

  void _onMessage(dynamic data) {
    if (data is! String) return;
    final Map<String, dynamic> message;
    try {
      message = jsonDecode(data) as Map<String, dynamic>;
    } on Object {
      return;
    }
    final id = message['id'];
    if (id is int) {
      final completer = _pending.remove(id);
      if (completer != null) {
        final error = message['error'];
        if (error != null) {
          completer.completeError(Exception('$error'));
        } else {
          completer.complete(
            (message['result'] as Map<String, dynamic>?) ?? <String, dynamic>{},
          );
        }
      }
      return;
    }
    if (message['method'] is String) _events.add(message);
  }
}
