import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pic_order_desktop/features/orders/application/order_controller.dart';
import 'package:pic_order_desktop/features/orders/data/local_order_repository.dart';
import 'package:pic_order_desktop/features/orders/domain/order_document.dart';
import 'package:pic_order_desktop/features/orders/domain/order_image.dart';
import 'package:pic_order_desktop/features/templates/template_definition.dart';

class FailingSaveRepository extends LocalOrderRepository {
  FailingSaveRepository(super.root);
  bool failWrites = false;
  Completer<void>? gate;

  @override
  Future<void> save(OrderDocument order) async {
    if (gate != null) await gate!.future;
    if (failWrites) throw const FileSystemException('disk full');
    await super.save(order);
  }
}

void main() {
  late Directory temporary;
  late FailingSaveRepository repository;
  late OrderController controller;

  setUp(() async {
    temporary = await Directory.systemTemp.createTemp('pic-controller-');
    repository = FailingSaveRepository(Directory('${temporary.path}/library'));
    controller = OrderController(
      repository: repository,
      templates: initialTemplates,
    );
    await controller.initialize();
    await controller.openOrCreate('610');
    final image = await File('${temporary.path}/a.png').writeAsBytes(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
    );
    await controller.importPaths([image.path], ImageSource.localFile);
  });
  tearDown(() async {
    controller.dispose();
    await temporary.delete(recursive: true);
  });

  test('保存失败保留原关联并显示错误，重试成功后才更新', () async {
    repository.failWrites = true;
    expect(await controller.setTemplate('A03', true), isFalse);
    expect(controller.selectedImage!.templateIds, isEmpty);
    expect(controller.error, contains('disk full'));
    repository.failWrites = false;
    expect(await controller.setTemplate('A03', true), isTrue);
    expect(controller.selectedImage!.templateIds, {'模板混合.png'});
    expect(controller.error, isNull);
  });

  test('写入中拒绝切单，避免把当前图片分配到另一订单', () async {
    repository.gate = Completer<void>();
    final saving = controller.setTemplate('A03', true);
    expect(controller.busy, isTrue);
    expect(await controller.openOrCreate('other'), isFalse);
    expect(controller.current!.orderNumber, '610');
    repository.gate!.complete();
    await saving;
    expect((await repository.listOrders()), hasLength(1));
  });

  test('没有订单时拖入图片明确拒绝，不丢入其他订单', () async {
    final empty = OrderController(
      repository: repository,
      templates: initialTemplates,
    );
    addTearDown(empty.dispose);
    expect(
      await empty.importPaths(['anything.png'], ImageSource.desktopDrop),
      isFalse,
    );
    expect(empty.error, contains('订单'));
  });

  test('删除保留旧版原图且不影响其他订单，失败时保持当前订单', () async {
    final currentId = controller.current!.id;
    final legacy = await repository.create('旧订单');
    final bytes = await File(
      controller.imagePath(controller.selectedImage!),
    ).readAsBytes();
    final original = File(
      '${repository.root.path}/orders/${legacy.id}/originals/legacy.png',
    );
    await original.parent.create(recursive: true);
    await original.writeAsBytes(bytes);
    await repository.save(
      legacy.addImage(
        OrderImage(
          id: 'legacy',
          originalName: 'legacy.png',
          storedName: 'legacy.png',
          byteLength: bytes.length,
          source: ImageSource.localFile,
        ),
      ),
    );
    await controller.initialize();
    expect(await controller.deleteOrder(legacy.id), isTrue);
    expect(controller.current!.id, currentId);
    expect(controller.orders.map((order) => order.id), [currentId]);
    final archived = (await Directory(
      '${repository.root.path}/trash',
    ).list().toList()).single;
    expect(
      await File('${archived.path}/originals/legacy.png').readAsBytes(),
      bytes,
    );
    expect(await File('${archived.path}/order.json').exists(), isTrue);

    // An unavailable recycle directory must not remove the remaining order.
    // Move only this test's archive outside the path used for the next operation.
    await Directory(
      '${repository.root.path}/trash',
    ).rename('${temporary.path}/saved-trash');
    await File('${repository.root.path}/trash').writeAsString('blocked');
    expect(await controller.deleteOrder(currentId), isFalse);
    expect(controller.current!.id, currentId);
    expect(controller.selectedImage, isNotNull);
    expect(controller.orders.single.id, currentId);
    expect((await repository.load(currentId)).images, hasLength(1));
    await expectLater(repository.delete('../outside'), throwsArgumentError);
  });
}
