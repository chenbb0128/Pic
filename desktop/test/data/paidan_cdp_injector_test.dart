import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/application/order_controller.dart';
import 'package:pic_order_desktop/features/orders/application/paidan_cdp_injector.dart';
import 'package:pic_order_desktop/features/orders/data/local_order_repository.dart';
import 'package:pic_order_desktop/features/orders/domain/order_image.dart';
import 'package:pic_order_desktop/features/templates/template_definition.dart';

/// 模拟千帆 CDP 端点：/json/list 返回一个目标；
/// WebSocket 收到 Runtime.addBinding 后推送一条 bindingCalled 捕获。
class _FakeCdpServer {
  _FakeCdpServer(this.capturePayload);

  final String capturePayload;
  HttpServer? _server;
  final Map<String, String> requests = {};

  Future<int> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server = server;
    server.listen((request) async {
      if (request.uri.path == '/json/list') {
        final targets = jsonEncode([
          {
            'id': 't1',
            'type': 'page',
            'title': '颜-工作台',
            'url': 'https://walle.xiaohongshu.com/cstools/seller/dashboard',
            'webSocketDebuggerUrl': 'ws://127.0.0.1:${server.port}/devtools/t1',
          },
        ]);
        request.response.headers.contentType = ContentType.json;
        request.response.write(targets);
        await request.response.close();
        return;
      }
      if (WebSocketTransformer.isUpgradeRequest(request)) {
        final socket = await WebSocketTransformer.upgrade(request);
        socket.listen((data) async {
          final message = jsonDecode(data as String) as Map<String, dynamic>;
          final method = message['method'] as String?;
          if (method != null) requests[method] = jsonEncode(message['params']);
          final id = message['id'] as int?;
          if (id != null) {
            socket.add(jsonEncode({'id': id, 'result': <String, dynamic>{}}));
          }
          if (method == 'Runtime.addBinding') {
            socket.add(
              jsonEncode({
                'method': 'Runtime.bindingCalled',
                'params': {'name': 'qianfanBridge', 'payload': capturePayload},
              }),
            );
          }
        });
      }
    });
    return server.port;
  }

  Future<void> stop() async => _server?.close(force: true);
}

void main() {
  late Directory root;
  late Directory incoming;
  late LocalOrderRepository repository;
  late OrderController controller;
  final pngBytes = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  );

  setUp(() async {
    root = await Directory.systemTemp.createTemp('pic-cdp-test-');
    incoming = Directory('${root.path}/incoming');
    repository = LocalOrderRepository(Directory('${root.path}/library'));
    controller = OrderController(
      repository: repository,
      templates: <TemplateDefinition>[],
    );
    await controller.initialize();
  });

  tearDown(() async {
    controller.dispose();
    await root.delete(recursive: true);
  });

  String capturePayload({String? orderNo}) => jsonEncode({
    'type': 'paidan.capture',
    'mime': 'image/png',
    'b64': base64Encode(pngBytes),
    'scaled': false,
    'ts': 1,
    'context': {'orderNo': orderNo},
  });

  Future<void> waitFor(bool Function() condition) async {
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (!condition() && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    expect(condition(), isTrue, reason: '等待条件超时');
  }

  test('捕获经 binding 回流后按订单号入库并清理临时文件', () async {
    final server = _FakeCdpServer(capturePayload(orderNo: '610'));
    final port = await server.start();
    final injector = PaidanCdpInjector(
      controller,
      coreScript: 'window.__paidanCoreTest = true;',
      incomingDirectory: incoming,
      port: port,
      scanInterval: const Duration(milliseconds: 100),
    );
    injector.start();

    // 等待捕获入库（订单列表出现带图片的订单）。
    await waitFor(
      () => controller.orders.any((order) => order.images.isNotEmpty),
    );

    final orders = await repository.listOrders();
    expect(orders.single.orderNumber, '610');
    expect(orders.single.images.single.source, ImageSource.paidan);
    expect(
      await File(
        repository.imagePath(orders.single.id, orders.single.images.single),
      ).readAsBytes(),
      pngBytes,
    );
    // 注入协议完整：脚本已注册、binding 已添加。
    expect(
      server.requests.containsKey('Page.addScriptToEvaluateOnNewDocument'),
      isTrue,
    );
    expect(server.requests['Runtime.addBinding'], contains('qianfanBridge'));
    // 成功后临时文件已清理。
    expect(incoming.listSync().whereType<File>(), isEmpty);

    await injector.dispose();
    await server.stop();
  });

  test('未识别订单号时跳过入库，不产生订单与临时文件', () async {
    final server = _FakeCdpServer(capturePayload());
    final port = await server.start();
    final injector = PaidanCdpInjector(
      controller,
      coreScript: 'window.__paidanCoreTest = true;',
      incomingDirectory: incoming,
      port: port,
      scanInterval: const Duration(milliseconds: 100),
    );
    injector.start();

    // 等待协议流程走完（binding 已添加），随后确认未入库。
    await waitFor(() => server.requests.containsKey('Runtime.addBinding'));
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(await repository.listOrders(), isEmpty);
    expect(incoming.existsSync(), isFalse);

    await injector.dispose();
    await server.stop();
  });
}
