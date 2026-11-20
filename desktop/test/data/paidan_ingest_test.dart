import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/application/order_controller.dart';
import 'package:pic_order_desktop/features/orders/application/paidan_ingest_service.dart';
import 'package:pic_order_desktop/features/orders/data/local_order_repository.dart';
import 'package:pic_order_desktop/features/orders/domain/order_document.dart';
import 'package:pic_order_desktop/features/orders/domain/order_image.dart';
import 'package:pic_order_desktop/features/templates/template_definition.dart';

/// 在 [importImage] 上加闸门，用于测试控制器忙时的投递重试语义。
class _GatedRepository extends LocalOrderRepository {
  _GatedRepository(super.root, this.gate);

  final Completer<void> gate;

  @override
  Future<OrderDocument> importImage(
    OrderDocument order,
    String sourcePath,
    ImageSource source,
  ) async {
    await gate.future;
    return super.importImage(order, sourcePath, source);
  }
}

void main() {
  late Directory root;
  late Directory inbox;
  late LocalOrderRepository repository;
  late OrderController controller;
  late PaidanIngestService service;
  final pngBytes = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  );

  setUp(() async {
    root = await Directory.systemTemp.createTemp('pic-paidan-test-');
    inbox = Directory('${root.path}/inbox');
    repository = LocalOrderRepository(Directory('${root.path}/library'));
    controller = OrderController(
      repository: repository,
      templates: <TemplateDefinition>[],
    );
    service = PaidanIngestService(controller, inbox);
    await controller.initialize();
  });

  tearDown(() async {
    await service.dispose();
    await root.delete(recursive: true);
  });

  /// 按生产方协议写一对收件箱文件（临时文件 + 原子重命名）。
  Future<File> writeSpool({
    required String spoolId,
    required String orderNumber,
    List<int>? bytes,
    String fileName = 'material.png',
    int? declaredLength,
    bool corruptMeta = false,
  }) async {
    final payload = bytes ?? pngBytes;
    final image = File('${inbox.path}/$fileName');
    await image.create(recursive: true);
    await image.writeAsBytes(payload, flush: true);
    final meta = <String, dynamic>{
      'schemaVersion': 1,
      'orderNumber': orderNumber,
      'capturedAt': '2026-11-16T00:00:00+08:00',
      'source': 'qianfan-paidan',
      'fileName': fileName,
      'byteLength': declaredLength ?? payload.length,
    };
    final metaFile = File('${inbox.path}/$spoolId.paidan.json');
    if (corruptMeta) {
      await metaFile.writeAsString('{not-json', flush: true);
      return metaFile;
    }
    final temporary = File('${metaFile.path}.tmp');
    await temporary.writeAsString(jsonEncode(meta), flush: true);
    await temporary.rename(metaFile.path);
    return metaFile;
  }

  test('投递入库：同号建单导入图片并清理收件箱', () async {
    await writeSpool(spoolId: 'a1', orderNumber: 'P810307058391032061');
    await service.ingestAll();

    final orders = await repository.listOrders();
    expect(orders, hasLength(1));
    expect(orders.single.orderNumber, 'P810307058391032061');
    expect(orders.single.images.single.source, ImageSource.paidan);
    expect(
      await File(
        repository.imagePath(orders.single.id, orders.single.images.single),
      ).readAsBytes(),
      pngBytes,
    );
    expect(await inbox.list().toList(), isEmpty);
  });

  test('同订单号两次投递复用同一订单', () async {
    await writeSpool(spoolId: 'a1', orderNumber: '610');
    await service.ingestAll();
    await writeSpool(spoolId: 'a2', orderNumber: '610', fileName: 'b.png');
    await service.ingestAll();

    final orders = await repository.listOrders();
    expect(orders, hasLength(1));
    expect(orders.single.images, hasLength(2));
    expect(await inbox.list().toList(), isEmpty);
  });

  test('控制器忙时投递保持原样等待重试，空闲后入库', () async {
    // 用门控仓储真正占用控制器，模拟用户正在导入。
    final gate = Completer<void>();
    final gatedController = OrderController(
      repository: _GatedRepository(repository.root, gate),
      templates: <TemplateDefinition>[],
    );
    await gatedController.initialize();
    final gatedService = PaidanIngestService(gatedController, inbox);

    // 第一条投递进入控制器并卡在门控 importImage 上（busy）。
    final metaA = await writeSpool(spoolId: 'a1', orderNumber: '610');
    final inFlight = gatedService.ingestFile(metaA);
    await Future<void>.delayed(const Duration(milliseconds: 20));

    // 第二条投递遇到忙控制器 → deferred，文件保持原样。
    await writeSpool(spoolId: 'a2', orderNumber: '610', fileName: 'b.png');
    await gatedService.ingestAll();
    expect(gatedController.busy, isTrue);
    final leftovers = (await inbox.list().toList()).whereType<File>().length;
    expect(leftovers, greaterThanOrEqualTo(3));

    // 释放门控后：第一条完成入库并清理，第二条经重扫入库。
    gate.complete();
    await inFlight;
    await gatedService.ingestAll();
    final orders = await repository.listOrders();
    expect(orders.single.images, hasLength(2));
    expect(await inbox.list().toList(), isEmpty);
    await gatedService.dispose();
  });

  test('损坏元数据移入 failed 目录并附错误说明', () async {
    await writeSpool(spoolId: 'bad', orderNumber: '610', corruptMeta: true);
    await service.ingestAll();

    final failed = Directory('${inbox.path}/failed');
    expect(await failed.exists(), isTrue);
    final leftovers = await failed
        .list(recursive: true)
        .where((entry) => entry is File)
        .toList();
    expect(
      leftovers.map((entry) => entry.path),
      everyElement(contains('failed')),
    );
    // 主订单目录不受污染。
    expect(await repository.listOrders(), isEmpty);
  });

  test('字节数不符移入 failed 目录，不导入缩略或截断文件', () async {
    await writeSpool(
      spoolId: 'mismatch',
      orderNumber: '610',
      declaredLength: pngBytes.length + 100,
    );
    await service.ingestAll();

    expect(await repository.listOrders(), isEmpty);
    final failed = Directory('${inbox.path}/failed');
    expect(await failed.exists(), isTrue);
  });

  test('控制器正开着同一订单时，入库后当前订单快照同步更新', () async {
    await controller.openOrCreate('610');
    await writeSpool(spoolId: 'a1', orderNumber: '610');
    await service.ingestAll();

    expect(controller.current, isNotNull);
    expect(controller.current?.images, hasLength(1));
    expect(controller.current?.images.single.source, ImageSource.paidan);
    expect(controller.selectedImage, isNotNull);
  });
}
